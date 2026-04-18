/**
 * POST /api/compile/match
 *
 * Part 2d — Wiki-Aware Updates: TF-IDF + LLM triage.
 *
 * For returning sessions (page_count > 0), compares each session source
 * against non-summary wiki pages using TF-IDF cosine similarity, then
 * calls /pipeline/triage for each candidate above the 0.3 threshold.
 *
 * Short-circuits to { skipped: true, matches: [] } for first-compile
 * sessions (no existing pages to match against).
 *
 * Request:  { session_id: string, canonical_entities: unknown[] }
 * Response: { session_id, skipped, matches, stats }
 */

import { NextResponse } from 'next/server';
import {
  getPageCount,
  getPagesByType,
  getPage,
  getSourcesBySession,
  readRawMarkdown,
} from '@/lib/db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

interface TfidfMatch {
  page_id: string;
  similarity: number;
}

interface TfidfResponse {
  overlap_score: number;
  top_matches: TfidfMatch[];
}

interface TriageResponse {
  decision: 'update' | 'contradiction' | 'skip';
  reason: string;
}

export interface MatchEntry {
  source_id: string;
  page_id: string;
  page_title: string;
  decision: 'update' | 'contradiction' | 'skip';
  reason: string;
}

async function callTfidfOverlap(
  sourceText: string,
  corpusPageIds: string[]
): Promise<TfidfResponse> {
  const res = await fetch(`${NLP_SERVICE_URL}/extract/tfidf-overlap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_text: sourceText, corpus_page_ids: corpusPageIds }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`tfidf-overlap failed: ${res.status}`);
  return res.json() as Promise<TfidfResponse>;
}

async function callTriage(
  sourceClaims: string,
  existingPageSummary: string,
  pageTitle: string
): Promise<TriageResponse> {
  const res = await fetch(`${NLP_SERVICE_URL}/pipeline/triage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_claims: sourceClaims,
      existing_page_summary: existingPageSummary,
      page_title: pageTitle,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    // Rate limit / cost ceiling — treat as skip to avoid blocking the pipeline
    if (res.status === 429 || res.status === 503) return { decision: 'skip', reason: 'triage_unavailable' };
    throw new Error(`triage failed: ${res.status}`);
  }
  return res.json() as Promise<TriageResponse>;
}

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const body = rawBody as Record<string, unknown>;
  const { session_id } = body as { session_id?: string };
  if (typeof session_id !== 'string' || !session_id.trim()) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }

  try {
  // Short-circuit for first compile (no existing pages)
  const pageCount = getPageCount();
  if (pageCount === 0) {
    return NextResponse.json({
      session_id,
      skipped: true,
      matches: [],
      stats: { sources_checked: 0, candidates_found: 0, updates: 0, contradictions: 0, skips: 0 },
    });
  }

  // Build TF-IDF candidate corpus from non-summary pages
  const candidatePages = getPagesByType(['entity', 'concept', 'comparison', 'overview']);
  if (candidatePages.length === 0) {
    return NextResponse.json({
      session_id,
      skipped: true,
      matches: [],
      stats: { sources_checked: 0, candidates_found: 0, updates: 0, contradictions: 0, skips: 0 },
    });
  }

  const corpusPageIds = candidatePages.map((p) => p.page_id);
  const sources = getSourcesBySession(session_id);

  const matches: MatchEntry[] = [];
  let totalCandidates = 0;
  let updates = 0;
  let contradictions = 0;
  let skips = 0;

  for (const source of sources) {
    const markdown = readRawMarkdown(source.source_id);
    if (!markdown) continue;

    // TF-IDF: find pages with significant overlap
    let tfidfResult: TfidfResponse;
    try {
      tfidfResult = await callTfidfOverlap(markdown, corpusPageIds);
    } catch {
      // TF-IDF failure is non-fatal — skip this source
      continue;
    }

    // Take top 3 with score > 0.3
    const topCandidates = tfidfResult.top_matches
      .filter((m) => m.similarity > 0.3)
      .slice(0, 3);

    totalCandidates += topCandidates.length;

    for (const candidate of topCandidates) {
      const page = getPage(candidate.page_id);
      if (!page) continue;

      const existingSummary = page.summary ?? '';

      let triageResult: TriageResponse;
      try {
        triageResult = await callTriage(markdown, existingSummary, page.title);
      } catch {
        triageResult = { decision: 'skip', reason: 'triage_failed' };
      }

      matches.push({
        source_id: source.source_id,
        page_id: page.page_id,
        page_title: page.title,
        decision: triageResult.decision,
        reason: triageResult.reason,
      });

      if (triageResult.decision === 'update') updates++;
      else if (triageResult.decision === 'contradiction') contradictions++;
      else skips++;
    }
  }

  return NextResponse.json({
    session_id,
    skipped: false,
    matches,
    stats: {
      sources_checked: sources.length,
      candidates_found: totalCandidates,
      updates,
      contradictions,
      skips,
    },
  });
  } catch (err) {
    // Own the stack trace here — orchestrator only sees the serialised message.
    console.error('[match]', err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
