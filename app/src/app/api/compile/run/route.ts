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
import { Agent } from 'undici';

import {
  getCompileProgress,
  updateCompileStep,
  completeCompileProgress,
  failCompileProgress,
  getSourcesBySession,
  getExtractionsBySession,
  countPagePlansByStatus,
  insertActivity,
  markStaleSessionsFailed,
} from '@/lib/db';

const APP_URL = process.env.APP_URL ?? 'http://app:3000';

// Node's built-in fetch (undici) defaults headersTimeout=300_000 ms — shorter
// than the 600-900 s AbortSignal we set on long LLM steps (draft, crossref),
// so HeadersTimeoutError fires before our AbortSignal ever kicks in. Scoped
// Agent with a 16-min headersTimeout/bodyTimeout matches the longest step's
// deadline plus buffer. Only applied to the steps that genuinely need >5 min;
// keeping other calls on the default Agent preserves fail-fast behavior for
// the short paths (extract, resolve, match, plan, commit, schema).
// Ref: https://nodejs.org/api/globals.html#custom-dispatcher
const LONG_HTTP_AGENT = new Agent({
  headersTimeout: 16 * 60_000,
  bodyTimeout: 16 * 60_000,
  connectTimeout: 10_000,
  keepAliveTimeout: 60_000,
});

// Shared error surfacer. On !res.ok, read the response body (race-capped at
// 3 s so a hung chunked response doesn't stall the orchestrator) and embed
// the first 2 000 chars into the thrown Error message so failCompileProgress
// stores the actual cause in compile_progress.error — visible in the UI
// banner and in activity feed extract-failure rows (no more raw UUID noise).
// Stack-trace logging is owned by each sub-route's own catch block; this
// side only writes a short marker line to keep logs non-duplicative.
async function throwOnError(
  step: string,
  res: Response,
  sessionId: string
): Promise<void> {
  if (res.ok) return;
  const body = await Promise.race<string>([
    res.text().catch(() => ''),
    new Promise<string>((resolve) => setTimeout(() => resolve('<body read timed out>'), 3000)),
  ]);
  const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 2000);
  console.error(`[compile:${sessionId}] ${step} HTTP ${res.status}`);
  throw new Error(`${step} failed: ${res.status}${snippet ? ` — ${snippet}` : ''}`);
}

async function callExtract(sourceId: string, sessionId: string): Promise<void> {
  const res = await fetch(`${APP_URL}/api/compile/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id: sourceId }),
    signal: AbortSignal.timeout(180_000),
  });
  await throwOnError('extract', res, sessionId);
}

async function callResolve(sessionId: string): Promise<{ canonical_entities: unknown[] }> {
  const res = await fetch(`${APP_URL}/api/compile/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(180_000),
  });
  await throwOnError('resolve', res, sessionId);
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
  await throwOnError('match', res, sessionId);
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
  await throwOnError('plan', res, sessionId);
  return res.json() as Promise<{ stats: { total: number } }>;
}

async function callDraft(sessionId: string): Promise<{ drafted: number; failed: number }> {
  const res = await fetch(`${APP_URL}/api/compile/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(900_000),
    // @ts-expect-error — dispatcher is an undici-specific fetch option not in the DOM RequestInit type
    dispatcher: LONG_HTTP_AGENT,
  });
  await throwOnError('draft', res, sessionId);
  return res.json() as Promise<{ drafted: number; failed: number }>;
}

async function callCrossref(sessionId: string): Promise<{ wikilinks_added: number }> {
  const res = await fetch(`${APP_URL}/api/compile/crossref`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(600_000),
    // @ts-expect-error — dispatcher is an undici-specific fetch option not in the DOM RequestInit type
    dispatcher: LONG_HTTP_AGENT,
  });
  await throwOnError('crossref', res, sessionId);
  return res.json() as Promise<{ wikilinks_added: number }>;
}

async function callCommit(sessionId: string): Promise<{ committed: number; thin_drafts_skipped: number }> {
  const res = await fetch(`${APP_URL}/api/compile/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(120_000),
  });
  await throwOnError('commit', res, sessionId);
  return res.json() as Promise<{ committed: number; thin_drafts_skipped: number }>;
}

async function callSchema(sessionId: string): Promise<unknown> {
  const res = await fetch(`${APP_URL}/api/compile/schema`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(120_000),
  });
  await throwOnError('schema', res, sessionId);
  return res.json();
}

class CompileCancelledError extends Error {
  constructor() {
    super('Cancelled by user');
    this.name = 'CompileCancelledError';
  }
}

function assertNotCancelled(sessionId: string): void {
  const p = getCompileProgress(sessionId);
  if (p?.status === 'cancelled') throw new CompileCancelledError();
}

// Log step-done timing on success so cold-start latency (first-call spaCy /
// sentence-transformer lazy load in nlp-service, better-sqlite3 WAL warm-up)
// shows up clearly. On failure the caller throws and the top-level .catch in
// POST owns the error line — no duplicate logging here.
async function timed<T>(sessionId: string, step: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  const r = await fn();
  console.log(`[compile:${sessionId}] ${step} ${Date.now() - t}ms`);
  return r;
}

async function runCompilePipeline(sessionId: string): Promise<void> {
  assertNotCancelled(sessionId);

  // Step 1: extract. State is derived from the DB (extractions table), not
  // from compile_progress.steps, so a prior partial failure (e.g. Gemini 429
  // on half the sources) is resumable: on retry we only re-attempt the
  // sources that are still missing from extractions. /api/compile/extract is
  // idempotent — a source that IS already extracted short-circuits without a
  // new Gemini call — but we skip the HTTP round-trip by filtering here.
  const sources = getSourcesBySession(sessionId);
  const extractedIds = new Set(getExtractionsBySession(sessionId).map((e) => e.source_id));
  const unextracted = sources.filter((s) => !extractedIds.has(s.source_id));

  if (sources.length > 0 && unextracted.length === 0) {
    updateCompileStep(sessionId, 'extract', 'done', `${sources.length}/${sources.length} sources extracted`);
  } else {
    updateCompileStep(sessionId, 'extract', 'running');
    let extractSucceeded = sources.length - unextracted.length;
    for (const src of unextracted) {
      try {
        await callExtract(src.source_id, sessionId);
        extractSucceeded++;
      } catch (err) {
        insertActivity({
          action_type: 'extraction_failed',
          source_id: src.source_id,
          details: { error: err instanceof Error ? err.message : String(err) },
        });
      }
      updateCompileStep(
        sessionId,
        'extract',
        'running',
        `${extractSucceeded}/${sources.length} sources extracted`
      );
    }
    if (extractSucceeded === 0) {
      updateCompileStep(sessionId, 'extract', 'failed', `0/${sources.length} sources extracted`);
      failCompileProgress(sessionId, 'All sources failed extraction');
      return;
    }
    updateCompileStep(sessionId, 'extract', 'done', `${extractSucceeded}/${sources.length} sources extracted`);
  }
  assertNotCancelled(sessionId);

  // Step 2: resolve — ALWAYS re-run (cheap: reads extractions table directly).
  updateCompileStep(sessionId, 'resolve', 'running');
  const resolveResult = await timed(sessionId, 'resolve', () => callResolve(sessionId));
  const canonicalEntities = resolveResult.canonical_entities;
  updateCompileStep(sessionId, 'resolve', 'done', `${canonicalEntities.length} canonical entities`);
  assertNotCancelled(sessionId);

  // Step 3: match — ALWAYS re-run (cheap: TF-IDF, no LLM unless triage).
  updateCompileStep(sessionId, 'match', 'running');
  const matchResult = await timed(sessionId, 'match', () => callMatch(sessionId, canonicalEntities));
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
  assertNotCancelled(sessionId);

  // Steps 4+5: plan + draft. State is derived from the page_plans table, not
  // compile_progress.steps, so per-plan failures (e.g. Gemini 429 mid-batch)
  // are resumable without losing already-drafted siblings.
  //
  // plan calls clearStagedPagePlans() which deletes all non-committed rows
  // (including 'drafted'/'crossreffed'). So plan must NOT re-run once plans
  // exist. Once plans exist, draft is responsible for picking up any rows
  // still in 'planned' or 'failed' (see /api/compile/draft filter).
  const planCounts = countPagePlansByStatus(sessionId);
  const planExists =
    Object.values(planCounts).reduce((sum, c) => sum + c, 0) > 0;
  const pendingDraftCount = (planCounts.planned ?? 0) + (planCounts.failed ?? 0);

  if (!planExists) {
    // Fresh run: plan then draft.
    updateCompileStep(sessionId, 'plan', 'running');
    const planResult = await timed(sessionId, 'plan', () =>
      callPlan(sessionId, canonicalEntities, matchResult.matches)
    );
    updateCompileStep(sessionId, 'plan', 'done', `${planResult.stats.total} pages planned`);
    assertNotCancelled(sessionId);

    updateCompileStep(sessionId, 'draft', 'running');
    const draftResult = await timed(sessionId, 'draft', () => callDraft(sessionId));
    updateCompileStep(
      sessionId,
      'draft',
      'done',
      draftResult.failed > 0
        ? `${draftResult.drafted} drafts generated, ${draftResult.failed} failed — retry to re-attempt`
        : `${draftResult.drafted} drafts generated`
    );
    assertNotCancelled(sessionId);
  } else if (pendingDraftCount > 0) {
    // Retry path: plans exist, some are still 'planned' or were marked
    // 'failed' on a prior Gemini error. Re-draft only those.
    console.log(`[compile:${sessionId}] ${pendingDraftCount} plans pending — re-drafting without re-planning`);
    updateCompileStep(sessionId, 'draft', 'running');
    const draftResult = await timed(sessionId, 'draft', () => callDraft(sessionId));
    updateCompileStep(
      sessionId,
      'draft',
      'done',
      draftResult.failed > 0
        ? `${draftResult.drafted} drafts generated, ${draftResult.failed} failed — retry to re-attempt`
        : `${draftResult.drafted} drafts generated`
    );
    assertNotCancelled(sessionId);
  } else {
    console.log(`[compile:${sessionId}] plan+draft already complete — skipping both`);
  }

  // Step 6: crossref — ALWAYS re-run.
  // Reads page_plans WHERE draft_status='drafted'. If draft was skipped and
  // plans are already 'crossreffed' (commit-failure retry), this returns 0
  // wikilinks as a safe no-op — plans stay 'crossreffed' for commit to consume.
  updateCompileStep(sessionId, 'crossref', 'running');
  const crossrefResult = await timed(sessionId, 'crossref', () => callCrossref(sessionId));
  updateCompileStep(sessionId, 'crossref', 'done', `${crossrefResult.wikilinks_added} wikilinks added`);
  assertNotCancelled(sessionId);

  // Step 7: commit — ALWAYS re-run (no LLM, DB + disk writes, idempotent).
  // Pass 5 is a synchronous better-sqlite3 transaction — cancel is blocked at
  // the route level once this step is 'running'. No mid-transaction abort.
  updateCompileStep(sessionId, 'commit', 'running');
  const commitResult = await timed(sessionId, 'commit', () => callCommit(sessionId));
  const thinMsg = commitResult.thin_drafts_skipped > 0 ? `, ${commitResult.thin_drafts_skipped} thin drafts skipped` : '';
  updateCompileStep(sessionId, 'commit', 'done', `${commitResult.committed} pages committed${thinMsg}`);

  // Step 8: schema — ALWAYS re-run (idempotent, schema route handles already_exists).
  updateCompileStep(sessionId, 'schema', 'running');
  await timed(sessionId, 'schema', () => callSchema(sessionId));
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
  if (progress.status === 'completed') return NextResponse.json({ session_id, status: 'already_completed' }, { status: 409 });

  if (progress.status === 'running') {
    // Dynamic stale timeout: 60 min floor + 2 min per source.
    // 5 sources → 60 min, 50 sources → 100 min, 100 sources → 200 min.
    const sessionSources = getSourcesBySession(session_id);
    const staleMinutes = Math.max(60, sessionSources.length * 2);
    markStaleSessionsFailed(staleMinutes);
    const refreshed = getCompileProgress(session_id);
    if (refreshed?.status === 'running') {
      return NextResponse.json({ error: 'already_running' }, { status: 409 });
    }
    // Fell through: it was stale and is now 'failed' — fall through to start fresh
  }

  // Fire and forget — return immediately so n8n doesn't timeout
  runCompilePipeline(session_id).catch((err: unknown) => {
    if (err instanceof CompileCancelledError) {
      console.log(`[compile:${session_id}] cancelled by user — pipeline exited cleanly`);
      return;
    }
    console.error(`[compile:${session_id}] pipeline error:`, err);
    failCompileProgress(session_id, err instanceof Error ? err.message : String(err));
  });

  return NextResponse.json({ session_id, status: 'started' });
}
