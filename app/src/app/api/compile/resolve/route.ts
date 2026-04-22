/**
 * POST /api/compile/resolve
 *
 * Part 2b — Entity Resolution.
 * Resolves entity duplicates across all sources in a session using a
 * three-layer cascading matcher:
 *
 *   1. getExtractionsBySession(sessionId) — flatten all entity lists
 *   2. Layer 1: POST /resolve/fuzzy     — exact, Levenshtein, Jaro-Winkler,
 *                                          substring, acronym, existing aliases
 *   3. Layer 2: POST /resolve/embedding — cosine similarity via sentence-transformers
 *              (>0.9 same, <0.7 different, 0.7–0.9 ambiguous)
 *   4. Layer 3: POST /resolve/disambiguate — Gemini LLM for ambiguous pairs
 *   5. bulkInsertAliases() — persist alias → canonical mappings
 *
 * The resolved canonical list is the ephemeral output consumed by 2c's
 * page planner. Sources stay 'extracted'. No new status changes here.
 *
 * The alias table IS the persistent artifact — every resolved group's
 * aliases are upserted, so subsequent sessions hit Layer 1 instantly.
 *
 * Idempotent: re-running produces the same result (aliases skip duplicates).
 *
 * Request:  { session_id: string }
 * Response: { session_id, canonical_entities, stats }
 *
 * Errors:
 *   400 — invalid request or no extracted sources for this session
 *   429 — nlp-service rate limit (LLM disambiguation)
 *   503 — daily cost ceiling exceeded
 *   500 — unexpected error
 */

import { NextResponse } from 'next/server';
import {
  bulkInsertAliases,
  getAliases,
  getEffectiveCompileModel,
  getEntityAndConceptPageTitles,
  getExtractionsBySession,
  logActivity,
  normalizeSessionMentionsToCanonical,
} from '../../../../lib/db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

// Must match nlp-service/routers/resolution.py EXISTING_PAGE_SENTINEL. Used to
// tag the synthetic EntityInput representing an existing wiki page title when
// Layer 2 flags a session-to-wiki pair as ambiguous. Downstream Layer 3
// handling treats this value as a non-source so the sentinel never leaks
// into real source_ids.
const EXISTING_PAGE_SENTINEL = '__existing_page__';

// ── Type definitions (mirror nlp-service Pydantic models) ─────────────────────

interface EntityInput {
  name: string;
  type: string;
  source_id: string;
  context: string;
}

interface ResolvedGroup {
  canonical: string;
  type: string;
  aliases: string[];
  source_ids: string[];
  method: string;
}

interface AmbiguousPair {
  entity_a: EntityInput;
  entity_b: EntityInput;
  similarity: number;
}

interface FuzzyResolveResponse {
  resolved: ResolvedGroup[];
  unresolved: EntityInput[];
}

interface EmbeddingResolveResponse {
  resolved: ResolvedGroup[];
  ambiguous: AmbiguousPair[];
  unresolved: EntityInput[];
}

interface DisambiguateResponse {
  results: Array<{
    entity_a: string;
    entity_b: string;
    decision: string;
    canonical: string | null;
    reason: string;
  }>;
}

// ── NLP service call helpers ───────────────────────────────────────────────────

interface ExistingPageTitle {
  title: string;
  page_type: string;  // 'entity' | 'concept'
}

async function callFuzzy(
  entities: EntityInput[],
  existingAliases: Array<{ alias: string; canonical: string }>,
  existingPageTitles: ExistingPageTitle[]
): Promise<FuzzyResolveResponse> {
  const res = await fetch(`${NLP_SERVICE_URL}/resolve/fuzzy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entities,
      existing_aliases: existingAliases,
      existing_page_titles: existingPageTitles,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`fuzzy_failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json() as Promise<FuzzyResolveResponse>;
}

async function callEmbedding(
  entities: EntityInput[],
  existingPageTitles: ExistingPageTitle[]
): Promise<EmbeddingResolveResponse> {
  const res = await fetch(`${NLP_SERVICE_URL}/resolve/embedding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entities,
      existing_page_titles: existingPageTitles,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`embedding_failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json() as Promise<EmbeddingResolveResponse>;
}

async function callDisambiguate(
  pairs: AmbiguousPair[],
  compileModel?: string,
): Promise<DisambiguateResponse> {
  const res = await fetch(`${NLP_SERVICE_URL}/resolve/disambiguate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pairs,
      ...(compileModel ? { compile_model: compileModel } : {}),
    }),
    signal: AbortSignal.timeout(120_000), // LLM call — allow 2 min
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 429) throw Object.assign(new Error('llm_rate_limited'), { status: 429 });
    if (res.status === 503) throw Object.assign(new Error('daily_cost_ceiling'), { status: 503 });
    throw new Error(`disambiguate_failed: ${res.status} ${detail}`);
  }
  return res.json() as Promise<DisambiguateResponse>;
}

// ── Main handler ───────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { session_id } = body as { session_id?: string };
  if (typeof session_id !== 'string' || !session_id.trim()) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }

  // Step 1: get all extractions for this session
  const extractions = getExtractionsBySession(session_id);
  if (extractions.length === 0) {
    return NextResponse.json(
      { error: 'no_extracted_sources', detail: 'No extracted sources found for this session. Run /api/compile/extract for each source first.' },
      { status: 400 }
    );
  }

  // Flatten all entities + concepts across all sources into the same input pool.
  // Concepts are injected as synthetic EntityInputs with type='CONCEPT' and
  // context=description so they ride the same 3-layer pipeline as entities.
  // Type compatibility in the resolver keeps concept groups separate from
  // non-concept groups, so nothing wrongly merges across kinds. The response
  // partitions results back into canonical_entities vs canonical_concepts.
  const allEntities: EntityInput[] = extractions.flatMap((ext) => {
    let llm: {
      entities?: Array<{ name: string; type: string; context?: string }>;
      concepts?: Array<{ name: string; description?: string }>;
    };
    try {
      llm = JSON.parse(ext.llm_output) as typeof llm;
    } catch {
      return [];
    }
    const entityInputs: EntityInput[] = (llm.entities ?? []).map((ent) => ({
      name: ent.name,
      type: ent.type,
      source_id: ext.source_id,
      context: ent.context ?? '',
    }));
    const conceptInputs: EntityInput[] = (llm.concepts ?? [])
      .filter((c) => typeof c.name === 'string' && c.name.trim().length > 0)
      .map((c) => ({
        name: c.name.trim(),
        type: 'CONCEPT',
        source_id: ext.source_id,
        context: c.description ?? '',
      }));
    return [...entityInputs, ...conceptInputs];
  });

  if (allEntities.length === 0) {
    return NextResponse.json({
      session_id,
      canonical_entities: [],
      canonical_concepts: [],
      stats: { total_raw: 0, resolved_fuzzy: 0, resolved_embedding: 0, resolved_llm: 0, final_canonical: 0 },
    });
  }

  // Step 2: get existing aliases for returning session optimisation
  const storedAliases = getAliases();
  const existingAliases = storedAliases.map((a) => ({
    alias: a.alias,
    canonical: a.canonical_name,
  }));

  // Step 2b: get existing entity/concept page titles so the resolver can match
  // session entities against the wiki cross-session — closes the split-session
  // duplicate gap that the alias drawer alone can't cover.
  const existingPageTitles: ExistingPageTitle[] = getEntityAndConceptPageTitles();

  try {
    // Layer 1 — fuzzy
    const fuzzyResult = await callFuzzy(allEntities, existingAliases, existingPageTitles);
    const resolved1 = fuzzyResult.resolved;
    const unresolved1 = fuzzyResult.unresolved;

    // Layer 2 — embedding (only if there are unresolved entities)
    let resolved2: ResolvedGroup[] = [];
    let ambiguous2: AmbiguousPair[] = [];
    let unresolved2: EntityInput[] = [];

    if (unresolved1.length > 0) {
      const embResult = await callEmbedding(unresolved1, existingPageTitles);
      resolved2 = embResult.resolved;
      ambiguous2 = embResult.ambiguous;
      unresolved2 = embResult.unresolved;
    }

    // Layer 3 — LLM disambiguation (only if there are ambiguous pairs)
    const resolved3: ResolvedGroup[] = [];
    const ambiguousRemaining: EntityInput[] = [];

    if (ambiguous2.length > 0) {
      const disambResult = await callDisambiguate(ambiguous2, getEffectiveCompileModel(session_id));
      const disambMap = new Map(
        disambResult.results.map((r) => [`${r.entity_a}|||${r.entity_b}`, r])
      );

      for (const pair of ambiguous2) {
        const key = `${pair.entity_a.name}|||${pair.entity_b.name}`;
        const result = disambMap.get(key);
        // Cross-session ambiguous pairs have entity_b carrying the sentinel
        // source_id (see EXISTING_PAGE_SENTINEL in nlp-service). Handle those
        // specially — the sentinel is not a real session source and must not
        // leak into source_ids or into ambiguousRemaining as a singleton.
        const aIsExistingPage = pair.entity_a.source_id === EXISTING_PAGE_SENTINEL;
        const bIsExistingPage = pair.entity_b.source_id === EXISTING_PAGE_SENTINEL;

        if (result?.decision === 'same' && result.canonical) {
          // Pin the canonical to the existing page title so the new session
          // entity gets routed to the existing page. Always prefer the
          // existing-page title regardless of what the LLM picked — the wiki
          // is authoritative.
          const canon = bIsExistingPage
            ? pair.entity_b.name
            : aIsExistingPage
              ? pair.entity_a.name
              : result.canonical;
          const names: string[] = [];
          const sourceIds: string[] = [];
          if (!aIsExistingPage) {
            names.push(pair.entity_a.name);
            sourceIds.push(pair.entity_a.source_id);
          }
          if (!bIsExistingPage) {
            names.push(pair.entity_b.name);
            sourceIds.push(pair.entity_b.source_id);
          }
          resolved3.push({
            canonical: canon,
            type: pair.entity_a.type,
            aliases: names.filter((n) => n !== canon),
            source_ids: [...new Set(sourceIds)],
            method: aIsExistingPage || bIsExistingPage ? 'existing_page_title' : 'llm',
          });
        } else {
          // "different" or "ambiguous" — real session entities flow back to
          // singletons; the sentinel is discarded.
          if (!aIsExistingPage) ambiguousRemaining.push(pair.entity_a);
          if (!bIsExistingPage) ambiguousRemaining.push(pair.entity_b);
        }
      }
    }

    // Merge all resolved groups + singletons
    const singletonEntities = [
      ...unresolved2,
      ...ambiguousRemaining,
    ];
    // Deduplicate singletons (an entity can appear in both lists if it was in multiple pairs)
    const seenSingletons = new Set<string>();
    const dedupedSingletons: ResolvedGroup[] = [];
    for (const e of singletonEntities) {
      const key = `${e.name}|||${e.source_id}`;
      if (!seenSingletons.has(key)) {
        seenSingletons.add(key);
        dedupedSingletons.push({
          canonical: e.name,
          type: e.type,
          aliases: [],
          source_ids: [e.source_id],
          method: 'none',
        });
      }
    }

    const allCanonical: ResolvedGroup[] = [
      ...resolved1,
      ...resolved2,
      ...resolved3,
      ...dedupedSingletons,
    ];

    // Partition by type — concepts ran through the same pipeline so they could
    // cross-session dedup against existing concept pages, but the plan step
    // treats them as a distinct rule (Rule 3 concepts vs Rule 2 entities).
    const canonicalEntities: ResolvedGroup[] = [];
    const canonicalConcepts: ResolvedGroup[] = [];
    for (const g of allCanonical) {
      if (g.type === 'CONCEPT') {
        canonicalConcepts.push(g);
      } else {
        canonicalEntities.push(g);
      }
    }

    // Step 5: persist aliases for both kinds. The aliases table is untagged —
    // page_type is inferred via canonical_page_id once the page is committed.
    const aliasesToInsert = allCanonical.flatMap((g) =>
      g.aliases.map((a) => ({ alias: a, canonical: g.canonical }))
    );
    if (aliasesToInsert.length > 0) {
      bulkInsertAliases(aliasesToInsert);
      // Re-canonicalise this session's mention rows to the resolver-chosen
      // canonicals. Extract-commit pinned via historical aliases only; the
      // resolver just minted NEW aliases (e.g. cross-session page-title
      // anchors) that invalidate those initial pins for this session's
      // sources. Without this, plan's threshold counts + source_ids lookups
      // miss the current session's contribution when its extraction used a
      // variant spelling that the resolver has now canonicalised.
      normalizeSessionMentionsToCanonical(session_id, aliasesToInsert);
    }

    logActivity('resolution_complete', {
      source_id: null,
      details: {
        session_id,
        merged_count:   allEntities.length - allCanonical.length,
        resolved_count: allCanonical.length,
        total_raw:      allEntities.length,
        entity_count:   canonicalEntities.length,
        concept_count:  canonicalConcepts.length,
      },
    });

    return NextResponse.json({
      session_id,
      canonical_entities: canonicalEntities,
      canonical_concepts: canonicalConcepts,
      stats: {
        total_raw: allEntities.length,
        resolved_fuzzy: resolved1.reduce((sum, g) => sum + g.aliases.length, 0),
        resolved_embedding: resolved2.reduce((sum, g) => sum + g.aliases.length, 0),
        resolved_llm: resolved3.reduce((sum, g) => sum + g.aliases.length, 0),
        final_canonical: allCanonical.length,
        canonical_entities: canonicalEntities.length,
        canonical_concepts: canonicalConcepts.length,
      },
    });
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 429) {
      return NextResponse.json({ error: 'llm_rate_limited' }, { status: 429 });
    }
    if (e.status === 503) {
      return NextResponse.json({ error: 'daily_cost_ceiling' }, { status: 503 });
    }
    // Own the stack trace here — orchestrator only sees the serialised message.
    console.error('[resolve]', err);
    return NextResponse.json({ error: e.message ?? 'unknown_error' }, { status: 500 });
  }
}
