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
  getExtractionsBySession,
  insertActivity,
} from '../../../../lib/db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

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

async function callFuzzy(
  entities: EntityInput[],
  existingAliases: Array<{ alias: string; canonical: string }>
): Promise<FuzzyResolveResponse> {
  const res = await fetch(`${NLP_SERVICE_URL}/resolve/fuzzy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entities, existing_aliases: existingAliases }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`fuzzy_failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json() as Promise<FuzzyResolveResponse>;
}

async function callEmbedding(entities: EntityInput[]): Promise<EmbeddingResolveResponse> {
  const res = await fetch(`${NLP_SERVICE_URL}/resolve/embedding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entities }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`embedding_failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json() as Promise<EmbeddingResolveResponse>;
}

async function callDisambiguate(pairs: AmbiguousPair[]): Promise<DisambiguateResponse> {
  const res = await fetch(`${NLP_SERVICE_URL}/resolve/disambiguate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairs }),
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

  // Flatten all entities across all sources
  const allEntities: EntityInput[] = extractions.flatMap((ext) => {
    let llm: { entities?: Array<{ name: string; type: string; context?: string }> };
    try {
      llm = JSON.parse(ext.llm_output) as typeof llm;
    } catch {
      return [];
    }
    return (llm.entities ?? []).map((ent) => ({
      name: ent.name,
      type: ent.type,
      source_id: ext.source_id,
      context: ent.context ?? '',
    }));
  });

  if (allEntities.length === 0) {
    return NextResponse.json({
      session_id,
      canonical_entities: [],
      stats: { total_raw: 0, resolved_fuzzy: 0, resolved_embedding: 0, resolved_llm: 0, final_canonical: 0 },
    });
  }

  // Step 2: get existing aliases for returning session optimisation
  const storedAliases = getAliases();
  const existingAliases = storedAliases.map((a) => ({
    alias: a.alias,
    canonical: a.canonical_name,
  }));

  try {
    // Layer 1 — fuzzy
    const fuzzyResult = await callFuzzy(allEntities, existingAliases);
    const resolved1 = fuzzyResult.resolved;
    const unresolved1 = fuzzyResult.unresolved;

    // Layer 2 — embedding (only if there are unresolved entities)
    let resolved2: ResolvedGroup[] = [];
    let ambiguous2: AmbiguousPair[] = [];
    let unresolved2: EntityInput[] = [];

    if (unresolved1.length > 0) {
      const embResult = await callEmbedding(unresolved1);
      resolved2 = embResult.resolved;
      ambiguous2 = embResult.ambiguous;
      unresolved2 = embResult.unresolved;
    }

    // Layer 3 — LLM disambiguation (only if there are ambiguous pairs)
    const resolved3: ResolvedGroup[] = [];
    const ambiguousRemaining: EntityInput[] = [];

    if (ambiguous2.length > 0) {
      const disambResult = await callDisambiguate(ambiguous2);
      const disambMap = new Map(
        disambResult.results.map((r) => [`${r.entity_a}|||${r.entity_b}`, r])
      );

      for (const pair of ambiguous2) {
        const key = `${pair.entity_a.name}|||${pair.entity_b.name}`;
        const result = disambMap.get(key);
        if (result?.decision === 'same' && result.canonical) {
          const canon = result.canonical;
          const names = [pair.entity_a.name, pair.entity_b.name];
          resolved3.push({
            canonical: canon,
            type: pair.entity_a.type,
            aliases: names.filter((n) => n !== canon),
            source_ids: [...new Set([pair.entity_a.source_id, pair.entity_b.source_id])],
            method: 'llm',
          });
        } else {
          // "different" or "ambiguous" — treat both as separate singletons
          ambiguousRemaining.push(pair.entity_a);
          ambiguousRemaining.push(pair.entity_b);
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

    const canonicalEntities: ResolvedGroup[] = [
      ...resolved1,
      ...resolved2,
      ...resolved3,
      ...dedupedSingletons,
    ];

    // Step 5: persist aliases
    const aliasesToInsert = canonicalEntities.flatMap((g) =>
      g.aliases.map((a) => ({ alias: a, canonical: g.canonical }))
    );
    if (aliasesToInsert.length > 0) {
      bulkInsertAliases(aliasesToInsert);
    }

    insertActivity({
      action_type: 'resolution_complete',
      source_id: null,
      details: {
        session_id,
        merged_count:   allEntities.length - canonicalEntities.length,
        resolved_count: canonicalEntities.length,
        total_raw:      allEntities.length,
      },
    });

    return NextResponse.json({
      session_id,
      canonical_entities: canonicalEntities,
      stats: {
        total_raw: allEntities.length,
        resolved_fuzzy: resolved1.reduce((sum, g) => sum + g.aliases.length, 0),
        resolved_embedding: resolved2.reduce((sum, g) => sum + g.aliases.length, 0),
        resolved_llm: resolved3.reduce((sum, g) => sum + g.aliases.length, 0),
        final_canonical: canonicalEntities.length,
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
    return NextResponse.json({ error: e.message ?? 'unknown_error' }, { status: 500 });
  }
}
