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
  getExtractionsBySession,
  getStagingBySession,
  countPagePlansByStatus,
  getDb,
  logActivity,
  markStaleSessionsFailed,
} from '@/lib/db';
import { runHealthCheckStep } from '@/lib/compile/steps/health-check';
import { runIngestFilesStep } from '@/lib/compile/steps/ingest-files';
import { runIngestUrlsStep } from '@/lib/compile/steps/ingest-urls';
import { runIngestTextsStep } from '@/lib/compile/steps/ingest-texts';
import { sanitizeLogValue } from '@/lib/log-safe';
import { LONG_HTTP_AGENT } from '@/lib/long-http-agent';

const APP_URL = process.env.APP_URL ?? 'http://app:3000';

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
  console.error('[compile:%s] %s HTTP %d', sanitizeLogValue(sessionId), step, res.status);
  throw new Error(`${step} failed: ${res.status}${snippet ? ` — ${snippet}` : ''}`);
}

async function callExtract(sourceId: string, sessionId: string): Promise<void> {
  const res = await fetch(`${APP_URL}/api/compile/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id: sourceId }),
    // 1500s = NER (360s, sequential) + route (10s) + keyphrase/tfidf parallel (360s longest) + extract LLM (600s) + ~170s handler+I/O headroom.
    // Inner NLP sub-call ceilings raised from 60s → 360s after session e2c8a59d (13 academic PDFs) failed all 13 sources twice on 60s NER timeouts under EXTRACT_CONCURRENCY=4 contention; outer wrapper had to grow to match.
    signal: AbortSignal.timeout(1_500_000),
    // LONG_HTTP_AGENT (16-min headersTimeout) — needed since the 360s NLP +
    // 600s LLM bumps push per-source extract past undici's default 300s
    // headersTimeout. Session 29be62eb hit `[cause] HeadersTimeoutError`
    // here before the AbortSignal ever fired. Comment above LONG_HTTP_AGENT
    // initially excluded extract as "short" — no longer true on dense PDFs.
    // @ts-expect-error — dispatcher is an undici-specific fetch option not in the DOM RequestInit type
    dispatcher: LONG_HTTP_AGENT,
  });
  await throwOnError('extract', res, sessionId);
}

async function callResolve(sessionId: string): Promise<{ canonical_entities: unknown[]; canonical_concepts: unknown[] }> {
  const res = await fetch(`${APP_URL}/api/compile/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    // 900s = callFuzzy 60s + callEmbedding 60s + callDisambiguate 600s + 180s
    // headroom. Prior 660s was 60s short of the worst-case sequential sum once
    // every sub-call hit its individual ceiling. In practice fuzzy+embedding
    // finish in seconds, but the AbortSignal needs to fit the math.
    signal: AbortSignal.timeout(900_000),
    // @ts-expect-error — dispatcher is an undici-specific fetch option not in the DOM RequestInit type
    dispatcher: LONG_HTTP_AGENT, // 900s AbortSignal > undici 300s default headersTimeout
  });
  await throwOnError('resolve', res, sessionId);
  const parsed = await res.json() as { canonical_entities?: unknown[]; canonical_concepts?: unknown[] };
  return {
    canonical_entities: parsed.canonical_entities ?? [],
    canonical_concepts: parsed.canonical_concepts ?? [],
  };
}

async function callMatch(
  sessionId: string,
  canonicalEntities: unknown[]
): Promise<{ skipped: boolean; matches: unknown[]; stats: Record<string, number> }> {
  const res = await fetch(`${APP_URL}/api/compile/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, canonical_entities: canonicalEntities }),
    // 1200s = sequential `for source` at match/route.ts:137 × (callTfidfOverlap
    // 30s + callTriage 30s) per candidate page. The 300s budget never matched
    // the actual N×M call cost (N sources × M candidate pages); for N=19
    // sources × 3 candidates × 30s worst-case AbortSignal = 2280s. 1200s
    // defensively covers the realistic case (triage usually <5s) and matches
    // commit/draft scale.
    signal: AbortSignal.timeout(1_200_000),
  });
  await throwOnError('match', res, sessionId);
  return res.json() as Promise<{ skipped: boolean; matches: unknown[]; stats: Record<string, number> }>;
}

async function callPlan(
  sessionId: string,
  canonicalEntities: unknown[],
  canonicalConcepts: unknown[],
  matches: unknown[]
): Promise<{ stats: { total: number } }> {
  const res = await fetch(`${APP_URL}/api/compile/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      canonical_entities: canonicalEntities,
      canonical_concepts: canonicalConcepts,
      matches,
    }),
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
    // 1500s = pLimit(N plans, DRAFT_CONCURRENCY=10) × inner callDraftPage 600s.
    // For N=19 plans (~2 batches × ~600s = ~1200s) plus headroom. Prior 900s
    // fired at 14m 59.9s on session d28d7644 even though all 19 drafts had
    // succeeded server-side; outer killed the fetch before the inner JSON
    // response landed. Matches callExtract's outer for symmetry.
    signal: AbortSignal.timeout(1_500_000),
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

async function callCommit(sessionId: string): Promise<{ committed: number; thin_drafts_skipped: number; sources_activated: number }> {
  const res = await fetch(`${APP_URL}/api/compile/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    // 1200s = sequential `for plan` at commit/route.ts:124 × (DB tx + write-page
    // 30s + vector-upsert 30s) per plan. Prior 120s fit only the trivial case
    // (~3 plans); for N=19 plans worst case sums to ~20 min. 1200s defensively
    // covers cases where any plan's file or vector call slows down — realistic
    // case finishes in <2s/plan.
    signal: AbortSignal.timeout(1_200_000),
  });
  await throwOnError('commit', res, sessionId);
  return res.json() as Promise<{ committed: number; thin_drafts_skipped: number; sources_activated: number }>;
}

async function callSchema(sessionId: string): Promise<unknown> {
  const res = await fetch(`${APP_URL}/api/compile/schema`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    // 720s = file-exists 10s + generate-schema LLM 600s + write-file 10s +
    // 100s headroom. Prior 660s gave only 40s margin once both file-IO sub-
    // calls bracketing the LLM were accounted for; on a slow disk + max LLM
    // run that would have fired before the response landed.
    signal: AbortSignal.timeout(720_000),
    // @ts-expect-error — dispatcher is an undici-specific fetch option not in the DOM RequestInit type
    dispatcher: LONG_HTTP_AGENT, // 720s AbortSignal > undici 300s default headersTimeout
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
  console.log('[compile:%s] %s %dms', sanitizeLogValue(sessionId), step, Date.now() - t);
  return r;
}

async function runCompilePipeline(sessionId: string): Promise<void> {
  assertNotCancelled(sessionId);

  // ── Prelude (v18 onboarding v2 staging flow) ───────────────────────────
  // Only runs when the session has collect_staging rows. Legacy sessions
  // (pre-v18 /confirm) + source-recompile flows hit the else-branch which
  // marks the 4 prelude steps done-but-skipped. Critical: without that,
  // resetForRetry() would walk COMPILE_STEP_KEYS, hit the 'pending' prelude
  // as first non-done, and reset all downstream compile steps — wiping
  // already-done extract/draft/commit on any legacy retry.
  const staged = getStagingBySession(sessionId).filter(
    (s) => s.included && s.status === 'pending'
  );

  if (staged.length > 0) {
    const fileItems = staged.filter((s) => s.connector === 'file-upload');
    const urlItems = staged.filter((s) => s.connector === 'url');
    const textItems = staged.filter(
      (s) =>
        s.connector === 'text' ||
        s.connector === 'saved-link' ||
        s.connector === 'paste'
    );

    await timed(sessionId, 'health_check', () =>
      runHealthCheckStep(sessionId, urlItems.length > 0)
    );
    assertNotCancelled(sessionId);

    await timed(sessionId, 'ingest_files', () =>
      runIngestFilesStep(sessionId, fileItems, assertNotCancelled)
    );
    assertNotCancelled(sessionId);

    await timed(sessionId, 'ingest_urls', () =>
      runIngestUrlsStep(sessionId, urlItems, assertNotCancelled)
    );
    assertNotCancelled(sessionId);

    await timed(sessionId, 'ingest_texts', () =>
      runIngestTextsStep(sessionId, textItems, assertNotCancelled)
    );
    assertNotCancelled(sessionId);
  } else {
    // No staging rows → legacy flow. Mark prelude steps 'done (skipped)'
    // so resetForRetry treats them as completed and retries from the first
    // non-done compile step instead of wiping everything.
    updateCompileStep(sessionId, 'health_check', 'done', 'skipped (legacy session)');
    updateCompileStep(sessionId, 'ingest_files', 'done', 'skipped (no items)');
    updateCompileStep(sessionId, 'ingest_urls', 'done', 'skipped (no items)');
    updateCompileStep(sessionId, 'ingest_texts', 'done', 'skipped (no items)');
  }

  // Saved-link-only sessions: every staged item was a media-only tweet
  // (connector='saved-link'), so the prelude wrote ingest_failures rows but
  // no `sources`. Extract..schema have nothing to compile — short-circuit to
  // success with every downstream step marked skipped so the UI shows the
  // session as completed (not failed) and the Saved Links page reflects the
  // captured URLs.
  const preludeSources = getSourcesBySession(sessionId);
  if (preludeSources.length === 0) {
    const skippedDetail = 'skipped (no sources)';
    updateCompileStep(sessionId, 'extract',  'done', skippedDetail);
    updateCompileStep(sessionId, 'resolve',  'done', skippedDetail);
    updateCompileStep(sessionId, 'match',    'done', skippedDetail);
    updateCompileStep(sessionId, 'plan',     'done', skippedDetail);
    updateCompileStep(sessionId, 'draft',    'done', skippedDetail);
    updateCompileStep(sessionId, 'crossref', 'done', skippedDetail);
    updateCompileStep(sessionId, 'commit',   'done', skippedDetail);
    updateCompileStep(sessionId, 'schema',   'done', skippedDetail);
    completeCompileProgress(sessionId);
    return;
  }

  // Step 1: extract. State is derived from the DB (extractions table), not
  // from compile_progress.steps, so a prior partial failure (e.g. Gemini 429
  // on half the sources) is resumable: on retry we only re-attempt the
  // sources that are still missing from extractions. /api/compile/extract is
  // idempotent — a source that IS already extracted short-circuits without a
  // new Gemini call — but we skip the HTTP round-trip by filtering here.
  const sources = preludeSources;
  const extractedIds = new Set(getExtractionsBySession(sessionId).map((e) => e.source_id));
  const unextracted = sources.filter((s) => !extractedIds.has(s.source_id));

  if (sources.length > 0 && unextracted.length === 0) {
    updateCompileStep(sessionId, 'extract', 'done', `${sources.length}/${sources.length} sources extracted`);
  } else {
    updateCompileStep(sessionId, 'extract', 'running');
    let extractSucceeded = sources.length - unextracted.length;
    let extractFailed = 0;

    // Parallel extract: each call is 30-400s on DeepSeek (provider-side
    // generation latency), and we use <1% of the tier RPM cap. Sequential
    // for...of made wall-clock = N × 250s; concurrency=4 cuts that 4×.
    //
    // Concurrency knob: process.env.EXTRACT_CONCURRENCY (default 4). Higher
    // = faster wall-clock, more in-flight memory + more risk of the daily $
    // cap firing in a burst. 4 is conservative — Tier 1 RPM allows 800/min;
    // 4 concurrent calls × ~0.25 RPS each = 1 RPS, plenty of headroom.
    //
    // JS single-threaded ⇒ extractSucceeded/extractFailed/queue.shift()
    // are race-free without a lock. better-sqlite3 + WAL serializes the
    // updateCompileStep writes; same for logActivity.
    const EXTRACT_CONCURRENCY = Math.max(
      1,
      parseInt(process.env.EXTRACT_CONCURRENCY ?? '4', 10) || 4,
    );
    const queue = [...unextracted];
    let cancelled = false;

    async function extractWorker(): Promise<void> {
      while (queue.length > 0 && !cancelled) {
        const src = queue.shift();
        if (!src) return;
        try {
          // Cancel check inside the worker so an in-flight extract finishes
          // its current call but no new ones start.
          assertNotCancelled(sessionId);
        } catch {
          cancelled = true;
          return;
        }
        try {
          await callExtract(src.source_id, sessionId);
          extractSucceeded++;
        } catch (err) {
          extractFailed++;
          logActivity('extraction_failed', {
            source_id: src.source_id,
            session_id: sessionId,
            step_key: 'extract',
            details: { title: src.title, error: err instanceof Error ? err.message : String(err) },
          });
        }
        // Progress update after every completion (success or fail). Counter
        // is JS-int-atomic; concurrent writes to compile_progress.steps land
        // in WAL serially. Last-write-wins on the detail string is fine —
        // each writer has the same source-of-truth (succeeded count).
        updateCompileStep(
          sessionId,
          'extract',
          'running',
          `${extractSucceeded}/${sources.length} sources extracted`,
        );
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(EXTRACT_CONCURRENCY, unextracted.length) }, () =>
        extractWorker(),
      ),
    );

    if (cancelled) {
      // Cancellation already wrote the cancelled status via cancel route;
      // bail out without overwriting the step state.
      assertNotCancelled(sessionId);
    }
    if (extractSucceeded === 0) {
      updateCompileStep(sessionId, 'extract', 'failed', `0/${sources.length} sources extracted`);
      failCompileProgress(sessionId, 'All sources failed extraction');
      return;
    }
    const detail =
      extractFailed > 0
        ? `${extractSucceeded}/${sources.length} sources extracted (${extractFailed} failed)`
        : `${extractSucceeded}/${sources.length} sources extracted`;
    updateCompileStep(sessionId, 'extract', 'done', detail);
  }
  assertNotCancelled(sessionId);

  // Step 2: resolve — ALWAYS re-run (cheap: reads extractions table directly).
  updateCompileStep(sessionId, 'resolve', 'running');
  const resolveResult = await timed(sessionId, 'resolve', () => callResolve(sessionId));
  const canonicalEntities = resolveResult.canonical_entities;
  const canonicalConcepts = resolveResult.canonical_concepts;
  updateCompileStep(
    sessionId,
    'resolve',
    'done',
    `${canonicalEntities.length} entities, ${canonicalConcepts.length} concepts`
  );
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
  // exist — EXCEPT when extracted sources extend beyond the existing plan set
  // (hasNewSources below). The /retry-failed path can land new extractions on
  // a session whose prior plan run only saw a smaller extraction set; in that
  // case we MUST re-run plan so the newly-extracted sources get pages, even
  // though committed plans already exist. clearStagedPagePlans only deletes
  // non-committed plans, so the prior committed pages are preserved.
  // Once plans exist (and no new sources), draft is responsible for picking
  // up any rows still in 'planned' or 'failed' (see /api/compile/draft filter).
  const planCounts = countPagePlansByStatus(sessionId);
  const planExists =
    Object.values(planCounts).reduce((sum, c) => sum + c, 0) > 0;
  const pendingDraftCount = (planCounts.planned ?? 0) + (planCounts.failed ?? 0);

  // hasNewSources: extractions exist that no plan references. Triggers
  // re-plan even when committed plans are present — the partial-extract
  // retry path lands new extractions on a session whose prior plan run
  // happened against a smaller extraction set, and we need plan to
  // rebuild over the full set so the new sources produce pages.
  // Cheap query: page_plans.source_ids is JSON, parsed once per row.
  const allExtractedIds = new Set(
    getExtractionsBySession(sessionId).map((e) => e.source_id),
  );
  const planSourceIds = new Set<string>();
  for (const r of getDb()
    .prepare('SELECT source_ids FROM page_plans WHERE session_id = ?')
    .all(sessionId) as Array<{ source_ids: string }>) {
    try {
      (JSON.parse(r.source_ids) as string[]).forEach((id) => planSourceIds.add(id));
    } catch {
      // malformed source_ids — the malformed plan will fail downstream;
      // skip it for this coverage check
    }
  }
  const hasNewSources = [...allExtractedIds].some((id) => !planSourceIds.has(id));

  if (!planExists || hasNewSources) {
    // Fresh run: plan then draft.
    updateCompileStep(sessionId, 'plan', 'running');
    const planResult = await timed(sessionId, 'plan', () =>
      callPlan(sessionId, canonicalEntities, canonicalConcepts, matchResult.matches)
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
    console.log('[compile:%s] %d plans pending — re-drafting without re-planning', sanitizeLogValue(sessionId), pendingDraftCount);
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
    console.log('[compile:%s] plan+draft already complete — skipping both', sanitizeLogValue(sessionId));
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
  updateCompileStep(sessionId, 'commit', 'done', `${commitResult.committed} pages, ${commitResult.sources_activated} sources committed${thinMsg}`);

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
    // Per-session adaptive cleanup (60 min floor + 6 min/source) — see
    // markStaleSessionsFailed in lib/db.ts. This call is idempotent: only
    // sessions that have exceeded their personal threshold get marked failed.
    markStaleSessionsFailed();
    const refreshed = getCompileProgress(session_id);
    if (refreshed?.status === 'running') {
      return NextResponse.json({ error: 'already_running' }, { status: 409 });
    }
    // Fell through: it was stale and is now 'failed' — fall through to start fresh
  }

  // Fire and forget — return immediately so n8n doesn't timeout
  runCompilePipeline(session_id).catch((err: unknown) => {
    if (err instanceof CompileCancelledError) {
      console.log('[compile:%s] cancelled by user — pipeline exited cleanly', sanitizeLogValue(session_id));
      return;
    }
    console.error('[compile:%s] pipeline error:', sanitizeLogValue(session_id), err);
    failCompileProgress(session_id, err instanceof Error ? err.message : String(err));
  });

  return NextResponse.json({ session_id, status: 'started' });
}
