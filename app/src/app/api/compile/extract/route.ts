/**
 * POST /api/compile/extract
 *
 * Part 2a — Extraction Infrastructure.
 * Runs the full extraction pipeline for a single source:
 *
 *   1. Read source markdown from /data/raw/ (already stored by collect)
 *   2. POST /extract/ner            → entities + density signal
 *   3. Check wiki_exists (page count > 0)
 *   4. POST /extract/route          → extraction profile + methods
 *   5. Fan out to method endpoints in parallel:
 *        - rake, keybert, textrank, yake, tfidf-overlap (as per profile)
 *   6. POST /pipeline/extract-llm   → structured knowledge extraction via Gemini
 *   7. insertExtraction() + markSourceExtracted()
 *
 * After this route succeeds, the source has compile_status = 'extracted'.
 * The compile-drain is NOT affected — it only claims 'pending' sources.
 * The 2c session-compile workflow will pick up 'extracted' sources.
 *
 * Request:  { source_id: string }
 * Response: { source_id: string, extraction: LLMExtractionResponse }
 *
 * Errors:
 *   404 — source not found
 *   409 — already extracted (idempotent — returns existing result)
 *   429 — nlp-service rate limit
 *   503 — daily cost ceiling exceeded
 *   500 — unexpected error
 */

import { NextResponse } from 'next/server';
import {
  getAllPageIds,
  getExtraction,
  getPageCount,
  getSource,
  insertActivity,
  insertExtraction,
  markSourceExtracted,
  readRawMarkdown,
} from '../../../../lib/db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

// ── NLP service call helpers ──────────────────────────────────────────────────

interface NerResponse {
  source_id: string;
  entities: Array<{ text: string; label: string; start: number; end: number }>;
  entity_count: number;
  entity_density: string;
}

async function callNer(sourceId: string, text: string): Promise<NerResponse> {
  const res = await fetch(`${NLP_SERVICE_URL}/extract/ner`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id: sourceId, text }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`ner_failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json() as Promise<NerResponse>;
}

interface RouteResponse {
  profile: string;
  methods: string[];
  skip: string[];
}

async function callExtractionRoute(
  sourceId: string,
  wordCount: number,
  entityDensity: string,
  wikiExists: boolean
): Promise<RouteResponse> {
  const contentLength = wordCount < 500 ? 'short' : wordCount >= 5000 ? 'long' : 'medium';
  const res = await fetch(`${NLP_SERVICE_URL}/extract/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_id: sourceId,
      content_length: contentLength,
      content_type: 'article',   // informational only; router uses length + density
      entity_density: entityDensity,
      wiki_exists: wikiExists,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`route_failed: ${res.status}`);
  return res.json() as Promise<RouteResponse>;
}

interface KeyphraseResponse {
  keyphrases: Array<{ phrase: string; score: number }>;
}

async function callMethod(method: string, text: string): Promise<KeyphraseResponse> {
  const res = await fetch(`${NLP_SERVICE_URL}/extract/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, top_n: 20 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${method}_failed: ${res.status}`);
  return res.json() as Promise<KeyphraseResponse>;
}

interface TfidfResponse {
  overlap_score: number;
  top_matches: Array<{ page_id: string; similarity: number }>;
}

async function callTfidfOverlap(
  sourceText: string,
  corpusPageIds: string[]
): Promise<TfidfResponse> {
  const res = await fetch(`${NLP_SERVICE_URL}/extract/tfidf-overlap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_text: sourceText, corpus_page_ids: corpusPageIds }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`tfidf_overlap_failed: ${res.status}`);
  return res.json() as Promise<TfidfResponse>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callExtractLLM(payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${NLP_SERVICE_URL}/pipeline/extract-llm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300_000), // 5 min — Gemini thinking can be slow
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 429) throw Object.assign(new Error('llm_rate_limited'), { status: 429 });
    if (res.status === 503) throw Object.assign(new Error('daily_cost_ceiling'), { status: 503 });
    throw new Error(`extract_llm_failed: ${res.status} ${detail}`);
  }
  return res.json();
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { source_id } = body as { source_id?: string };
  if (typeof source_id !== 'string' || !source_id.trim()) {
    return NextResponse.json({ error: 'source_id required' }, { status: 400 });
  }

  // 404 check
  const source = getSource(source_id);
  if (!source) {
    return NextResponse.json({ error: 'source_not_found' }, { status: 404 });
  }

  // Idempotent: return existing extraction if already done
  const existing = getExtraction(source_id);
  if (existing) {
    return NextResponse.json({
      source_id,
      extraction: {
        llm_output: JSON.parse(existing.llm_output),
        ner_output: JSON.parse(existing.ner_output),
        profile: existing.profile,
        keyphrase_output: existing.keyphrase_output ? JSON.parse(existing.keyphrase_output) : null,
        tfidf_output: existing.tfidf_output ? JSON.parse(existing.tfidf_output) : null,
      },
    });
  }

  // Read source markdown
  const markdown = readRawMarkdown(source_id);
  if (!markdown) {
    insertActivity({
      action_type: 'extraction_failed',
      source_id,
      details: { error: 'raw_markdown_not_found', title: source.title },
    });
    return NextResponse.json({ error: 'markdown_not_found' }, { status: 500 });
  }

  try {
    // Step 2: NER
    const nerResult = await callNer(source_id, markdown);

    // Step 3: wiki_exists
    const wikiExists = getPageCount() > 0;

    // Step 4: extraction profile
    const wordCount = markdown.split(/\s+/).length;
    const routeResult = await callExtractionRoute(
      source_id,
      wordCount,
      nerResult.entity_density,
      wikiExists
    );

    // Step 5: fan out to method endpoints in parallel
    const methodCalls: Array<Promise<[string, KeyphraseResponse | TfidfResponse]>> = [];

    const pageIds = getAllPageIds();

    for (const method of routeResult.methods) {
      if (method === 'tfidf-overlap') {
        methodCalls.push(
          callTfidfOverlap(markdown, pageIds).then((r) => ['tfidf-overlap', r] as [string, TfidfResponse])
        );
      } else {
        methodCalls.push(
          callMethod(method, markdown).then((r) => [method, r] as [string, KeyphraseResponse])
        );
      }
    }

    const methodResults = await Promise.allSettled(methodCalls);

    // Collect keyphrase results (non-tfidf) into a single object
    const keyphraseOutput: Record<string, unknown> = {};
    let tfidfOutput: TfidfResponse | null = null;

    for (const result of methodResults) {
      if (result.status === 'fulfilled') {
        const [name, data] = result.value;
        if (name === 'tfidf-overlap') {
          tfidfOutput = data as TfidfResponse;
        } else {
          keyphraseOutput[name] = data;
        }
      }
      // Silently skip failed method calls — NER + profile are the critical path
    }

    // Step 6: Gemini extraction
    const llmOutput = await callExtractLLM({
      source_id,
      markdown,
      ner_output: nerResult,
      keyphrase_output: Object.keys(keyphraseOutput).length > 0 ? keyphraseOutput : null,
      tfidf_output: tfidfOutput,
    });

    // Step 7: persist
    insertExtraction({
      source_id,
      ner_output: nerResult,
      profile: routeResult.profile,
      keyphrase_output: Object.keys(keyphraseOutput).length > 0 ? keyphraseOutput : null,
      tfidf_output: tfidfOutput,
      llm_output: llmOutput,
    });
    markSourceExtracted(source_id);

    insertActivity({
      action_type: 'extraction_complete',
      source_id,
      details: {
        title: source.title,
        entity_count:       ((llmOutput as Record<string, unknown[]>).entities       ?? []).length,
        concept_count:      ((llmOutput as Record<string, unknown[]>).concepts        ?? []).length,
        claim_count:        ((llmOutput as Record<string, unknown[]>).claims          ?? []).length,
        relationship_count: ((llmOutput as Record<string, unknown[]>).relationships   ?? []).length,
      },
    });

    return NextResponse.json({
      source_id,
      extraction: {
        llm_output: llmOutput,
        ner_output: nerResult,
        profile: routeResult.profile,
        keyphrase_output: Object.keys(keyphraseOutput).length > 0 ? keyphraseOutput : null,
        tfidf_output: tfidfOutput,
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
