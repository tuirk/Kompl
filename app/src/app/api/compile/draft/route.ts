/**
 * POST /api/compile/draft
 *
 * Part 2c-i — Step 5: Draft Per Page.
 *
 * Reads all page_plans for the session with draft_status='planned'
 * (excluding provenance-only). Calls /pipeline/draft-page on the nlp-service
 * for each page, in layer order:
 *
 *   1. Source summaries (parallel, ≤5 concurrent)
 *   2. Entity pages (parallel)
 *   3. Concept pages (parallel)
 *   4. Comparison pages (needs entity drafts for context)
 *   5. Overview pages (needs all above)
 *
 * After each page is drafted, updates page_plans.draft_status = 'drafted'.
 *
 * Request:  { session_id: string }
 * Response: { session_id, drafted, failed, by_type }
 */

import { NextResponse } from 'next/server';

import {
  getAliases,
  getAllPages,
  getCategoryGroups,
  getEffectiveCompileModel,
  getExtractionsBySession,
  getPagePlansByStatus,
  readPageMarkdown,
  readRawMarkdown,
  updatePlanDraft,
  updatePlanStatus,
  getDb,
} from '../../../../lib/db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';
const DRAFT_CONCURRENCY = 5;

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
): Promise<string> {
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
      ...(compileModel ? { compile_model: compileModel } : {}),
    }),
    signal: AbortSignal.timeout(180_000), // 3 min — Gemini thinking can be slow
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 429) throw Object.assign(new Error('llm_rate_limited'), { status: 429 });
    if (res.status === 503) throw Object.assign(new Error('daily_cost_ceiling'), { status: 503 });
    throw new Error(`draft_page_failed: ${res.status} ${detail}`);
  }

  const data = (await res.json()) as { markdown: string };
  return data.markdown;
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

  if (plan.page_type === 'entity') {
    for (const sid of sourceIds) {
      const ext = extractionsBySource.get(sid);
      if (!ext) continue;
      const lines: string[] = [];

      const entityData = ((ext.entities as Array<Record<string, unknown>>) ?? []).find(
        (e) => matchesName(e.name)
      );
      if (entityData) {
        lines.push(`From source ${sid}:`);
        if (entityData.type) lines.push(`  Type: ${entityData.type}`);
        if (entityData.mentions) lines.push(`  Mentions: ${entityData.mentions}`);
        if (entityData.context) lines.push(`  Context: ${entityData.context}`);
      }

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

      const contras = ((ext.contradictions as Array<Record<string, unknown>>) ?? []).filter(
        (c) => matchesSubstring(c.description)
      );
      for (const contra of contras) {
        lines.push(`  ⚠️ Contradiction: ${contra.description}`);
      }

      if (lines.length > 0) parts.push(lines.join('\n'));
    }
  }

  if (plan.page_type === 'concept') {
    for (const sid of sourceIds) {
      const ext = extractionsBySource.get(sid);
      if (!ext) continue;
      const lines: string[] = [];

      const conceptData = ((ext.concepts as Array<Record<string, unknown>>) ?? []).find(
        (c) => matchesName(c.name)
      );
      if (conceptData) {
        lines.push(`From source ${sid}:`);
        if (conceptData.definition) lines.push(`  Definition: ${conceptData.definition}`);
        if (conceptData.context) lines.push(`  Context: ${conceptData.context}`);
      }

      const claims = ((ext.claims as Array<Record<string, unknown>>) ?? []).filter(
        (c) => matchesSubstring(c.claim)
      );
      for (const claim of claims) {
        lines.push(`  Claim: ${claim.claim}`);
      }

      if (lines.length > 0) parts.push(lines.join('\n'));
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
        if (r.type !== 'competes_with' && r.type !== 'contradicts') return false;
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

  // Load extractions for dossier building (entity/concept/comparison pages only)
  const rawExtractions = getExtractionsBySession(session_id);
  const extractionsBySource = new Map<string, Record<string, unknown>>();
  for (const row of rawExtractions) {
    if (!row.llm_output) continue;
    try {
      extractionsBySource.set(row.source_id, JSON.parse(row.llm_output) as Record<string, unknown>);
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
  const allKnownTitles = [...sessionTitles, ...sortedExistingTitles].slice(0, 200);

  // Existing wiki categories — passed to Gemini so it reuses them instead of inventing new ones.
  // Exclude 'Uncategorized' (the null-category fallback) AND 'General' (a universal-matching sink
  // that the LLM reuses trivially once offered, collapsing every page into one category).
  // baseCategories = categories already committed to the DB from prior sessions.
  const baseCategories = getCategoryGroups()
    .map((g) => g.category)
    .filter((c): c is string => c !== null && c !== 'Uncategorized' && c !== 'General');

  // sessionCategories accumulates categories invented during this session's draft loop.
  // Source-summary pages are drafted first; their invented categories are harvested
  // before entity/concept pages run so later layers see a consistent category list.
  const sessionCategorySet = new Set<string>(baseCategories);

  // Layer order for drafting. 'original-source' runs alongside source-summary (raw passthrough, no LLM).
  const LAYER_ORDER = ['original-source', 'source-summary', 'entity', 'concept', 'comparison', 'overview'] as const;

  let drafted = 0;
  let failed = 0;
  const byType: Record<string, number> = {};

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

    const tasks = layerPlans.map((plan) => async () => {
      const sourceIds: string[] = JSON.parse(plan.source_ids);
      const sourceContents: SourceContent[] = sourceIds
        .map((sid) => {
          const s = sourceMap.get(sid);
          // For sources from other sessions, try to read from DB
          if (!s) {
            const dbSrc = db
              .prepare('SELECT source_id, title FROM sources WHERE source_id = ?')
              .get(sid) as { source_id: string; title: string } | undefined;
            if (!dbSrc) return null;
            const md = readRawMarkdown(sid);
            return md ? { source_id: sid, title: dbSrc.title, markdown: md } : null;
          }
          return s.markdown ? { source_id: sid, title: s.title, markdown: s.markdown } : null;
        })
        .filter((sc): sc is SourceContent => sc !== null);

      if (sourceContents.length === 0) {
        throw new Error(`no_readable_sources for plan ${plan.plan_id}`);
      }

      // Raw passthrough for 'original-source' pages — no LLM call.
      // Category + summary derived from existing NLP extraction (already ran at collect time).
      if (plan.page_type === 'original-source') {
        const src = sourceContents[0];
        const ext = extractionsBySource.get(src.source_id);
        const entities = (ext?.entities as Array<{ type?: string; mentions?: number }> | undefined) ?? [];
        const topEntity = entities.reduce<{ type?: string; mentions?: number } | null>(
          (best, e) => (e.mentions ?? 0) > (best?.mentions ?? 0) ? e : best,
          null
        );
        const category = topEntity?.type ? entityTypeToCategory(topEntity.type) : 'Uncategorized';
        const firstClaim = (ext?.claims as Array<{ claim?: string }> | undefined)?.[0]?.claim;
        const firstConcept = (ext?.concepts as Array<{ definition?: string }> | undefined)?.[0]?.definition;
        const summaryText = (firstClaim ?? firstConcept ?? src.markdown.slice(0, 120).replace(/\n/g, ' ')).trim();
        const rawDraft = `---\ntitle: "${plan.title}"\ncategory: ${category}\nsummary: "${summaryText.replace(/"/g, "'")}"\n---\n\n${src.markdown}`;
        updatePlanDraft(plan.plan_id, rawDraft);
        return { pageType: plan.page_type, markdown: rawDraft };
      }

      // Related pages: for overview/comparison, use already-drafted pages
      const relatedPlanIds: string[] = plan.related_plan_ids ? JSON.parse(plan.related_plan_ids) : [];
      const relatedPages: RelatedPage[] = draftedContext.filter((dp) => {
        // Include if it's a related plan or just generally relevant drafted content
        return relatedPlanIds.length === 0
          ? draftedContext.length <= 10  // include all if few
          : relatedPlanIds.some((rId) => {
              const rPlan = draftedPlans.find((d) => d.plan_id === rId);
              return rPlan?.title === dp.title;
            });
      });

      const dossier = buildDossier(plan, extractionsBySource, planTitleById, aliasesByCanonical);

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

      const markdown = await callDraftPage(
        plan.page_type,
        plan.title,
        sourceContents,
        relatedPages.length > 0 ? relatedPages : undefined,
        existingContent,
        schema,
        allKnownTitles,
        dossier || undefined,
        Array.from(sessionCategorySet),
        getEffectiveCompileModel(session_id),
      );

      updatePlanDraft(plan.plan_id, markdown);
      return { pageType: plan.page_type, markdown };
    });

    const results = await pLimit(tasks, DRAFT_CONCURRENCY);

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r instanceof Error) {
        failed++;
        updatePlanStatus(layerPlans[i].plan_id, 'failed');
      } else {
        drafted++;
        byType[r.pageType] = (byType[r.pageType] ?? 0) + 1;
        // Harvest any new categories this layer invented so later layers can reuse them.
        const catMatch = r.markdown.match(/^category:\s*["']?(.+?)["']?\s*$/m);
        if (catMatch?.[1]) {
          const newCat = catMatch[1].trim();
          if (newCat && newCat !== 'Uncategorized' && newCat !== 'General') sessionCategorySet.add(newCat);
        }
      }
    }
  }

  return NextResponse.json({ session_id, drafted, failed, by_type: byType }, { status: 200 });
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
