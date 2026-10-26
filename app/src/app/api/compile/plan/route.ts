/**
 * POST /api/compile/plan
 *
 * Part 2c-i — Step 4: Build Page Plan.
 *
 * Pure logic, no LLM. Takes canonical_entities from the resolve step and
 * builds a PlannedPage list covering all page types needed for this session:
 *   1. Source summaries — one per session source, always 'create'
 *   2. Entity pages — from canonical entity list
 *   3. Concept pages — from canonical_concepts (resolved cross-session)
 *   4. Comparison pages — pairs of subjects (entity or concept) that sources
 *      say compete with or contradict each other
 *   5. Overview pages — when an entity type with a category has 3+ entity pages
 *
 * All planned pages are inserted into the page_plans table for the draft
 * and commit steps to consume.
 *
 * Request:  { session_id: string; canonical_entities: ResolvedGroup[] }
 * Response: { session_id, pages: PlannedPage[], stats }
 */

import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';

import {
  clearStagedPagePlans,
  countSourcesMentioning,
  getComparisonSourceIds,
  getDb,
  getEntityPromotionThreshold,
  getMentionKinds,
  getMinSourceChars,
  getPage,
  getSessionComparisonPairs,
  getSourceIdsMentioning,
  getSourcePage,
  getTopicPageByTitle,
  hasPendingCreate,
  insertPagePlan,
  readRawMarkdown,
  type PageRow,
} from '../../../../lib/db';
import { recordTriageContradiction } from '../../../../lib/compile/triage-disagreement';
import { countKinds, decidePageKind, isPageKind, sourceKinds, type PageKind } from '../../../../lib/page-kind';

// ── Types ────────────────────────────────────────────────────────────────────

interface ResolvedGroup {
  canonical: string;
  type: string;
  aliases: string[];
  source_ids: string[];
  method: string;
}

// Kept identical to ResolvedGroup. Tagged alias for call-site clarity —
// canonical_concepts are entity type CONCEPT plus anything the resolver
// partitioned as a concept.
type ResolvedConceptGroup = ResolvedGroup;

export interface PlannedPage {
  plan_id: string;
  title: string;
  page_type: 'source-summary' | 'original-source' | 'entity' | 'concept' | 'comparison' | 'overview';
  action: 'create' | 'update' | 'provenance-only';
  source_ids: string[];
  existing_page_id?: string;
  related_plan_ids: string[];
}

// ── Comparison page threshold ────────────────────────────────────────────────
// A comparison page is only created when a specific rivalry appears in this
// many distinct sources (competes_with and contradicts together). One
// article saying "X competes with Y" is just that article's opinion — three
// sources noting the same rivalry is a pattern worth synthesising into its
// own page.
// Deliberately NOT user-tunable — this is the load-bearing evidence signal,
// not a noise knob.
export const COMPARISON_SOURCE_THRESHOLD = 3;

// ── Entity type → overview category ──────────────────────────────────────────
// Null for a type with no category (WORK_OF_ART, OTHER, ...): Rule 5 makes
// no overview for it. A catch-all "General Overview" next to the
// fine-grained ones defeats the grouping.

export function entityTypeToCategory(entityType: string): string | null {
  const t = entityType.toUpperCase();
  if (t === 'PERSON') return 'People';
  if (t === 'ORG') return 'Organizations';
  if (t === 'PRODUCT') return 'Products';
  if (t === 'LOCATION') return 'Locations';
  if (t === 'EVENT') return 'Events';
  if (t === 'CONCEPT') return 'Concepts';
  return null;
}

// ── Triage updates keep the page's own type ──────────────────────────────────
// Commit writes the plan's page_type onto the page. A Rule 6 triage update
// carries no kind of its own, so it keeps the page's type; typing it 'entity'
// turned "WCAG 2.1" from a concept into an entity (2026-10-17, session
// e55c740b). Rules 2 and 3 decide entity vs concept by majority
// (lib/page-kind.ts). Summary pages keep Rule 1's own type logic.
const SELF_TYPED_PAGES = new Set<string>(['entity', 'concept', 'comparison', 'overview']);

// The pages Rules 2-5 update by title (db.ts getTopicPageByTitle).
const TOPIC_PAGE_TYPES = ['entity', 'concept', 'comparison', 'overview'] as const;

/**
 * A page held after a failed rewrite (lib/page-hold.ts) may still hold a
 * deleted source's material, and an update keeps a page's text. It keeps its
 * title and is left alone (neither updated nor made again) until a rewrite
 * from its sources brings it back (Settings > Wiki health).
 */
function isHeld(page: PageRow | null): boolean {
  return page?.page_type === 'archived';
}

function updatePageType(
  existing: { page_type: string } | null,
  planned: PlannedPage['page_type'],
): PlannedPage['page_type'] {
  return existing && SELF_TYPED_PAGES.has(existing.page_type)
    ? (existing.page_type as PlannedPage['page_type'])
    : planned;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const body = rawBody as Record<string, unknown>;
  const { session_id } = body as {
    session_id?: string;
    canonical_entities?: ResolvedGroup[];
    canonical_concepts?: ResolvedConceptGroup[];
  };

  if (typeof session_id !== 'string' || !session_id.trim()) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }
  if (!Array.isArray(body.canonical_entities)) {
    return NextResponse.json({ error: 'canonical_entities must be an array' }, { status: 422 });
  }

  try {
  const canonicalEntities = body.canonical_entities as ResolvedGroup[];
  // canonical_concepts is new in schema v21 resolver output. Tolerate missing
  // (default []) so a legacy caller / test stub still plans cleanly; Rule 3
  // then emits no concept pages rather than a 422.
  const canonicalConcepts = Array.isArray(body.canonical_concepts)
    ? (body.canonical_concepts as ResolvedConceptGroup[])
    : [];
  const matches = Array.isArray(body.matches)
    ? (body.matches as Array<{
        source_id: string;
        page_id: string;
        page_title: string;
        decision: string;
        reason: string;
      }>)
    : [];
  const db = getDb();

  // Get session sources — title/url/type/date are needed by Rule 6's contradiction
  // activity payload, so grab them all in one query rather than re-hitting `sources`
  // per match below.
  const sessionSources = db
    .prepare(
      `SELECT source_id, title, source_url, source_type, date_ingested, onboarding_session_id
         FROM sources
        WHERE onboarding_session_id = ?
          AND compile_status IN ('pending', 'extracted', 'in_progress')`
    )
    .all(session_id) as Array<{
      source_id: string;
      title: string;
      source_url: string | null;
      source_type: string;
      date_ingested: string;
    }>;

  if (sessionSources.length === 0) {
    return NextResponse.json(
      { error: 'no_sources', detail: 'No confirmed sources found for this session.' },
      { status: 400 }
    );
  }

  // Clear any stale page_plans from a prior failed run before rebuilding.
  // Makes this step idempotent on retry — draft step only sees plans from
  // the current run.
  clearStagedPagePlans(session_id);

  // Concepts are not read from the extractions here: they go through the
  // resolver and arrive as canonical_concepts in the request body, matching
  // how canonical_entities flows in. Same 3-layer cross-session pipeline for
  // both, so "Transformer Architecture" and "Transformer Networks" from
  // different sessions converge instead of forming duplicate concept pages.
  const plans: PlannedPage[] = [];

  // Wiki-wide promotion threshold (schema v17). An entity/concept gets its own
  // page when the number of distinct sources that have EVER mentioned it
  // crosses the threshold — not just sources in this compile session.
  // Reads entity_mentions which was written at extract time. Enables the
  // Karpathy-style compounding: source #47 mentioning an entity first seen in
  // source #12 is the tipping point that promotes it, even when ingested alone.
  const entityThreshold = getEntityPromotionThreshold();

  // A new entity, concept, comparison or overview page that a draft waiting
  // for approval will create (auto-approve off) counts as planned: Rules 2-5
  // plan no second "create" of it, or approving both drafts made two pages
  // (plan 1.8). This session's sources wait for that draft; once it is
  // approved, a compile naming the subject updates the page from every
  // source that mentions it.
  let pendingCreatesSkipped = 0;
  const waitsForApproval = (title: string, pageTypes: readonly string[]): boolean => {
    if (!hasPendingCreate(title, pageTypes)) return false;
    pendingCreatesSkipped++;
    return true;
  };

  // ── Rule 1: Source summaries ─────────────────────────────────────────────────
  // All sources get a page. Short sources (<min_source_chars) become 'original-source'
  // pages that display raw content without LLM drafting. Long sources are 'source-summary'.
  // On retry, a source may already have a committed page from an earlier run —
  // getSourcePage finds it through provenance and flips the action to 'update'
  // so commit reuses the existing page_id instead of minting a duplicate.
  const minSourceChars = getMinSourceChars();
  for (const src of sessionSources) {
    const isShort = minSourceChars > 0 &&
      (readRawMarkdown(src.source_id)?.length ?? 0) < minSourceChars;
    // A source's page draft waiting for approval does not hold this one
    // back: every session source needs a plan (commit activates the sources
    // its plans name), and approval refuses whichever of the two drafts
    // comes second (lib/approve-plan.ts).
    const existing = getSourcePage(src.source_id, src.title);
    plans.push({
      plan_id: randomUUID(),
      title: src.title,
      page_type: isShort ? 'original-source' : 'source-summary',
      action: existing ? 'update' : 'create',
      source_ids: [src.source_id],
      existing_page_id: existing?.page_id,
      related_plan_ids: [],
    });
  }

  // ── Rules 2 + 3: Entity and concept pages ────────────────────────────────────
  // Concepts arrive pre-resolved from /api/compile/resolve like entities, in
  // their own bucket. A subject gets ONE plan whichever buckets name it: a
  // name some sources tag PRODUCT/ORG and others CONCEPT is one page ("S&P
  // 500" was planned twice on session 29be62eb). Its kind follows most of its
  // sources, and an existing page flips only on a clear majority (D6,
  // lib/page-kind.ts). A comparison or overview page with the title keeps its
  // own type.
  //
  // Gate is wiki-wide: countSourcesMentioning reads entity_mentions across the
  // full corpus. When threshold is crossed for the first time, source_ids on
  // the plan is seeded from the full historical mention set so the new page
  // is created with provenance for every source that ever named it — not just
  // the session sources that happened to trigger the promotion.
  const subjects = new Map<string, { canonical: string; sessionKinds: Map<string, PageKind> }>();
  const buckets: Array<[ResolvedGroup[], PageKind]> = [[canonicalEntities, 'entity'], [canonicalConcepts, 'concept']];
  for (const [groups, kind] of buckets) {
    for (const g of groups) {
      if (!g.canonical) continue;
      const key = g.canonical.toLowerCase();
      let subject = subjects.get(key);
      if (!subject) {
        subject = { canonical: g.canonical, sessionKinds: new Map() };
        subjects.set(key, subject);
      }
      // A source in both buckets counts once, as an entity, as extract does.
      for (const sid of g.source_ids ?? []) if (!subject.sessionKinds.has(sid)) subject.sessionKinds.set(sid, kind);
    }
  }

  const planIdByCanonical = new Map<string, string>(); // canonical (lower case) → plan_id
  for (const [key, subject] of subjects) {
    if (countSourcesMentioning(subject.canonical) < entityThreshold) continue;

    const existing = getTopicPageByTitle(subject.canonical);
    if (isHeld(existing)) continue;
    if (!existing && waitsForApproval(subject.canonical, TOPIC_PAGE_TYPES)) continue;
    let page_type: PlannedPage['page_type'];
    if (existing && !isPageKind(existing.page_type)) {
      page_type = existing.page_type as PlannedPage['page_type'];
    } else {
      const kinds = sourceKinds(getMentionKinds(subject.canonical), subject.sessionKinds);
      page_type = decidePageKind(existing ? (existing.page_type as PageKind) : null, countKinds(kinds.values()));
    }

    const plan_id = randomUUID();
    planIdByCanonical.set(key, plan_id);
    plans.push({
      plan_id,
      title: subject.canonical,
      page_type,
      action: existing ? 'update' : 'create',
      source_ids: getSourceIdsMentioning(subject.canonical),
      existing_page_id: existing?.page_id,
      related_plan_ids: [],
    });
  }

  // ── Rule 4: Comparison pages ─────────────────────────────────────────────────
  // A pair of subjects earns a comparison page ("A vs B") once
  // COMPARISON_SOURCE_THRESHOLD distinct sources across the wiki say they
  // compete or contradict each other: competes_with and contradicts count
  // together, one page per pair (plan 3.5). Candidates are this session's
  // relation rows (a pair nobody mentioned now isn't re-evaluated), which
  // resolve rebuilt on the resolver's canonical names (rebuildSessionMentions,
  // db.ts). Both ends must be subjects of this session, entity or concept,
  // with a plan from Rules 2-3, so the page can link both.
  const candidatePairs = new Map<string, { from: string; to: string }>();
  for (const row of getSessionComparisonPairs(session_id)) {
    const a = subjects.get(row.from_canonical.toLowerCase());
    const b = subjects.get(row.to_canonical.toLowerCase());
    if (!a || !b || a === b) continue;
    // Sorted like the stored rows, so the title is the same whichever way
    // round a source put it.
    const [from, to] = a.canonical.toLowerCase() <= b.canonical.toLowerCase()
      ? [a.canonical, b.canonical]
      : [b.canonical, a.canonical];
    const key = `${from.toLowerCase()}|||${to.toLowerCase()}`;
    if (!candidatePairs.has(key)) candidatePairs.set(key, { from, to });
  }

  let relationshipsBelowThreshold = 0;
  for (const { from, to } of candidatePairs.values()) {
    const comparisonSourceIds = getComparisonSourceIds(from, to);
    if (comparisonSourceIds.length < COMPARISON_SOURCE_THRESHOLD) {
      relationshipsBelowThreshold++;
      continue;
    }

    const planIdA = planIdByCanonical.get(from.toLowerCase());
    const planIdB = planIdByCanonical.get(to.toLowerCase());
    if (!planIdA || !planIdB) continue;
    const related: string[] = [planIdA, planIdB];

    const compTitle = `${from} vs ${to}`;
    // Like Rules 2 and 3: a source page with this title is not the comparison.
    const existingComp = getTopicPageByTitle(compTitle);
    if (isHeld(existingComp)) continue;
    if (!existingComp && waitsForApproval(compTitle, ['comparison'])) continue;
    plans.push({
      plan_id: randomUUID(),
      title: compTitle,
      page_type: 'comparison',
      action: existingComp ? 'update' : 'create',
      source_ids: comparisonSourceIds,
      related_plan_ids: related,
      existing_page_id: existingComp?.page_id,
    });
  }

  // ── Rule 5: Overview pages ───────────────────────────────────────────────────
  // Group this session's entity plans by entity type, create overview when 3+.
  // Use Set — within-session canonical dedup (Rule 2) can yield multiple
  // canonicalEntities entries sharing one plan_id; a list would double-count
  // them and trigger an overview from fewer than 3 unique pages.
  const categoryMap = new Map<string, Set<string>>(); // category → plan_ids

  for (const entity of canonicalEntities) {
    const planId = planIdByCanonical.get(entity.canonical.toLowerCase());
    if (!planId) continue;
    // No type, or one with no category (OTHER, WORK_OF_ART, ...): no overview.
    const cat = entity.type ? entityTypeToCategory(entity.type) : null;
    if (!cat) continue;
    if (!categoryMap.has(cat)) categoryMap.set(cat, new Set());
    categoryMap.get(cat)!.add(planId);
  }

  for (const [category, relatedIdSet] of categoryMap.entries()) {
    if (relatedIdSet.size < 3) continue;
    const relatedIds = Array.from(relatedIdSet);

    // source_ids = union of all sources in this category group
    const overviewSourceIds = new Set<string>();
    for (const planId of relatedIds) {
      const plan = plans.find((p) => p.plan_id === planId);
      if (plan) plan.source_ids.forEach((s) => overviewSourceIds.add(s));
    }

    const overviewTitle = `${category} Overview`;
    const existingOverview = getTopicPageByTitle(overviewTitle);
    if (isHeld(existingOverview)) continue;
    if (!existingOverview && waitsForApproval(overviewTitle, ['overview'])) continue;
    plans.push({
      plan_id: randomUUID(),
      title: overviewTitle,
      page_type: 'overview',
      action: existingOverview ? 'update' : 'create',
      source_ids: [...overviewSourceIds],
      related_plan_ids: relatedIds,
      existing_page_id: existingOverview?.page_id,
    });
  }

  // ── Rule 6: Match-triage outputs (skip / update / contradiction) ────────────
  // The match step (/api/compile/match) runs TF-IDF + LLM triage for each
  // session source against non-summary pages, and may re-check pairs whose
  // triage failed in an earlier compile (their sources are from earlier
  // sessions; lib/compile/triage-recheck.ts). The three verdicts each have
  // a concrete downstream action; a failed triage has none:
  //   skip          → provenance-only plan (record the link, no re-draft)
  //   update        → update plan (re-draft the existing page with this source)
  //   contradiction → the same update plan, so the draft writes the
  //                   disagreement into the page, + a possible-disagreement
  //                   record (lib/compile/triage-disagreement.ts) powering
  //                   the wiki page sidebar.
  //   triage_failed → NO plan: triage gave no verdict (rate limit, cost
  //                   ceiling, error), so nothing may record the source on
  //                   the page. match/route.ts already logged it.
  // Pre-built source metadata lookup so Rule 6 doesn't re-query `sources`
  // on every match.
  const sessionSourceMetaById = new Map<string, typeof sessionSources[number]>();
  for (const s of sessionSources) sessionSourceMetaById.set(s.source_id, s);
  const earlierSourceMeta = (source_id: string) =>
    db
      .prepare(`SELECT source_id, title, source_url, source_type, date_ingested FROM sources WHERE source_id = ?`)
      .get(source_id) as typeof sessionSources[number] | undefined;

  for (const match of matches) {
    if (match.decision === 'skip') {
      const alreadyPlanned = plans.some(
        (p) => p.existing_page_id === match.page_id && p.source_ids.includes(match.source_id)
      );
      if (alreadyPlanned) continue;
      plans.push({
        plan_id: randomUUID(),
        title: match.page_title,
        page_type: 'entity',
        action: 'provenance-only',
        source_ids: [match.source_id],
        existing_page_id: match.page_id,
        related_plan_ids: [],
      });
    } else if (match.decision === 'update' || match.decision === 'contradiction') {
      // Re-draft the existing page with this source as a contributor
      // (commit/route.ts handles action='update'). One update plan per page:
      // a plan Rules 1-5 or an earlier verdict made for it takes the source,
      // since two drafts of one page from the same base lose one of the
      // updates (auto-approve) or have the second approval refused.
      const pagePlan = plans.find((p) => p.existing_page_id === match.page_id && p.action === 'update');
      if (pagePlan) {
        if (!pagePlan.source_ids.includes(match.source_id)) pagePlan.source_ids.push(match.source_id);
      } else {
        plans.push({
          plan_id: randomUUID(),
          title: match.page_title,
          // Match targets entity, concept, comparison and overview pages.
          page_type: updatePageType(getPage(match.page_id), 'entity'),
          action: 'update',
          source_ids: [match.source_id],
          existing_page_id: match.page_id,
          related_plan_ids: [],
        });
      }
      // A contradiction is also recorded as a possible disagreement; the
      // draft writes it into the page. A re-checked pair's source is from
      // an earlier session.
      if (match.decision === 'contradiction') {
        recordTriageContradiction({
          session_id,
          source_id: match.source_id,
          page_id: match.page_id,
          page_title: match.page_title,
          reason: match.reason,
          source: sessionSourceMetaById.get(match.source_id) ?? earlierSourceMeta(match.source_id),
        });
      }
    }
    // 'triage_failed' and any other decision value: no plan. Triage is
    // enum-typed at the match layer; unknown values are a contract
    // violation we don't rescue.
  }

  // ── Persist all plans ────────────────────────────────────────────────────────
  // A provenance-only plan has nothing to draft or link up, so it is stored
  // ready for commit. Ones earlier versions stored 'planned' never reach
  // commit (draft and crossref pass them by): some came from triage
  // outages, which gave no verdict, so linking them would be wrong.
  for (const plan of plans) {
    insertPagePlan({
      plan_id: plan.plan_id,
      session_id,
      title: plan.title,
      page_type: plan.page_type,
      action: plan.action,
      source_ids: plan.source_ids,
      existing_page_id: plan.existing_page_id ?? null,
      related_plan_ids: plan.related_plan_ids,
      draft_status: plan.action === 'provenance-only' ? 'crossreffed' : 'planned',
    });
  }

  const stats = {
    source_summaries: plans.filter((p) => p.page_type === 'source-summary').length,
    original_sources: plans.filter((p) => p.page_type === 'original-source').length,
    entity_pages: plans.filter((p) => p.page_type === 'entity').length,
    concept_pages: plans.filter((p) => p.page_type === 'concept').length,
    comparison_pages: plans.filter((p) => p.page_type === 'comparison').length,
    overview_pages: plans.filter((p) => p.page_type === 'overview').length,
    total: plans.length,
    entity_threshold: entityThreshold,
    comparison_threshold: COMPARISON_SOURCE_THRESHOLD,
    relationships_found: candidatePairs.size,
    relationships_below_threshold: relationshipsBelowThreshold,
    pending_creates_skipped: pendingCreatesSkipped,
  };

  return NextResponse.json({ session_id, pages: plans, stats }, { status: 200 });
  } catch (err) {
    // Own the stack trace here — orchestrator only sees the serialised message.
    console.error('[plan]', err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
