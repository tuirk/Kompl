/**
 * POST /api/compile/plan
 *
 * Part 2c-i — Step 4: Build Page Plan.
 *
 * Pure logic, no LLM. Takes canonical_entities from the resolve step and
 * builds a PlannedPage list covering all page types needed for this session:
 *   1. Source summaries — one per session source, always 'create'
 *   2. Entity pages — from canonical entity list
 *   3. Concept pages — concepts recurring across 2+ sources (fuzzy-grouped)
 *   4. Comparison pages — relationships of type competes_with / contradicts
 *   5. Overview pages — when a category has 3+ entity/concept pages
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
  countSourcesForRelationship,
  countSourcesMentioning,
  getDb,
  getEntityPromotionThreshold,
  getExtractionsBySession,
  getMinSourceChars,
  getPageByTitle,
  getSourceIdsForRelationship,
  getSourceIdsMentioning,
  insertPagePlan,
  readRawMarkdown,
} from '../../../../lib/db';

// ── Types ────────────────────────────────────────────────────────────────────

interface ResolvedGroup {
  canonical: string;
  type: string;
  aliases: string[];
  source_ids: string[];
  method: string;
}

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
// many distinct sources. One article saying "X competes with Y" is just that
// article's opinion — three sources noting the same rivalry is a pattern
// worth synthesising into its own page.
// Deliberately NOT user-tunable — this is the load-bearing evidence signal,
// not a noise knob.
export const COMPARISON_SOURCE_THRESHOLD = 3;

// ── Levenshtein distance (simple, sufficient for short concept names) ─────────

export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// Simple acronym check: "ML" matches "Machine Learning" if first letters align.
export function isAcronymOf(acronym: string, full: string): boolean {
  if (acronym.length < 2 || acronym.length > 8) return false;
  const words = full.split(/\s+/);
  if (words.length < 2) return false;
  const initials = words.map((w) => w[0]?.toUpperCase() ?? '').join('');
  return initials === acronym.toUpperCase();
}

export function conceptsMatch(a: string, b: string): boolean {
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (al === bl) return true;
  if (levenshtein(al, bl) <= 2) return true;
  if (isAcronymOf(al, bl) || isAcronymOf(bl, al)) return true;
  return false;
}

// ── Entity type → category heuristic ─────────────────────────────────────────

export function entityTypeToCategory(entityType: string): string {
  const t = entityType.toUpperCase();
  if (t === 'PERSON') return 'People';
  if (t === 'ORG') return 'Organizations';
  if (t === 'PRODUCT') return 'Products';
  if (t === 'LOCATION') return 'Locations';
  if (t === 'EVENT') return 'Events';
  if (t === 'CONCEPT') return 'Concepts';
  return 'General';
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
  const { session_id } = body as { session_id?: string; canonical_entities?: ResolvedGroup[] };

  if (typeof session_id !== 'string' || !session_id.trim()) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }
  if (!Array.isArray(body.canonical_entities)) {
    return NextResponse.json({ error: 'canonical_entities must be an array' }, { status: 422 });
  }

  try {
  const canonicalEntities = body.canonical_entities as ResolvedGroup[];
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

  // Get session sources
  const sessionSources = db
    .prepare(
      `SELECT source_id, title, onboarding_session_id
         FROM sources
        WHERE onboarding_session_id = ?
          AND compile_status IN ('pending', 'extracted', 'in_progress')`
    )
    .all(session_id) as Array<{ source_id: string; title: string }>;

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

  // Get extractions for concepts and relationships
  const extractions = getExtractionsBySession(session_id);
  const extractionMap = new Map<string, { concepts: Array<{ name: string }>; relationships: Array<{ from_entity: string; to: string; type: string }> }>();
  for (const ext of extractions) {
    try {
      const llm = JSON.parse(ext.llm_output) as {
        concepts?: Array<{ name: string }>;
        relationships?: Array<{ from_entity: string; to: string; type: string }>;
      };
      extractionMap.set(ext.source_id, {
        concepts: llm.concepts ?? [],
        relationships: llm.relationships ?? [],
      });
    } catch {
      extractionMap.set(ext.source_id, { concepts: [], relationships: [] });
    }
  }

  const plans: PlannedPage[] = [];

  // Wiki-wide promotion threshold (schema v17). An entity/concept gets its own
  // page when the number of distinct sources that have EVER mentioned it
  // crosses the threshold — not just sources in this compile session.
  // Reads entity_mentions which was written at extract time. Enables the
  // Karpathy-style compounding: source #47 mentioning an entity first seen in
  // source #12 is the tipping point that promotes it, even when ingested alone.
  const entityThreshold = getEntityPromotionThreshold();

  // ── Rule 1: Source summaries ─────────────────────────────────────────────────
  // All sources get a page. Short sources (<min_source_chars) become 'original-source'
  // pages that display raw content without LLM drafting. Long sources are 'source-summary'.
  // On retry, a source may already have a committed page from an earlier run —
  // getPageByTitle flips the action to 'update' so commit reuses the existing
  // page_id instead of minting a duplicate.
  const minSourceChars = getMinSourceChars();
  for (const src of sessionSources) {
    const isShort = minSourceChars > 0 &&
      (readRawMarkdown(src.source_id)?.length ?? 0) < minSourceChars;
    const existing = getPageByTitle(src.title);
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

  // ── Rule 2: Entity pages ─────────────────────────────────────────────────────
  // Gate is wiki-wide: countSourcesMentioning reads entity_mentions across the
  // full corpus. When threshold is crossed for the first time, source_ids on
  // the plan is seeded from the full historical mention set so the new page
  // is created with provenance for every source that ever named it — not just
  // the session sources that happened to trigger the promotion.
  const entityPlanIds: string[] = [];
  const entityPlansByCanonical = new Map<string, string>(); // canonical → plan_id

  for (const entity of canonicalEntities) {
    if (!entity.canonical) continue;
    if (countSourcesMentioning(entity.canonical) < entityThreshold) continue;

    const canonicalKey = entity.canonical.toLowerCase();

    // Within-session dedup: same canonical name seen again → skip; source_ids
    // were already seeded from the full mention history on first insert.
    if (entityPlansByCanonical.has(canonicalKey)) continue;

    const existing = getPageByTitle(entity.canonical);
    const plan_id = randomUUID();
    entityPlansByCanonical.set(canonicalKey, plan_id);

    plans.push({
      plan_id,
      title: entity.canonical,
      page_type: 'entity',
      action: existing ? 'update' : 'create',
      source_ids: getSourceIdsMentioning(entity.canonical),
      existing_page_id: existing?.page_id,
      related_plan_ids: [],
    });
    entityPlanIds.push(plan_id);
  }

  // ── Rule 3: Concept pages ────────────────────────────────────────────────────
  // Collect all concepts across all sources, group by fuzzy match
  const conceptGroups: Array<{
    canonical: string;
    source_ids: string[];
    plan_id: string;
  }> = [];

  for (const [sourceId, ext] of extractionMap.entries()) {
    for (const concept of ext.concepts) {
      const name = concept.name.trim();
      if (!name) continue;

      const existing = conceptGroups.find((g) => conceptsMatch(g.canonical, name));
      if (existing) {
        if (!existing.source_ids.includes(sourceId)) {
          existing.source_ids.push(sourceId);
        }
      } else {
        conceptGroups.push({ canonical: name, source_ids: [sourceId], plan_id: randomUUID() });
      }
    }
  }

  const conceptPlanIds: string[] = [];
  for (const group of conceptGroups) {
    // Wiki-wide gate (same rationale as Rule 2). Concepts are stored in
    // entity_mentions under entity_type='CONCEPT' by the extract-time hook,
    // so the same COUNT works for both entities and concepts.
    if (countSourcesMentioning(group.canonical) < entityThreshold) continue;

    const existing = getPageByTitle(group.canonical);
    plans.push({
      plan_id: group.plan_id,
      title: group.canonical,
      page_type: 'concept',
      action: existing ? 'update' : 'create',
      source_ids: getSourceIdsMentioning(group.canonical),
      existing_page_id: existing?.page_id,
      related_plan_ids: [],
    });
    conceptPlanIds.push(group.plan_id);
  }

  // ── Rule 4: Comparison pages ─────────────────────────────────────────────────
  // Wiki-wide counting: relationship_mentions was written at extract time with
  // direction-agnostic types (competes_with, contradicts) already normalized
  // to from/to lowercase-sorted order. We still enumerate THIS session's
  // relationships to seed the candidate list (a pair nobody mentioned in the
  // current session isn't worth re-evaluating), but the gate reads the full
  // corpus so a pair that hit threshold across historical sources finally
  // earns its page when the current session corroborates it.
  const entityNameSet = new Set(canonicalEntities.map((e) => e.canonical.toLowerCase()));

  const candidatePairs = new Map<string, { from: string; to: string; type: string }>();
  for (const ext of extractionMap.values()) {
    for (const rel of ext.relationships) {
      if (rel.type !== 'competes_with' && rel.type !== 'contradicts') continue;
      if (!entityNameSet.has(rel.from_entity.toLowerCase())) continue;
      if (!entityNameSet.has(rel.to.toLowerCase())) continue;

      // Normalize to match the sort rule used by extract when writing
      // relationship_mentions, so the lookup key lines up.
      const [nameA, nameB] = rel.from_entity.toLowerCase() <= rel.to.toLowerCase()
        ? [rel.from_entity, rel.to]
        : [rel.to, rel.from_entity];
      const key = `${nameA.toLowerCase()}|||${nameB.toLowerCase()}|||${rel.type}`;
      if (!candidatePairs.has(key)) {
        candidatePairs.set(key, { from: nameA, to: nameB, type: rel.type });
      }
    }
  }

  let relationshipsBelowThreshold = 0;
  for (const { from, to, type } of candidatePairs.values()) {
    const count = countSourcesForRelationship(from, to, type);
    if (count < COMPARISON_SOURCE_THRESHOLD) {
      relationshipsBelowThreshold++;
      continue;
    }

    const planIdA = entityPlansByCanonical.get(from.toLowerCase());
    const planIdB = entityPlansByCanonical.get(to.toLowerCase());
    if (!planIdA || !planIdB) continue;
    const related: string[] = [planIdA, planIdB];

    const compTitle = `${from} vs ${to}`;
    const existingComp = getPageByTitle(compTitle);
    plans.push({
      plan_id: randomUUID(),
      title: compTitle,
      page_type: 'comparison',
      action: existingComp ? 'update' : 'create',
      source_ids: getSourceIdsForRelationship(from, to, type),
      related_plan_ids: related,
      existing_page_id: existingComp?.page_id,
    });
  }

  // ── Rule 5: Overview pages ───────────────────────────────────────────────────
  // Group entity + concept pages by category, create overview when 3+.
  // Use Set — within-session canonical dedup (Rule 2) can yield multiple
  // canonicalEntities entries sharing one plan_id; a list would double-count
  // them and trigger an overview from fewer than 3 unique pages.
  const categoryMap = new Map<string, Set<string>>(); // category → plan_ids

  for (const entity of canonicalEntities) {
    const planId = entityPlansByCanonical.get(entity.canonical.toLowerCase());
    if (!planId) continue;
    const cat = entityTypeToCategory(entity.type);
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
    const existingOverview = getPageByTitle(overviewTitle);
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

  // ── Rule 6: Provenance-only — TF-IDF "skip" decisions ───────────────────────
  // Sources that overlap with existing pages but have no new info get a
  // provenance-only entry so the link is recorded without triggering a re-draft.
  // update/contradiction decisions are handled by the existing title-match logic above.
  for (const match of matches) {
    if (match.decision !== 'skip') continue;

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
  }

  // ── Persist all plans ────────────────────────────────────────────────────────
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
  };

  return NextResponse.json({ session_id, pages: plans, stats }, { status: 200 });
  } catch (err) {
    // Own the stack trace here — orchestrator only sees the serialised message.
    console.error('[plan]', err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
