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
 *   3. match    — POST /api/compile/match (LLM triage vs existing pages)
 *   4. plan     — POST /api/compile/plan
 *   5. draft    — POST /api/compile/draft  (up to 15 min, Gemini calls)
 *   6. crossref — POST /api/compile/crossref
 *   6b. labels  — merge duplicate category labels in the drafts (in process)
 *   7. commit   — POST /api/compile/commit
 *   8. schema   — POST /api/compile/schema (schema.md bootstrap)
 *   9. claims   — claim check of the new sources (in process; flag, off by default)
 */

import { NextResponse } from 'next/server';

import {
  claimCompileRun,
  getSourcesBySession,
  getExtractionsBySession,
  getStagingBySession,
  countPagePlansByStatus,
  getDb,
  logActivity,
} from '@/lib/db';
import { CompileCancelledError, CompileRun, CompileSupersededError } from '@/lib/compile/compile-run';
import { describePromptCuts, type PlanPromptCut } from '@/lib/compile/draft-sources';
import { runHealthCheckStep } from '@/lib/compile/steps/health-check';
import { runIngestFilesStep } from '@/lib/compile/steps/ingest-files';
import { runIngestUrlsStep } from '@/lib/compile/steps/ingest-urls';
import { runIngestTextsStep } from '@/lib/compile/steps/ingest-texts';
import { failIfNothingIngested } from '@/lib/compile/steps/ingest-outcome';
import { runClaimsStep, skipClaimsStepIfOff } from '@/lib/compile/steps/claims';
import { runLabelsStep } from '@/lib/compile/steps/labels';
import { sanitizeLogValue } from '@/lib/log-safe';
import { LONG_HTTP_AGENT, makeDispatcher } from '@/lib/long-http-agent';
import { MAX_TRIAGE_CANDIDATES_PER_SOURCE } from '@/lib/triage-candidates';
import { MAX_TRIAGE_RECHECKS_PER_COMPILE, clearSessionRecheckVerdicts } from '@/lib/triage-rechecks';
import {
  computeResolveMs,
  computeMatchMs,
  computeDraftMs,
  computeCrossrefMs,
  computeCommitMs,
} from '@/lib/compile-timeouts';

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
    // 1800s = NER (360s, sequential) + route (10s) + keyphrase/tfidf parallel (360s longest) + extract LLM (900s) + ~170s handler+I/O headroom.
    // Inner NLP sub-call ceilings raised from 60s → 360s after session e2c8a59d (13 academic PDFs) failed all 13 sources twice on 60s NER timeouts under EXTRACT_CONCURRENCY=4 contention; outer wrapper had to grow to match.
    signal: AbortSignal.timeout(1_800_000),
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

async function callResolve(sessionId: string, sourceCount: number): Promise<{ canonical_entities: unknown[]; canonical_concepts: unknown[] }> {
  // Dynamic timeout sized to sourceCount (proxy for disambiguate-batch count).
  // See lib/compile-timeouts.ts:computeResolveMs for the formula. Replaces the
  // static 900s constant from PR #71 — that was a ticking bomb at N+1.
  const timeoutMs = computeResolveMs(sourceCount);
  const res = await fetch(`${APP_URL}/api/compile/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(timeoutMs),
    // @ts-expect-error — dispatcher is an undici-specific fetch option not in the DOM RequestInit type
    dispatcher: makeDispatcher(timeoutMs),
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
  canonicalEntities: unknown[],
  sourceCount: number,
  willPlan: boolean,
): Promise<{ skipped: boolean; matches: unknown[]; stats: Record<string, number> }> {
  // Dynamic timeout sized to sourceCount × the per-source triage cap
  // (lib/triage-candidates.ts), plus the re-check cap when match may
  // re-check stored triage failures. See compile-timeouts.ts:computeMatchMs.
  const timeoutMs = computeMatchMs(
    sourceCount,
    MAX_TRIAGE_CANDIDATES_PER_SOURCE,
    willPlan ? MAX_TRIAGE_RECHECKS_PER_COMPILE : 0,
  );
  const res = await fetch(`${APP_URL}/api/compile/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, canonical_entities: canonicalEntities, will_plan: willPlan }),
    signal: AbortSignal.timeout(timeoutMs),
    // @ts-expect-error — dispatcher is an undici-specific fetch option not in the DOM RequestInit type
    dispatcher: makeDispatcher(timeoutMs),
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

async function callDraft(
  sessionId: string,
  planCount: number,
): Promise<{ drafted: number; failed: number; prompt_cuts?: PlanPromptCut[] }> {
  // Dynamic timeout sized to planCount / DRAFT_CONCURRENCY batches × inner
  // callDraftPage ceiling. See compile-timeouts.ts:computeDraftMs. Replaces
  // the static 1.5M ms from PR #71 — that fired today at 16m on session
  // 97f58805's 38-plan compile via undici's HeadersTimeoutError, because the
  // static LONG_HTTP_AGENT.headersTimeout (16 min) was the real ceiling.
  const timeoutMs = computeDraftMs(planCount);
  const res = await fetch(`${APP_URL}/api/compile/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(timeoutMs),
    // @ts-expect-error — dispatcher is an undici-specific fetch option not in the DOM RequestInit type
    dispatcher: makeDispatcher(timeoutMs),
  });
  await throwOnError('draft', res, sessionId);
  return res.json() as Promise<{ drafted: number; failed: number; prompt_cuts?: PlanPromptCut[] }>;
}

async function callCrossref(sessionId: string, planCount: number): Promise<{ wikilinks_added: number }> {
  // Dynamic timeout sized to planCount × per-plan wikilink-injection cost.
  // See compile-timeouts.ts:computeCrossrefMs.
  const timeoutMs = computeCrossrefMs(planCount);
  const res = await fetch(`${APP_URL}/api/compile/crossref`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(timeoutMs),
    // @ts-expect-error — dispatcher is an undici-specific fetch option not in the DOM RequestInit type
    dispatcher: makeDispatcher(timeoutMs),
  });
  await throwOnError('crossref', res, sessionId);
  return res.json() as Promise<{ wikilinks_added: number }>;
}

interface CommitResult {
  committed: number;
  failed: number;
  thin_drafts_skipped: number;
  sources_activated: number;
  flush_failures: number;
}

async function callCommit(sessionId: string, planCount: number): Promise<CommitResult> {
  // Dynamic timeout sized to planCount × per-plan (DB tx + write-page +
  // vector-upsert) cost. See compile-timeouts.ts:computeCommitMs.
  const timeoutMs = computeCommitMs(planCount);
  const res = await fetch(`${APP_URL}/api/compile/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(timeoutMs),
    // @ts-expect-error — dispatcher is an undici-specific fetch option not in the DOM RequestInit type
    dispatcher: makeDispatcher(timeoutMs),
  });
  await throwOnError('commit', res, sessionId);
  return res.json() as Promise<CommitResult>;
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

async function runDraftStep(run: CompileRun, planCount: number): Promise<void> {
  const { sessionId } = run;
  run.step('draft', 'running');
  const draftResult = await timed(sessionId, 'draft', () => callDraft(sessionId, planCount));
  const count =
    draftResult.failed > 0
      ? `${draftResult.drafted} drafts generated, ${draftResult.failed} failed — retry to re-attempt`
      : `${draftResult.drafted} drafts generated`;
  // What the prompt budget left out or shortened (lib/compile/draft-sources.ts).
  const cutLine = describePromptCuts(draftResult.prompt_cuts ?? []);
  run.step('draft', 'done', cutLine ? `${count}; ${cutLine}` : count);
  run.assertActive();
}

// Commit gate (CLAUDE.md rule #5): never signal completion while a page is
// missing. Two ways a page can be missing after commit:
//   - flush_failures: DB rows ARE committed (pages remain readable via
//     pending_content + boot reconciler), but the .md.gz file is not on disk.
//   - failed: the page's commit transaction rolled back; the plan is marked
//     'failed' with the cause in page_plans.draft_error.
// Either way the session ends 'failed' so the UI/n8n don't treat it as done.
// Retry recovers: commit always re-runs and its reconcile pass re-flushes,
// and failed plans are re-drafted and committed again.
function assertCommitComplete(run: CompileRun, r: CommitResult): void {
  const problems: string[] = [];
  if (r.failed > 0) problems.push(`${r.failed} page(s) failed to commit`);
  if (r.flush_failures > 0) problems.push(`${r.flush_failures} page file(s) failed to flush to disk`);
  if (problems.length === 0) return;
  run.step(
    'commit',
    'failed',
    `${r.committed} pages committed to DB, but ${problems.join(' and ')} — retry to re-attempt`
  );
  throw new Error(`commit failed: ${problems.join('; ')} (committed pages are durable in the DB; retry re-attempts the rest)`);
}

// Steps 6-9, then completion.
async function finishPipeline(run: CompileRun, planCount: number): Promise<void> {
  const { sessionId } = run;
  // Step 6: crossref — ALWAYS re-run.
  // Reads page_plans WHERE draft_status='drafted'. If draft was skipped and
  // plans are already 'crossreffed' (commit-failure retry), this returns 0
  // wikilinks as a safe no-op — plans stay 'crossreffed' for commit to consume.
  run.step('crossref', 'running');
  const crossrefResult = await timed(sessionId, 'crossref', () => callCrossref(sessionId, planCount));
  run.step('crossref', 'done', `${crossrefResult.wikilinks_added} wikilinks added`);
  run.assertActive();

  // Step 6b: labels — once per session; merges category labels that mean
  // the same thing in the drafts so commit writes each page once with its
  // final label. Never fails the compile (lib/compile/steps/labels.ts).
  await timed(sessionId, 'labels', () => runLabelsStep(run));
  run.assertActive();

  // Step 7: commit — ALWAYS re-run (no LLM, DB + disk writes, idempotent).
  // Pass 5 is a synchronous better-sqlite3 transaction — cancel is blocked at
  // the route level once this step is 'running'. No mid-transaction abort.
  // No await between the boundary above and this write, so a cancel or a
  // discard either stops the run first or sees commit running and is refused.
  run.step('commit', 'running');
  const commitResult = await timed(sessionId, 'commit', () => callCommit(sessionId, planCount));
  assertCommitComplete(run, commitResult);

  const thinMsg = commitResult.thin_drafts_skipped > 0 ? `, ${commitResult.thin_drafts_skipped} thin drafts skipped` : '';
  run.step('commit', 'done', `${commitResult.committed} pages, ${commitResult.sources_activated} sources committed${thinMsg}`);
  // Commit has taken this session's plans, so the stored pairs its re-checks
  // answered are settled and can go (lib/triage-rechecks.ts).
  clearSessionRecheckVerdicts(sessionId);
  // Cancel is refused from here on; this only stops a superseded run before
  // it spends a schema call.
  run.assertActive();

  // Step 8: schema — ALWAYS re-run (idempotent, schema route handles already_exists).
  run.step('schema', 'running');
  await timed(sessionId, 'schema', () => callSchema(sessionId));
  run.step('schema', 'done');

  // Step 9: claims — once per session, behind its flag; checks the new
  // sources' claims now that their pages exist. Never fails the compile
  // (lib/compile/steps/claims.ts).
  await timed(sessionId, 'claims', () => runClaimsStep(run));

  run.complete();
}

// No source of the session still needs compiling. Two kinds of session get here:
//   - saved-link-only sessions: every staged item was a media-only tweet
//     (connector='saved-link'), so the prelude wrote ingest_failures rows but
//     no `sources`;
//   - retries of a session whose sources are already 'active'. Commit marks
//     sources active BEFORE its flush pass, and a source goes active through
//     any one of its plans, so a retry after a flush failure, or a
//     /retry-failed after some drafts failed, lands here with page files or
//     plans still unfinished.
// So "nothing left to do" is decided from page_plans and the outbox, never
// from sources.compile_status: plans still to draft are drafted, and commit
// always runs, because its reconcile pass is what writes the page files an
// earlier run left in pending_content.
async function resumeWithoutSources(run: CompileRun): Promise<void> {
  const { sessionId } = run;
  const skippedDetail = 'skipped (no sources)';
  run.step('extract', 'done', skippedDetail);
  run.step('resolve', 'done', skippedDetail);
  run.step('match',   'done', skippedDetail);
  run.step('plan',    'done', skippedDetail);

  const planCounts = countPagePlansByStatus(sessionId);
  const planCount = Object.values(planCounts).reduce((sum, c) => sum + c, 0);

  if (planCount === 0) {
    // Saved-link-only session: nothing to draft or link, and no page of its
    // own to flush. Commit still runs its reconcile pass.
    run.step('draft',    'done', skippedDetail);
    run.step('crossref', 'done', skippedDetail);
    run.step('labels',   'done', skippedDetail);
    run.assertActive();
    run.step('commit',   'running');
    assertCommitComplete(run, await timed(sessionId, 'commit', () => callCommit(sessionId, 0)));
    clearSessionRecheckVerdicts(sessionId);
    run.step('commit',   'done', skippedDetail);
    run.step('schema',   'done', skippedDetail);
    run.step('claims',   'done', skippedDetail);
    run.complete();
    return;
  }

  const pendingDraftCount = (planCounts.planned ?? 0) + (planCounts.failed ?? 0);
  if (pendingDraftCount > 0) {
    console.log('[compile:%s] %d plans pending, sources already active — re-drafting', sanitizeLogValue(sessionId), pendingDraftCount);
    await runDraftStep(run, planCount);
  } else {
    run.step('draft', 'done', 'skipped (no drafts left to write)');
  }
  await finishPipeline(run, planCount);
}

async function runCompilePipeline(run: CompileRun): Promise<void> {
  const { sessionId } = run;
  // Ingest steps check this before each item and before writing progress.
  const assertActive = () => run.assertActive();
  run.assertActive();
  // The claim check's flag is read once here: off, its step is hidden from
  // the progress page for the whole run.
  skipClaimsStepIfOff(run);

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
    run.assertActive();

    await timed(sessionId, 'ingest_files', () =>
      runIngestFilesStep(sessionId, fileItems, assertActive)
    );
    run.assertActive();

    await timed(sessionId, 'ingest_urls', () =>
      runIngestUrlsStep(sessionId, urlItems, assertActive)
    );
    run.assertActive();

    await timed(sessionId, 'ingest_texts', () =>
      runIngestTextsStep(sessionId, textItems, assertActive)
    );
    run.assertActive();
  } else {
    // No staging rows → legacy flow. Mark prelude steps 'done (skipped)'
    // so resetForRetry treats them as completed and retries from the first
    // non-done compile step instead of wiping everything.
    run.step('health_check', 'done', 'skipped (legacy session)');
    run.step('ingest_files', 'done', 'skipped (no items)');
    run.step('ingest_urls', 'done', 'skipped (no items)');
    run.step('ingest_texts', 'done', 'skipped (no items)');
  }

  // No source left to compile: saved-link-only sessions, and retries of
  // sessions whose sources are already 'active' (see resumeWithoutSources).
  // A session where every staged item failed to import fails here instead.
  const preludeSources = getSourcesBySession(sessionId);
  if (preludeSources.length === 0) {
    if (failIfNothingIngested(run)) return;
    await resumeWithoutSources(run);
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
    run.step('extract', 'done', `${sources.length}/${sources.length} sources extracted`);
  } else {
    run.step('extract', 'running');
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
          run.assertActive();
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
        run.step(
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
      run.assertActive();
    }
    if (extractSucceeded === 0) {
      run.step('extract', 'failed', `0/${sources.length} sources extracted`);
      run.fail('All sources failed extraction');
      return;
    }
    const detail =
      extractFailed > 0
        ? `${extractSucceeded}/${sources.length} sources extracted (${extractFailed} failed)`
        : `${extractSucceeded}/${sources.length} sources extracted`;
    run.step('extract', 'done', detail);
  }
  run.assertActive();

  // sourceCount feeds dynamic-timeout sizing for callResolve and callMatch.
  // Both wrappers compute their outer AbortSignal + per-request undici Agent
  // headersTimeout from this number — keeping the timer ≥ worst-case work
  // even as the source pool grows. See lib/compile-timeouts.ts.
  const sourceCount = sources.length;

  // Step 2: resolve — ALWAYS re-run (cheap: reads extractions table directly).
  run.step('resolve', 'running');
  const resolveResult = await timed(sessionId, 'resolve', () => callResolve(sessionId, sourceCount));
  const canonicalEntities = resolveResult.canonical_entities;
  const canonicalConcepts = resolveResult.canonical_concepts;
  run.step(
    'resolve',
    'done',
    `${canonicalEntities.length} entities, ${canonicalConcepts.length} concepts`
  );
  run.assertActive();

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
  // Decided before match (match writes no plans or extractions) so match
  // knows whether plan will take its answers: only then may it re-check
  // stored triage failures, whose verdicts would otherwise be lost.
  const willPlan = !planExists || hasNewSources;

  // Step 3: match — ALWAYS re-run (cheap: TF-IDF, no LLM unless triage).
  run.step('match', 'running');
  const matchResult = await timed(sessionId, 'match', () =>
    callMatch(sessionId, canonicalEntities, sourceCount, willPlan)
  );
  if (matchResult.skipped) {
    run.step('match', 'done', 'First compile — no existing pages');
  } else {
    // Surface candidates_found + sources_checked so the UI can distinguish
    // "match found 0 candidates above the TF-IDF threshold" from "match
    // acted on N candidates and decided u/c/s on each". Without these counts
    // the prior `0u/0c/0s` rendering looked identical to a bug.
    // triage_failed: candidates whose triage call failed (no decision made).
    // rechecked / recheck_answered / recheck_dropped: stored failures from
    // earlier compiles (lib/compile/triage-recheck.ts).
    // Read defensively: match responses without the fields count as 0.
    const s = matchResult.stats;
    const triageFailed = s.triage_failed ?? 0;
    const rechecked = s.rechecked ?? 0;
    const recheckDropped = s.recheck_dropped ?? 0;
    run.step(
      'match',
      'done',
      `${s.candidates_found} candidates from ${s.sources_checked} sources → ${s.updates}u/${s.contradictions}c/${s.skips}s` +
        (triageFailed > 0 ? ` · ${triageFailed} failed` : '') +
        (rechecked > 0 || recheckDropped > 0
          ? ` · ${rechecked} rechecked, ${s.recheck_answered ?? 0} answered, ${recheckDropped} dropped`
          : '')
    );
  }
  run.assertActive();

  // planCount feeds dynamic-timeout sizing for callDraft / callCrossref /
  // callCommit. Fresh path takes it from callPlan's return; retry-skip path
  // derives it from the existing page_plans row count summed over statuses
  // that downstream steps still operate on (planned + failed for draft;
  // drafted + crossreffed for commit). Set inside the branches below.
  let planCount: number;

  if (willPlan) {
    // Fresh run: plan then draft.
    run.step('plan', 'running');
    const planResult = await timed(sessionId, 'plan', () =>
      callPlan(sessionId, canonicalEntities, canonicalConcepts, matchResult.matches)
    );
    planCount = planResult.stats.total;
    run.step('plan', 'done', `${planCount} pages planned`);
    run.assertActive();

    await runDraftStep(run, planCount);
  } else if (pendingDraftCount > 0) {
    // Retry path: plans exist, some are still 'planned' or were marked
    // 'failed' on a prior Gemini error. Re-draft only those.
    // planCount uses the full row count (Object.values reduce above) so
    // crossref/commit timeouts size to the whole plan set, not just pending.
    planCount = Object.values(planCounts).reduce((sum, c) => sum + c, 0);
    console.log('[compile:%s] %d plans pending — re-drafting without re-planning', sanitizeLogValue(sessionId), pendingDraftCount);
    await runDraftStep(run, planCount);
  } else {
    // No plan work to do; downstream still runs against committed plans, so
    // crossref/commit need a planCount sized to the full plan set.
    planCount = Object.values(planCounts).reduce((sum, c) => sum + c, 0);
    console.log('[compile:%s] plan+draft already complete — skipping both', sanitizeLogValue(sessionId));
  }

  await finishPipeline(run, planCount);
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

  // Run gate: claim the row (status 'running', fresh started_at) and make
  // this run the session's current one, with no await in between. A stale
  // 'running' session is restarted; its old pipeline, if it is still waiting
  // on a call, is superseded and stops at its next step boundary.
  const claim = claimCompileRun(session_id);
  if (!claim.claimed) {
    switch (claim.reason) {
      case 'no_progress_record':
        return NextResponse.json({ error: 'no_progress_record' }, { status: 404 });
      case 'already_completed':
        return NextResponse.json({ session_id, status: 'already_completed' }, { status: 409 });
      case 'session_cancelled':
        return NextResponse.json({ error: 'session_cancelled' }, { status: 409 });
      case 'already_running':
        return NextResponse.json({ error: 'already_running' }, { status: 409 });
    }
  }
  if (claim.restarted) {
    console.log('[compile:%s] stale run past its time limit — restarting', sanitizeLogValue(session_id));
  }
  const run = CompileRun.start(session_id);

  // Fire and forget — return immediately so n8n doesn't timeout
  runCompilePipeline(run)
    .catch((err: unknown) => {
      if (err instanceof CompileCancelledError) {
        console.log('[compile:%s] cancelled by user — pipeline exited cleanly', sanitizeLogValue(session_id));
        return;
      }
      if (err instanceof CompileSupersededError) {
        console.log('[compile:%s] superseded by a restarted run — old pipeline exited', sanitizeLogValue(session_id));
        return;
      }
      console.error('[compile:%s] pipeline error:', sanitizeLogValue(session_id), err);
      run.fail(err instanceof Error ? err.message : String(err));
    })
    .finally(() => run.end());

  return NextResponse.json({ session_id, status: 'started' });
}
