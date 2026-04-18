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
  getDb,
  getExtractionsBySession,
  getMinSourceChars,
  getPageByTitle,
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

  // Dynamic threshold: entity/concept page requires mentions in >= this many sources.
  // Math.ceil(10% of session sources), minimum 2. Prevents a single dense source
  // from creating dozens of entity pages and burning LLM budget.
  const entityThreshold = Math.max(2, Math.ceil(sessionSources.length * 0.1));

  // ── Rule 1: Source summaries ─────────────────────────────────────────────────
  // All sources get a page. Short sources (<min_source_chars) become 'original-source'
  // pages that display raw content without LLM drafting. Long sources are 'source-summary'.
  const minSourceChars = getMinSourceChars();
  for (const src of sessionSources) {
    const isShort = minSourceChars > 0 &&
      (readRawMarkdown(src.source_id)?.length ?? 0) < minSourceChars;
    plans.push({
      plan_id: randomUUID(),
      title: src.title,
      page_type: isShort ? 'original-source' : 'source-summary',
      action: 'create',
      source_ids: [src.source_id],
      related_plan_ids: [],
    });
  }

  // ── Rule 2: Entity pages ─────────────────────────────────────────────────────
  const entityPlanIds: string[] = [];
  const entityPlansByCanonical = new Map<string, string>(); // canonical → plan_id

  for (const entity of canonicalEntities) {
    if (!entity.canonical || entity.source_ids.length === 0) continue;
    if (entity.source_ids.length < entityThreshold) continue;

    const canonicalKey = entity.canonical.toLowerCase();

    // Within-session dedup: same canonical name seen again → merge source_ids
    // instead of creating a second plan entry. Mirrors the concept loop pattern.
    if (entityPlansByCanonical.has(canonicalKey)) {
      const existingPlanId = entityPlansByCanonical.get(canonicalKey)!;
      const existingPlan = plans.find((p) => p.plan_id === existingPlanId);
      if (existingPlan) {
        for (const sid of entity.source_ids) {
          if (!existingPlan.source_ids.includes(sid)) {
            existingPlan.source_ids.push(sid);
          }
        }
      }
      continue;
    }

    const existing = getPageByTitle(entity.canonical);
    const plan_id = randomUUID();
    entityPlansByCanonical.set(canonicalKey, plan_id);

    plans.push({
      plan_id,
      title: entity.canonical,
      page_type: 'entity',
      action: existing ? 'update' : 'create',
      source_ids: [...new Set(entity.source_ids)],
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
    if (group.source_ids.length < entityThreshold) continue;

    const existing = getPageByTitle(group.canonical);
    plans.push({
      plan_id: group.plan_id,
      title: group.canonical,
      page_type: 'concept',
      action: existing ? 'update' : 'create',
      source_ids: group.source_ids,
      existing_page_id: existing?.page_id,
      related_plan_ids: [],
    });
    conceptPlanIds.push(group.plan_id);
  }

  // ── Rule 4: Comparison pages ─────────────────────────────────────────────────
  // Threshold (COMPARISON_SOURCE_THRESHOLD) is module-level so tests can pin it.
  const entityNameSet = new Set(canonicalEntities.map((e) => e.canonical.toLowerCase()));

  // Phase 1: count distinct sources that extracted each relationship pair.
  // Key uses sorted, lower-cased names with '|||' so "A vs B" and "B vs A"
  // collapse into the same bucket. Display names are stored separately.
  const relationshipSourceCounts = new Map<string, Set<string>>();
  const relationshipDisplayNames = new Map<string, [string, string]>(); // key → [nameA, nameB]

  for (const [sourceId, ext] of extractionMap.entries()) {
    for (const rel of ext.relationships) {
      if (rel.type !== 'competes_with' && rel.type !== 'contradicts') continue;
      if (!entityNameSet.has(rel.from_entity.toLowerCase())) continue;
      if (!entityNameSet.has(rel.to.toLowerCase())) continue;

      const [nameA, nameB] = [rel.from_entity, rel.to].sort();
      const key = `${nameA.toLowerCase()}|||${nameB.toLowerCase()}`;
      if (!relationshipSourceCounts.has(key)) {
        relationshipSourceCounts.set(key, new Set());
        relationshipDisplayNames.set(key, [nameA, nameB]);
      }
      relationshipSourceCounts.get(key)!.add(sourceId);
    }
  }

  // Phase 2: emit a comparison page only for pairs that crossed the threshold.
  for (const [key, sourceSet] of relationshipSourceCounts.entries()) {
    if (sourceSet.size < COMPARISON_SOURCE_THRESHOLD) continue;

    const [nameA, nameB] = relationshipDisplayNames.get(key)!;
    const planIdA = entityPlansByCanonical.get(nameA.toLowerCase());
    const planIdB = entityPlansByCanonical.get(nameB.toLowerCase());
    const related: string[] = [];
    if (planIdA) related.push(planIdA);
    if (planIdB) related.push(planIdB);

    const compTitle = `${nameA} vs ${nameB}`;
    const existingComp = getPageByTitle(compTitle);
    plans.push({
      plan_id: randomUUID(),
      title: compTitle,
      page_type: 'comparison',
      action: existingComp ? 'update' : 'create',
      source_ids: [...sourceSet],
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
    relationships_found: relationshipSourceCounts.size,
    relationships_below_threshold: [...relationshipSourceCounts.values()].filter((s) => s.size < COMPARISON_SOURCE_THRESHOLD).length,
  };

  return NextResponse.json({ session_id, pages: plans, stats }, { status: 200 });
  } catch (err) {
    // Own the stack trace here — orchestrator only sees the serialised message.
    console.error('[plan]', err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
