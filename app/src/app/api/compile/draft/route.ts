/**
 * POST /api/compile/draft
 *
 * Part 2c-i — Step 5: Draft Per Page.
 *
 * Reads all page_plans for the session with draft_status='planned'
 * (excluding provenance-only). Calls /pipeline/draft-page on the nlp-service
 * for each page, in layer order:
 *
 *   1. Source summaries (parallel; with no label to offer, one drafts alone first)
 *   2. Entity pages (parallel)
 *   3. Concept pages (parallel)
 *   4. Comparison pages (needs entity drafts for context)
 *   5. Overview pages (needs all above)
 *
 * After each page is drafted, updates page_plans.draft_status = 'drafted'
 * and records the sources its prompt carried (used_source_ids). The prompt
 * budget can leave sources out or shorten them; those are reported in
 * prompt_cuts and the step detail (lib/compile/draft-sources.ts).
 *
 * Request:  { session_id: string }
 * Response: { session_id, drafted, failed, by_type, prompt_cuts }
 */

import { NextResponse } from 'next/server';

import {
  getAliases,
  getAllPages,
  getDossierMaxSources,
  getDossierMinScore,
  getEffectiveCompileModel,
  getExtractionsBySourceIds,
  getPagePlansByStatus,
  readPageMarkdown,
  readRawMarkdown,
  updatePlanDraft,
  updatePlanFailed,
  updateCompileStep,
  getDb,
} from '../../../../lib/db';
import { yamlDoubleQuote } from '../../../../lib/yaml-escape';
import { LONG_HTTP_AGENT } from '../../../../lib/long-http-agent';
import {
  assignCitationLabels,
  citationsToLabels,
  labelsToStoredCitations,
  relabelDossier,
  rewordLabelSubjects,
} from '../../../../lib/citations';
import {
  describePromptCuts,
  orderDraftSources,
  overviewPages,
  type DraftSourceCut,
  type PlanPromptCut,
} from '../../../../lib/compile/draft-sources';
import { getSourceTitleSet } from '../../../../lib/page-sources';
import { normalizeFrontmatter, SOURCE_PAGE_TYPES, sourceOnlyTitles } from '../../../../lib/draft-cleanup';
import { withSourceText } from '../../../../lib/source-page-text';
import { CURRENT_DRAFT_RULES } from '../../../../lib/draft-rules';
import { pageTextVersionToken } from '../../../../lib/page-rewrite';
import { removeEmptyContradictionSections } from '../../../../lib/page-sections';
import { COMPARISON_RELATIONS, normalizeRelationType } from '../../../../lib/relation-rows';
import { sourceDates, withSourceDate } from '../../../../lib/source-dates';
import { DraftLabels, wikiLabelCounts } from '../../../../lib/compile/draft-labels';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';
// 10 concurrent draft calls. Tier-1 RPM is 1000/min and we use <1% of it,
// so the rate-limit headroom is huge. Per-page memory cost is ~100 KB
// (source markdown + dossier + schema) → 10 concurrent ≈ 1 MB, fine.
// Diminishing returns kick in when a layer has fewer plans than the cap;
// 10 is chosen so a session with 10+ source-summary pages drafts in a
// single round-trip instead of two staggered batches at 5.
const DRAFT_CONCURRENCY = 10;

// Same mapping as plan/route.ts — kept local to avoid a shared-lib extraction for 10 lines.
// Default is 'Uncategorized' (not 'General') — 'General' as a fallback seeds a universal-matching label into existing_categories and the LLM reuses it for every subsequent draft.
function entityTypeToCategory(entityType: string): string {
  const t = entityType.toUpperCase();
  if (t === 'PERSON') return 'People';
  if (t === 'ORG') return 'Organizations';
  if (t === 'PRODUCT') return 'Products';
  if (t === 'LOCATION') return 'Locations';
  if (t === 'EVENT') return 'Events';
  if (t === 'CONCEPT') return 'Concepts';
  return 'Uncategorized';
}

// ── Types ────────────────────────────────────────────────────────────────────

interface SourceContent {
  source_id: string;
  title: string;
  markdown: string;
  /** "S1"-style label the page cites this source with (lib/citations.ts). */
  citation_label?: string;
  /** This session's source: the prompt takes it first and whole (lib/compile/draft-sources.ts). */
  is_new?: boolean;
  /** Publication date, else the day it was saved (lib/source-dates.ts). */
  date?: string;
  date_kind?: 'published' | 'saved';
}

interface DraftPageReply {
  markdown: string;
  /** null when the nlp-service did not report them: every plan source is credited. */
  used_source_ids: string[] | null;
  cut_sources: DraftSourceCut[];
}

interface EarlierSource {
  citation_label: string;
  title: string;
  date?: string;
  date_kind?: 'published' | 'saved';
}

interface RelatedPage {
  title: string;
  type: string;
  summary: string;
}

async function callDraftPage(
  pageType: string,
  title: string,
  sourceContents: SourceContent[],
  relatedPages?: RelatedPage[],
  existingContent?: string,
  schema?: string,
  existingPageTitles?: string[],
  extractionDossier?: string,
  existingCategories?: string[],
  compileModel?: string,
  earlierSources?: EarlierSource[],
): Promise<DraftPageReply> {
  const res = await fetch(`${NLP_SERVICE_URL}/pipeline/draft-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page_type: pageType,
      title,
      source_contents: sourceContents,
      related_pages: relatedPages ?? [],
      existing_content: existingContent ?? null,
      schema: schema ?? null,
      existing_page_titles: existingPageTitles ?? [],
      extraction_dossier: extractionDossier ?? '',
      existing_categories: existingCategories ?? [],
      earlier_sources: earlierSources ?? [],
      ...(compileModel ? { compile_model: compileModel } : {}),
    }),
    signal: AbortSignal.timeout(600_000), // 10 min — DeepSeek draft can match extract latency on dense sources. Gemini thinking adds margin on top. Same 600s budget as extract/resolve/schema for symmetry.
    // LONG_HTTP_AGENT: undici default headersTimeout=300s would fire before
    // our 600s AbortSignal on dense source-summary drafts. Session 29be62eb
    // hit silent HeadersTimeoutError on 15/18 source-summaries (NLP server
    // returned 200 OK after the client had already given up).
    // @ts-expect-error — dispatcher is an undici-specific fetch option not in the DOM RequestInit type
    dispatcher: LONG_HTTP_AGENT,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 429) throw Object.assign(new Error('llm_rate_limited'), { status: 429 });
    if (res.status === 503) throw Object.assign(new Error('daily_cost_ceiling'), { status: 503 });
    throw new Error(`draft_page_failed: ${res.status} ${detail}`);
  }

  const data = (await res.json()) as { markdown: string; used_source_ids?: unknown; cut_sources?: unknown };
  return {
    markdown: data.markdown,
    used_source_ids: Array.isArray(data.used_source_ids) ? (data.used_source_ids as string[]) : null,
    cut_sources: Array.isArray(data.cut_sources) ? (data.cut_sources as DraftSourceCut[]) : [],
  };
}

// ── TF-IDF relevance ranking for dossier cap (Flag 3A) ──────────────────────

interface TfidfRankCandidate { id: string; text: string }
interface TfidfRankScore { id: string; score: number }

async function callTfidfRank(query: string, candidates: TfidfRankCandidate[]): Promise<TfidfRankScore[]> {
  if (candidates.length === 0) return [];
  const res = await fetch(`${NLP_SERVICE_URL}/extract/tfidf-rank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, candidates }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`tfidf_rank_failed: ${res.status}`);
  const data = (await res.json()) as { scores: TfidfRankScore[] };
  return data.scores;
}

/**
 * Flag 3A — cap a pre-built dossier by TF-IDF relevance to the plan's subject.
 *
 * The input is the already-built dossier string from buildDossier. We split
 * on block boundaries (double-newline), tag each block with its source_id
 * via the deterministic "From source {sid}:" prefix buildDossier emits, score
 * each against the query (plan.title + existing page markdown on updates),
 * filter by `min_score`, sort by (score DESC, source_id ASC) for deterministic
 * ties, and cap at top `max_sources`.
 *
 * Comparison pages skip scoring — plan.title "A vs B" is a poor TF-IDF query
 * and Rule 4's own source threshold already keeps the set small.
 *
 * Graceful degradation: if the nlp-service call fails, fall back to recency
 * (`extractions.created_at` DESC) and cap at max_sources without the min_score
 * filter. Plan continues to draft.
 *
 * Returns the capped dossier string plus the source_ids that made the cut
 * (for callers that want to also trim `related_plan_ids` or similar).
 */
async function capDossierByRelevance(
  plan: { plan_id: string; title: string; page_type: string; source_ids: string },
  dossierText: string,
  query: string,
  maxSources: number,
  minScore: number,
  extractionsBySource: Map<string, Record<string, unknown>>,
): Promise<string> {
  if (plan.page_type === 'comparison') return dossierText;
  const trimmed = dossierText.trim();
  if (!trimmed) return dossierText;

  // Parse per-source blocks. Each entity/concept block begins with
  // `From source {source_id}:` as its first line. Blocks without this
  // prefix (shouldn't happen for entity/concept) pass through unranked.
  const rawBlocks = trimmed.split(/\n\n+/);
  const tagged: Array<{ source_id: string; text: string }> = [];
  const untagged: string[] = [];
  for (const block of rawBlocks) {
    const m = block.match(/^From source (\S+):/);
    if (m) tagged.push({ source_id: m[1], text: block });
    else untagged.push(block);
  }

  if (tagged.length === 0) return dossierText;

  const candidatesScored = tagged.length;
  let keptIds: Set<string>;
  let topScore: number | null = null;
  let bottomScore: number | null = null;
  let usedFallback = false;

  try {
    const scores = await callTfidfRank(
      query,
      tagged.map((t) => ({ id: t.source_id, text: t.text })),
    );
    const ranked = scores
      .filter((s) => s.score >= minScore)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, maxSources);
    keptIds = new Set(ranked.map((r) => r.id));
    if (ranked.length > 0) {
      topScore = ranked[0].score;
      bottomScore = ranked[ranked.length - 1].score;
    }
  } catch (err) {
    usedFallback = true;
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'tfidf_rank_failed',
      plan_id: plan.plan_id,
      page_title: plan.title,
      error: err instanceof Error ? err.message : String(err),
    }));
    // Recency fallback — sort by created_at DESC (empty string sorts last),
    // cap by maxSources only, skip min_score.
    const byRecency = [...tagged].sort((a, b) => {
      const ta = (extractionsBySource.get(a.source_id)?._created_at as string | undefined) ?? '';
      const tb = (extractionsBySource.get(b.source_id)?._created_at as string | undefined) ?? '';
      if (ta === tb) return a.source_id.localeCompare(b.source_id);
      return ta < tb ? 1 : -1;
    }).slice(0, maxSources);
    keptIds = new Set(byRecency.map((b) => b.source_id));
  }

  // Preserve original block order among survivors (already source_id-ordered
  // since buildDossier iterates plan.source_ids in-order). Re-attach any
  // untagged leading/trailing fragments so we never drop content we don't
  // know how to rank.
  const survivors = tagged.filter((t) => keptIds.has(t.source_id)).map((t) => t.text);
  const rebuilt = [...untagged, ...survivors].join('\n\n');

  // Telemetry — single structured line per plan, unlocks default tuning later.
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event: 'dossier_capped',
    plan_id: plan.plan_id,
    page_title: plan.title,
    page_type: plan.page_type,
    candidates_scored: candidatesScored,
    candidates_kept: keptIds.size,
    max_sources: maxSources,
    min_score: minScore,
    top_score: topScore,
    bottom_score: bottomScore,
    fallback: usedFallback,
  }));

  return rebuilt;
}

// Run an array of async tasks with limited concurrency
async function pLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<Array<T | Error>> {
  const results: Array<T | Error> = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        results[i] = e instanceof Error ? e : new Error(String(e));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ── Dossier builder ───────────────────────────────────────────────────────────

// Minimum alias length for substring filters. "AI" / "ML" / "GO" are real
// aliases but would match substrings of unrelated words ("paid", "email",
// "argon") if we ran raw `.includes()`. 3 chars is strict enough to block
// accidental char-sequence hits while keeping realistic short aliases like
// "gpt4", "llm2" effective for substring tests.
const MIN_SUBSTRING_ALIAS_LEN = 3;

export function buildDossier(
  plan: { page_type: string; title: string; source_ids: string; related_plan_ids: string | null },
  extractionsBySource: Map<string, Record<string, unknown>>,
  planTitleById: Map<string, string>,
  aliasesByCanonical: Map<string, Set<string>>
): string {
  if (!['entity', 'concept', 'comparison'].includes(plan.page_type)) return '';

  let sourceIds: string[];
  try {
    sourceIds = JSON.parse(plan.source_ids) as string[];
  } catch {
    return '';
  }

  const nameLower = plan.title.toLowerCase();

  // Resolve plan.title → set of known aliases (all lowercased). Falls back to
  // canonical-only when no alias rows exist (empty-map test + fresh-wiki case).
  // This is why the "GPT 4" / "GPT-4" case silently dropped source blocks
  // before the fix: resolve never rewrites extractions.llm_output, so the
  // filter must do alias resolution at read time.
  const aliasSet = aliasesByCanonical.get(nameLower) ?? new Set([nameLower]);

  const matchesName = (raw: unknown): boolean =>
    typeof raw === 'string' && aliasSet.has(raw.toLowerCase());

  const matchesSubstring = (text: unknown): boolean => {
    if (typeof text !== 'string') return false;
    const low = text.toLowerCase();
    for (const alias of aliasSet) {
      if (alias.length < MIN_SUBSTRING_ALIAS_LEN) continue;
      if (low.includes(alias)) return true;
    }
    return false;
  };

  const parts: string[] = [];

  type Item = Record<string, unknown>;
  const findNamed = (list: unknown): Item | undefined =>
    ((list as Item[] | undefined) ?? []).find((x) => matchesName(x.name));
  const entityLines = (e: Item): string[] => {
    const out: string[] = [];
    if (e.type) out.push(`  Type: ${e.type}`);
    if (e.mentions) out.push(`  Mentions: ${e.mentions}`);
    if (e.context) out.push(`  Context: ${e.context}`);
    return out;
  };
  const conceptLines = (c: Item): string[] => {
    const out: string[] = [];
    // Pydantic ExtractionConcept emits { name, description }; `definition`
    // is still read for older extraction rows.
    const definition = c.description ?? c.definition;
    if (definition) out.push(`  Definition: ${definition}`);
    if (c.context) out.push(`  Context: ${c.context}`);
    return out;
  };
  // What this source says the subject is. A page's kind follows most of its
  // sources (lib/page-kind.ts), so a source may list the subject under the
  // other kind; that list is read when the page's own kind has no match.
  // null when the source lists the subject under neither.
  const subjectLines = (ext: Item): string[] | null => {
    const entity = findNamed(ext.entities);
    const concept = findNamed(ext.concepts);
    const asEntity = entity ? entityLines(entity) : null;
    const asConcept = concept ? conceptLines(concept) : null;
    return plan.page_type === 'entity' ? asEntity ?? asConcept : asConcept ?? asEntity;
  };
  // Every non-empty per-source block starts with `From source {sid}:` —
  // capDossierByRelevance ranks and attributes blocks by that header.
  const pushSourceBlock = (sid: string, subject: string[] | null, extra: string[]) => {
    if (subject || extra.length > 0) parts.push([`From source ${sid}:`, ...(subject ?? []), ...extra].join('\n'));
  };
  // Pydantic ExtractionContradiction emits { claim, against }: what this
  // source says, and the view it disputes ("" when the source doesn't name
  // one). The drafter treats the dossier as its primary reference, so each
  // line says which side is the source's own. Entity and concept pages both
  // get them, so either can record the disagreement (plan 3.1).
  const contradictionLines = (ext: Item): string[] => {
    const out: string[] = [];
    const contras = ((ext.contradictions as Item[] | undefined) ?? []).filter(
      (c) => matchesSubstring(c.claim) || matchesSubstring(c.against)
    );
    for (const contra of contras) {
      const claim = typeof contra.claim === 'string' ? contra.claim.trim() : '';
      const against = typeof contra.against === 'string' ? contra.against.trim() : '';
      if (!claim) continue;
      out.push(
        against
          ? `  This source disputes "${against}" and says instead "${claim}"`
          : `  This source contradicts other accounts by saying "${claim}"`
      );
    }
    return out;
  };

  if (plan.page_type === 'entity') {
    for (const sid of sourceIds) {
      const ext = extractionsBySource.get(sid);
      if (!ext) continue;
      const subject = subjectLines(ext);
      const lines: string[] = [];

      // Pydantic ExtractionRelationship emits { from_entity, to, type, description } —
      // the dossier must match those field names, not r.source/r.target which never exist.
      const rels = ((ext.relationships as Array<Record<string, unknown>>) ?? []).filter(
        (r) => matchesName(r.from_entity) || matchesName(r.to)
      );
      for (const rel of rels) {
        lines.push(`  Relationship: ${rel.from_entity} —[${rel.type}]→ ${rel.to}`);
      }

      const claims = ((ext.claims as Array<Record<string, unknown>>) ?? []).filter(
        (c) => matchesSubstring(c.claim)
      );
      for (const claim of claims) {
        lines.push(`  Claim: ${claim.claim}`);
      }
      lines.push(...contradictionLines(ext));

      pushSourceBlock(sid, subject, lines);
    }
  }

  if (plan.page_type === 'concept') {
    for (const sid of sourceIds) {
      const ext = extractionsBySource.get(sid);
      if (!ext) continue;
      const subject = subjectLines(ext);
      const lines: string[] = [];

      const claims = ((ext.claims as Array<Record<string, unknown>>) ?? []).filter(
        (c) => matchesSubstring(c.claim)
      );
      for (const claim of claims) {
        lines.push(`  Claim: ${claim.claim}`);
      }
      lines.push(...contradictionLines(ext));

      pushSourceBlock(sid, subject, lines);
    }
  }

  if (plan.page_type === 'comparison') {
    // Resolve the plan's two subjects from related_plan_ids (ground truth from
    // planner at plan/route.ts:340-352). Each subject gets its OWN alias set so
    // the pair filter can enforce cross-subject endpoint symmetry:
    // {from:SubjectA, to:SubjectB} or {from:SubjectB, to:SubjectA} — never
    // {from:AliasOfA, to:AnotherAliasOfA}. Falls through to type-only filter
    // if related_plan_ids is missing/malformed — never throw.
    let aliasSetA: Set<string> | null = null;
    let aliasSetB: Set<string> | null = null;
    try {
      const ids = JSON.parse(plan.related_plan_ids ?? '[]') as string[];
      if (Array.isArray(ids) && ids.length === 2) {
        const a = planTitleById.get(ids[0])?.toLowerCase();
        const b = planTitleById.get(ids[1])?.toLowerCase();
        if (a && b) {
          aliasSetA = aliasesByCanonical.get(a) ?? new Set([a]);
          aliasSetB = aliasesByCanonical.get(b) ?? new Set([b]);
        }
      }
    } catch {
      // malformed related_plan_ids JSON — fall through to type-only filter
    }

    for (const sid of sourceIds) {
      const ext = extractionsBySource.get(sid);
      if (!ext) continue;

      const rels = ((ext.relationships as Array<Record<string, unknown>>) ?? []).filter((r) => {
        // The types Rule 4 counted for this page, however the LLM spelled them.
        if (typeof r.type !== 'string' || !COMPARISON_RELATIONS.has(normalizeRelationType(r.type))) return false;
        if (!aliasSetA || !aliasSetB) return true;
        if (typeof r.from_entity !== 'string' || typeof r.to !== 'string') return false;
        const from = r.from_entity.toLowerCase();
        const to = r.to.toLowerCase();
        // OR of AND — one endpoint must belong to subject A and the other to
        // subject B. Prevents relationships where both endpoints alias to the
        // same subject from sneaking into the wrong comparison page.
        return (
          (aliasSetA.has(from) && aliasSetB.has(to)) ||
          (aliasSetB.has(from) && aliasSetA.has(to))
        );
      });
      for (const rel of rels) {
        const lines = [`Comparison: ${rel.from_entity} vs ${rel.to} (${rel.type})`];
        if (rel.description) lines.push(`  Context: ${rel.description}`);
        parts.push(lines.join('\n'));
      }
    }
  }

  return parts.join('\n\n');
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { session_id } = rawBody as { session_id?: string };
  if (typeof session_id !== 'string' || !session_id.trim()) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }

  try {
  const db = getDb();

  // Get all sources for this session (for reading markdown)
  const sessionSources = db
    .prepare(
      `SELECT source_id, title, content_hash
         FROM sources
        WHERE onboarding_session_id = ?`
    )
    .all(session_id) as Array<{ source_id: string; title: string; content_hash: string }>;

  const sourceMap = new Map<string, { title: string; markdown: string | null }>();
  for (const src of sessionSources) {
    sourceMap.set(src.source_id, {
      title: src.title,
      markdown: readRawMarkdown(src.source_id),
    });
  }

  // Also get sources for other sessions referenced by entity page source_ids
  // (Not needed on first compile — all sources are in this session)

  // Get pages needing drafting — 'planned' (never drafted) + 'failed' (prior
  // attempt hit a Gemini 429/503). Failed plans are re-attempted here so a
  // transient API outage does not permanently strand them. On success they
  // transition to 'drafted' via updatePlanDraft (same path as fresh plans).
  const plans = [
    ...getPagePlansByStatus(session_id, 'planned'),
    ...getPagePlansByStatus(session_id, 'failed'),
  ].filter((p) => p.action !== 'provenance-only');

  if (plans.length === 0) {
    return NextResponse.json({ session_id, drafted: 0, failed: 0, by_type: {} }, { status: 200 });
  }

  // Load extractions for dossier building (entity/concept/comparison pages only).
  //
  // Flag 3A: load across the corpus, not just this session. A Rule 2/3 update
  // plan's source_ids is populated via getSourceIdsMentioning(), which may
  // include sources from older sessions — those extractions were previously
  // invisible to the dossier, forcing the LLM to re-parse raw markdown to
  // rediscover facts extraction already computed. Now every source_id
  // referenced by any plan in this compile contributes its extraction.
  //
  // The extractionsBySource map carries an OPTIONAL `_created_at` key on each
  // value so the graceful-degradation recency fallback can sort without a
  // second DB query. (The underscore prefix guarantees no collision with
  // Pydantic-emitted JSON fields.)
  const allPlanSourceIds = new Set<string>();
  for (const p of plans) {
    try {
      for (const sid of JSON.parse(p.source_ids) as string[]) allPlanSourceIds.add(sid);
    } catch {
      // malformed source_ids — plan will also fail downstream; skip here
    }
  }
  const rawExtractions = getExtractionsBySourceIds(Array.from(allPlanSourceIds));
  const extractionsBySource = new Map<string, Record<string, unknown>>();
  for (const row of rawExtractions) {
    if (!row.llm_output) continue;
    try {
      const parsed = JSON.parse(row.llm_output) as Record<string, unknown>;
      parsed._created_at = row.created_at;
      extractionsBySource.set(row.source_id, parsed);
    } catch {
      // skip unparseable extraction rows
    }
  }

  // Bulk-load the alias table once per compile so buildDossier can test
  // each extraction's raw entity/concept name against the canonical's full
  // alias set (rather than exact match against plan.title). Without this,
  // a source extracted as "GPT 4" silently drops out of the dossier for a
  // plan canonicalized to "GPT-4" — see buildDossier doc + tests for the
  // full rationale.
  const aliasesByCanonical = new Map<string, Set<string>>();
  for (const { alias, canonical_name } of getAliases()) {
    const key = canonical_name.toLowerCase();
    let set = aliasesByCanonical.get(key);
    if (!set) {
      set = new Set<string>([key]);
      aliasesByCanonical.set(key, set);
    }
    set.add(alias.toLowerCase());
  }

  // Flag 3A — dossier capping settings read once per compile.
  const dossierMaxSources = getDossierMaxSources();
  const dossierMinScore = getDossierMinScore();

  // Load the schema if it exists (for context)
  let schema: string | undefined;
  try {
    const schemaRes = await fetch(`${NLP_SERVICE_URL}/storage/read-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/data/schema.md' }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    if (schemaRes?.ok) {
      const d = (await schemaRes.json()) as { content?: string };
      schema = d.content;
    }
  } catch {
    // schema is optional — first compile won't have it
  }

  // Build title list for cross-session wikilink injection.
  // Session plan titles go first (being created now, most relevant).
  // Existing pages sorted by source_count DESC so the 200-cap keeps most-cited pages.
  const sessionTitles = plans.map((p) => p.title);
  const sessionTitleSet = new Set(sessionTitles);
  const existingPages = getAllPages();
  const sortedExistingTitles = [...existingPages]
    .sort((a, b) => (b.source_count ?? 0) - (a.source_count ?? 0))
    .map((p) => p.title)
    .filter((t) => !sessionTitleSet.has(t));
  // Source pages are cited, never linked: leave their titles out of the list
  // the model may link to.
  const sourceTitlesOnly = sourceOnlyTitles([...existingPages, ...plans]);
  const allKnownTitles = [...sessionTitles, ...sortedExistingTitles]
    .filter((t) => !sourceTitlesOnly.has(t.toLowerCase()))
    .slice(0, 200);

  // Category labels offered to each draft so it reuses one instead of
  // inventing a near copy: the wiki's labels, plus each label a draft of this
  // run chose, added as that draft finishes (lib/compile/draft-labels.ts).
  const categoryLabels = new DraftLabels(wikiLabelCounts().keys());

  // Layer order for drafting. 'original-source' runs alongside source-summary (raw passthrough, no LLM).
  const LAYER_ORDER = ['original-source', 'source-summary', 'entity', 'concept', 'comparison', 'overview'] as const;

  let drafted = 0;
  let failed = 0;
  const byType: Record<string, number> = {};
  // Sources the prompt budget left out or shortened, per plan.
  const promptCuts: PlanPromptCut[] = [];

  for (const layer of LAYER_ORDER) {
    const layerPlans = plans.filter((p) => p.page_type === layer);
    if (layerPlans.length === 0) continue;

    // Build context from already-drafted pages (for comparison/overview layers)
    const draftedPlans = db
      .prepare(
        `SELECT plan_id, title, page_type, draft_content
           FROM page_plans
          WHERE session_id = ? AND draft_status = 'drafted'`
      )
      .all(session_id) as Array<{ plan_id: string; title: string; page_type: string; draft_content: string | null }>;

    const draftedContext: RelatedPage[] = draftedPlans.map((dp) => {
      // Extract summary from frontmatter if present
      let summary = '';
      if (dp.draft_content) {
        const summaryMatch = dp.draft_content.match(/^summary:\s*["']?(.+?)["']?\s*$/m);
        if (summaryMatch) summary = summaryMatch[1];
      }
      return { title: dp.title, type: dp.page_type, summary };
    });

    // plan_id → title map for the comparison dossier filter. Comparison plans
    // need the two related entity plans' titles to scope relationships to the
    // specific pair. Entity plans may be either already-drafted (prior layer)
    // or still in `plans` (untouched) — merge both.
    const planTitleById = new Map<string, string>();
    for (const p of plans) planTitleById.set(p.plan_id, p.title);
    for (const dp of draftedPlans) planTitleById.set(dp.plan_id, dp.title);

    // Lets the citation scanner recognise legacy "(uuid, Source Title)" groups
    // in existing page content.
    const sourceTitles = getSourceTitleSet();

    const tasks = layerPlans.map((plan) => async () => {
      const sourceIds: string[] = JSON.parse(plan.source_ids);
      // An overview drafts from the pages it lists, not from every source
      // behind them (plan 2.1); it still credits those sources (used NULL).
      const isOverview = plan.page_type === 'overview';
      // This session's sources are marked new: the nlp-service puts them
      // first and whole and fits older ones into what the prompt budget
      // leaves (nlp-service/services/draft_budget.py).
      const loaded = (isOverview ? [] : sourceIds)
        .map((sid) => {
          const s = sourceMap.get(sid);
          // For sources from other sessions, try to read from DB
          if (!s) {
            const dbSrc = db
              .prepare('SELECT source_id, title, date_ingested FROM sources WHERE source_id = ?')
              .get(sid) as { source_id: string; title: string; date_ingested: string | null } | undefined;
            if (!dbSrc) return null;
            const md = readRawMarkdown(sid);
            return md
              ? { source_id: sid, title: dbSrc.title, markdown: md, is_new: false, date_ingested: dbSrc.date_ingested }
              : null;
          }
          return s.markdown
            ? { source_id: sid, title: s.title, markdown: s.markdown, is_new: true, date_ingested: null }
            : null;
        })
        .filter((sc): sc is SourceContent & { is_new: boolean; date_ingested: string | null } => sc !== null);
      const sourceContents: SourceContent[] = orderDraftSources(loaded).map(
        ({ date_ingested: _date, ...sc }) => sc,
      );

      if (sourceContents.length === 0 && !isOverview) {
        throw new Error(`no_readable_sources for plan ${plan.plan_id}`);
      }

      // The version of the page this update reads. Approving the draft later
      // (auto-approve off) refuses if the page changed since
      // (lib/approve-plan.ts). Nothing below awaits before the page is read
      // (readPageMarkdown), so the version and the text read agree.
      // A create with an existing_page_id (a redo rewriting the page its
      // compile made) records it too: commit skips the page if it changed.
      const baseVersion =
        (plan.action === 'update' || plan.action === 'create') && plan.existing_page_id
          ? pageTextVersionToken(plan.existing_page_id)
          : null;

      // Raw passthrough for 'original-source' pages — no LLM call.
      // Category + summary derived from existing NLP extraction (already ran at collect time).
      if (plan.page_type === 'original-source') {
        const src = sourceContents[0];
        const ext = extractionsBySource.get(src.source_id);
        // Extraction stores mentions as the list of text spans naming the
        // entity (ExtractionEntity.mentions), so the most mentioned entity is
        // the one with the longest list.
        const entities = (ext?.entities as Array<{ type?: string; mentions?: unknown }> | undefined) ?? [];
        const mentionCount = (e: { mentions?: unknown } | null): number =>
          Array.isArray(e?.mentions) ? e.mentions.length : 0;
        const topEntity = entities.reduce<{ type?: string; mentions?: unknown } | null>(
          (best, e) => (mentionCount(e) > mentionCount(best) ? e : best),
          null
        );
        const category = topEntity?.type ? entityTypeToCategory(topEntity.type) : 'Uncategorized';
        const firstClaim = (ext?.claims as Array<{ claim?: string }> | undefined)?.[0]?.claim;
        // Concepts carry `description` (`definition` in older extraction rows).
        const concept = (ext?.concepts as Array<{ description?: string; definition?: string }> | undefined)?.[0];
        const firstConcept = concept?.description ?? concept?.definition;
        const summaryText = (firstClaim ?? firstConcept ?? src.markdown.slice(0, 120).replace(/\n/g, ' ')).trim();
        const rawDraft = `---\ntitle: ${yamlDoubleQuote(plan.title)}\ncategory: ${category}\nsummary: ${yamlDoubleQuote(summaryText)}\n---\n\n${src.markdown}`;
        // The user's own text: no writing rules apply (lib/draft-rules.ts).
        updatePlanDraft(plan.plan_id, rawDraft, null, baseVersion);
        return { pageType: plan.page_type, markdown: rawDraft };
      }

      // Related pages: already-drafted pages. An overview's are its material:
      // its related plans' pages, whatever step they reached (a retry may
      // find them committed already).
      const relatedPlanIds: string[] = plan.related_plan_ids ? JSON.parse(plan.related_plan_ids) : [];
      const relatedPages: RelatedPage[] = isOverview ? overviewPages(db, relatedPlanIds) : draftedContext.filter((dp) => {
        // Source pages are cited through labels, not offered as related pages.
        if (SOURCE_PAGE_TYPES.has(dp.type)) return false;
        // Include if it's a related plan or just generally relevant drafted content
        return relatedPlanIds.length === 0
          ? draftedContext.length <= 10  // include all if few
          : relatedPlanIds.some((rId) => {
              const rPlan = draftedPlans.find((d) => d.plan_id === rId);
              return rPlan?.title === dp.title;
            });
      });
      if (isOverview && relatedPages.length === 0) {
        throw new Error(`no_pages_to_list for overview plan ${plan.plan_id}`);
      }

      const rawDossier = buildDossier(plan, extractionsBySource, planTitleById, aliasesByCanonical);

      // For 'update' actions with a resolved existing_page_id, load the existing
      // page markdown from disk so the LLM receives the "update this, don't
      // rewrite from scratch" prompt block (nlp-service/services/llm_client.py).
      // plan.draft_content is NOT the right field here — it's populated by
      // updatePlanDraft AFTER this call returns (always NULL on first pass), and
      // it has downstream commit semantics via approve-plan.ts, so overloading
      // it would corrupt the OFF-mode commit flow on draft failure.
      const existingContent =
        plan.action === 'update' && plan.existing_page_id
          ? readPageMarkdown(plan.existing_page_id) ?? undefined
          : undefined;

      // Flag 3A — cap the dossier by TF-IDF relevance. Query is plan.title
      // plus existing-page markdown on updates (enriches with related
      // terminology the planner already matched). Skipped for comparison
      // pages (bad query shape + Rule 4's own threshold keeps them small).
      const dossierQuery = existingContent ? `${plan.title} ${existingContent}` : plan.title;
      const dossier = await capDossierByRelevance(
        plan,
        rawDossier,
        dossierQuery,
        dossierMaxSources,
        dossierMinScore,
        extractionsBySource,
      );

      // Citations: the model cites short [S1]-style labels (named next to each
      // source and dossier block); labelsToStoredCitations turns them into
      // stored [^source_id] references, so pages never hold raw ids and a
      // citation keeps its source across later updates. Existing content goes
      // to the model with its citations converted to the same labels.
      const labels = assignCitationLabels(sourceContents.map((sc) => sc.source_id));
      const titleById = new Map(sourceContents.map((sc) => [sc.source_id.toLowerCase(), sc.title]));
      const titleOf = (id: string): string => {
        const known = titleById.get(id);
        if (known) return known;
        const row = db
          .prepare('SELECT title FROM sources WHERE lower(source_id) = ?')
          .get(id) as { title: string | null } | undefined;
        return row?.title ?? 'Untitled source';
      };
      const labelledDossier = dossier ? relabelDossier(dossier, labels, titleOf) : '';
      // Old frontmatter can carry invented keys (sources: S1…, last_updated)
      // that would clash with this draft's labels; the model never sees them.
      const labelledExisting = existingContent
        ? citationsToLabels(normalizeFrontmatter(existingContent), labels, (t) => sourceTitles.has(t.toLowerCase()))
        : null;
      // Each source's date, so the draft can tell a claim that changed over
      // time from a live disagreement (plan 3.1, lib/source-dates.ts).
      const earlierIds = labelledExisting?.added ?? [];
      const dates = sourceDates(db, [...sourceContents.map((sc) => sc.source_id), ...earlierIds]);
      const earlierSources: EarlierSource[] = earlierIds.map((id) => ({
        citation_label: labels.get(id) ?? '',
        title: titleOf(id),
        ...dates.get(id.toLowerCase()),
      }));

      const reply = await callDraftPage(
        plan.page_type,
        plan.title,
        sourceContents.map((sc) => withSourceDate({ ...sc, citation_label: labels.get(sc.source_id.toLowerCase()) }, dates)),
        relatedPages.length > 0 ? relatedPages : undefined,
        labelledExisting?.markdown,
        schema,
        allKnownTitles,
        labelledDossier || undefined,
        categoryLabels.list(),
        getEffectiveCompileModel(session_id),
        earlierSources,
      );
      if (reply.cut_sources.length > 0) {
        const cut: PlanPromptCut = {
          plan_id: plan.plan_id,
          title: plan.title,
          sources: reply.cut_sources.map((c) => ({ ...c, source_title: titleOf(c.source_id.toLowerCase()) })),
        };
        promptCuts.push(cut);
        console.log(JSON.stringify({ event: 'draft_prompt_cut', session_id, ...cut }));
      }
      // Safety nets for what the prompt asks but models don't always do:
      // labels used as words, invented frontmatter, empty Contradictions.
      const reworded = rewordLabelSubjects(reply.markdown);
      if (reworded.count > 0) {
        console.log(JSON.stringify({ event: 'draft_label_subjects_reworded', plan_id: plan.plan_id, count: reworded.count }));
      }
      let markdown = normalizeFrontmatter(labelsToStoredCitations(reworded.markdown, labels));
      if (plan.page_type !== 'source-summary') {
        markdown = removeEmptyContradictionSections(markdown).markdown;
      } else {
        // The source text from the stored source, the model's sections after it.
        markdown = withSourceText(markdown, sourceContents[0].markdown);
      }

      // Drafted by this version's prompt and cleanup. The commit copies the
      // marker to the page only when the plan drafted from scratch, and
      // credits the sources the prompt carried (an overview: every plan source).
      updatePlanDraft(
        plan.plan_id,
        markdown,
        CURRENT_DRAFT_RULES,
        baseVersion,
        isOverview ? null : reply.used_source_ids,
      );
      return { pageType: plan.page_type, markdown };
    });

    // Each finished draft adds its label at once, so drafts that start later,
    // in this layer or the next, are offered it.
    const labelled = tasks.map((task) => async () => {
      const r = await task();
      categoryLabels.addFromDraft(r.markdown);
      return r;
    });
    // A wiki's first compile has no label to offer: one summary drafts alone
    // first, so the rest start with its label instead of each inventing a
    // near copy (owner decision 2026-10-25). Same calls, one draft's wait.
    const firstAlone = layer === 'source-summary' && categoryLabels.list().length === 0 && labelled.length > 1;
    const results = firstAlone
      ? [...(await pLimit(labelled.slice(0, 1), 1)), ...(await pLimit(labelled.slice(1), DRAFT_CONCURRENCY))]
      : await pLimit(labelled, DRAFT_CONCURRENCY);

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r instanceof Error) {
        failed++;
        // Capture the actual error message in the page_plans row + log to
        // app stdout. Before this, every per-task failure was swallowed —
        // operators had no clue why a draft died. Session 29be62eb (15
        // source-summary HeadersTimeoutErrors) wasted 30+ min of debugging.
        console.error('[draft] plan_id=%s title=%s err=%s', layerPlans[i].plan_id, layerPlans[i].title, r.message);
        updatePlanFailed(layerPlans[i].plan_id, r.message);
      } else {
        drafted++;
        byType[r.pageType] = (byType[r.pageType] ?? 0) + 1;
      }
      // Live progress detail for the UI's "Writing pages" tracker. Without
      // this, the draft step shows just "PROCESSING" with no count while
      // earlier steps show "8/8 sources extracted" etc. Mirrors the per-
      // completion update pattern used by the extract worker pool.
      const count =
        failed > 0
          ? `${drafted}/${plans.length} pages drafted, ${failed} failed`
          : `${drafted}/${plans.length} pages drafted`;
      const cutLine = describePromptCuts(promptCuts);
      updateCompileStep(session_id, 'draft', 'running', cutLine ? `${count}; ${cutLine}` : count);
    }
  }

  return NextResponse.json(
    { session_id, drafted, failed, by_type: byType, prompt_cuts: promptCuts },
    { status: 200 },
  );
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 429) {
      return NextResponse.json({ error: 'llm_rate_limited' }, { status: 429 });
    }
    if (e.status === 503) {
      return NextResponse.json({ error: 'daily_cost_ceiling' }, { status: 503 });
    }
    // Own the stack trace here — orchestrator only sees the serialised message.
    console.error('[draft]', err);
    return NextResponse.json({ error: e.message ?? 'unknown_error' }, { status: 500 });
  }
}
