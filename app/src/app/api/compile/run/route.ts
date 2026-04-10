/**
 * POST /api/compile/run
 *
 * Part 2c-ii — Session compile orchestrator.
 *
 * Called by the n8n session-compile workflow after confirm. Returns
 * immediately with { session_id, status: 'started' } and runs the full
 * 7-step pipeline in the background, updating compile_progress after
 * each step so the frontend can poll GET /api/compile/progress.
 *
 * Architecture rule #3: orchestration logic lives HERE (Next.js), not in
 * n8n nodes. n8n is the async trigger only — it fires this endpoint and
 * forgets. No circular webhook loops.
 *
 * Steps:
 *   1. extract  — POST /api/compile/extract per source (sequential)
 *   2. resolve  — POST /api/compile/resolve
 *   3. match    — POST /api/compile/match (TF-IDF + LLM triage vs existing pages)
 *   4. plan     — POST /api/compile/plan
 *   5. draft    — POST /api/compile/draft  (up to 15 min, Gemini calls)
 *   6. crossref — POST /api/compile/crossref
 *   7. commit   — POST /api/compile/commit
 *   8. schema   — POST /api/compile/schema (schema.md bootstrap)
 */

import { NextResponse } from 'next/server';
import {
  getCompileProgress,
  updateCompileStep,
  completeCompileProgress,
  failCompileProgress,
  getSourcesBySession,
} from '@/lib/db';

const APP_URL = process.env.APP_URL ?? 'http://app:3000';

async function callExtract(sourceId: string): Promise<void> {
  const res = await fetch(`${APP_URL}/api/compile/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id: sourceId }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`extract failed for ${sourceId}: ${res.status}`);
}

async function callResolve(sessionId: string): Promise<{ canonical_entities: unknown[] }> {
  const res = await fetch(`${APP_URL}/api/compile/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`resolve failed: ${res.status}`);
  return res.json() as Promise<{ canonical_entities: unknown[] }>;
}

async function callMatch(
  sessionId: string,
  canonicalEntities: unknown[]
): Promise<{ skipped: boolean; matches: unknown[]; stats: Record<string, number> }> {
  const res = await fetch(`${APP_URL}/api/compile/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, canonical_entities: canonicalEntities }),
    signal: AbortSignal.timeout(300_000), // triage calls can stack up
  });
  if (!res.ok) throw new Error(`match failed: ${res.status}`);
  return res.json() as Promise<{ skipped: boolean; matches: unknown[]; stats: Record<string, number> }>;
}

async function callPlan(
  sessionId: string,
  canonicalEntities: unknown[],
  matches: unknown[]
): Promise<{ stats: { total: number } }> {
  const res = await fetch(`${APP_URL}/api/compile/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, canonical_entities: canonicalEntities, matches }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`plan failed: ${res.status}`);
  return res.json() as Promise<{ stats: { total: number } }>;
}

async function callDraft(sessionId: string): Promise<{ drafted: number }> {
  const res = await fetch(`${APP_URL}/api/compile/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(900_000),
  });
  if (!res.ok) throw new Error(`draft failed: ${res.status}`);
  return res.json() as Promise<{ drafted: number }>;
}

async function callCrossref(sessionId: string): Promise<{ wikilinks_added: number }> {
  const res = await fetch(`${APP_URL}/api/compile/crossref`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) throw new Error(`crossref failed: ${res.status}`);
  return res.json() as Promise<{ wikilinks_added: number }>;
}

async function callCommit(sessionId: string): Promise<{ committed: number }> {
  const res = await fetch(`${APP_URL}/api/compile/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`commit failed: ${res.status}`);
  return res.json() as Promise<{ committed: number }>;
}

async function callSchema(sessionId: string): Promise<unknown> {
  const res = await fetch(`${APP_URL}/api/compile/schema`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`schema failed: ${res.status}`);
  return res.json();
}

async function runCompilePipeline(sessionId: string): Promise<void> {
  // Step 1: extract — sequential per source
  updateCompileStep(sessionId, 'extract', 'running');
  const sources = getSourcesBySession(sessionId);
  for (let i = 0; i < sources.length; i++) {
    await callExtract(sources[i].source_id);
    updateCompileStep(sessionId, 'extract', 'running', `${i + 1}/${sources.length} sources extracted`);
  }
  updateCompileStep(sessionId, 'extract', 'done', `${sources.length}/${sources.length} sources extracted`);

  // Step 2: resolve
  updateCompileStep(sessionId, 'resolve', 'running');
  const resolveResult = await callResolve(sessionId);
  const canonicalEntities = resolveResult.canonical_entities;
  updateCompileStep(sessionId, 'resolve', 'done', `${canonicalEntities.length} canonical entities`);

  // Step 3: match — TF-IDF + LLM triage vs existing wiki pages
  updateCompileStep(sessionId, 'match', 'running');
  const matchResult = await callMatch(sessionId, canonicalEntities);
  if (matchResult.skipped) {
    updateCompileStep(sessionId, 'match', 'done', 'First compile — no existing pages');
  } else {
    updateCompileStep(
      sessionId,
      'match',
      'done',
      `${matchResult.stats.updates} updates, ${matchResult.stats.contradictions} contradictions, ${matchResult.stats.skips} skipped`
    );
  }

  // Step 4: plan
  updateCompileStep(sessionId, 'plan', 'running');
  const planResult = await callPlan(sessionId, canonicalEntities, matchResult.matches);
  updateCompileStep(sessionId, 'plan', 'done', `${planResult.stats.total} pages planned`);

  // Step 5: draft
  updateCompileStep(sessionId, 'draft', 'running');
  const draftResult = await callDraft(sessionId);
  updateCompileStep(sessionId, 'draft', 'done', `${draftResult.drafted} drafts generated`);

  // Step 6: crossref
  updateCompileStep(sessionId, 'crossref', 'running');
  const crossrefResult = await callCrossref(sessionId);
  updateCompileStep(sessionId, 'crossref', 'done', `${crossrefResult.wikilinks_added} wikilinks added`);

  // Step 7: commit
  updateCompileStep(sessionId, 'commit', 'running');
  const commitResult = await callCommit(sessionId);
  updateCompileStep(sessionId, 'commit', 'done', `${commitResult.committed} pages committed`);

  // Step 8: schema — always call, schema route handles already_exists internally
  updateCompileStep(sessionId, 'schema', 'running');
  await callSchema(sessionId);
  updateCompileStep(sessionId, 'schema', 'done');

  completeCompileProgress(sessionId);
}

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const { session_id } = rawBody as { session_id?: string };
  if (!session_id?.trim()) return NextResponse.json({ error: 'session_id required' }, { status: 400 });

  const progress = getCompileProgress(session_id);
  if (!progress) return NextResponse.json({ error: 'no_progress_record' }, { status: 404 });
  if (progress.status === 'completed') return NextResponse.json({ session_id, status: 'already_completed' });

  // Fire and forget — return immediately so n8n doesn't timeout
  runCompilePipeline(session_id).catch((err: unknown) => {
    failCompileProgress(session_id, err instanceof Error ? err.message : String(err));
  });

  return NextResponse.json({ session_id, status: 'started' });
}
