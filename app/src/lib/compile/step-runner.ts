/**
 * Per-item step runner — shared across ingest_urls / ingest_files / ingest_texts
 * pipeline steps. Encodes the "per-item skip, whole-step progress" failure
 * model: one bad URL shouldn't kill the other 199; failed items are logged via
 * an onFailure callback; the step still ends with status='done' showing
 * "47/50 fetched, 3 failed".
 *
 * Shape borrowed from the existing extract + draft loops in
 * /api/compile/run/route.ts (extract) and /api/compile/draft/route.ts
 * (pLimit). This helper formalises the shape so new ingest steps don't need
 * to copy-paste the progress/cancel/failure plumbing.
 */

import type { CompileStepKey } from '../compile-steps';
import { updateCompileStep } from '../db';

export interface PerItemStepOptions<Item> {
  sessionId: string;
  stepKey: CompileStepKey;
  items: Item[];
  /**
   * Concurrency cap. Defaults to 1 (sequential) — safe default for rate-
   * limited upstreams (Firecrawl, Gemini). Ingest-files uses 2 for I/O
   * overlap; ingest-urls uses 5 to stay under Firecrawl's rate-friendly cap.
   */
  concurrency?: number;
  /**
   * Per-item work. Must resolve on success, throw on failure.
   */
  run: (item: Item) => Promise<void>;
  /**
   * Called AFTER each failure. Used by ingest steps to write
   * insertIngestFailure / markStagingFailed rows. Must not throw — if it
   * does, the step continues but the error is swallowed into the failed
   * count to avoid derailing the rest of the batch.
   */
  onFailure?: (item: Item, error: Error) => void | Promise<void>;
  /**
   * Build the detail string for compile_progress.steps[stepKey].detail.
   * Called after every item completes (success or failure) so the UI can
   * stream progress. Keep this sync + cheap.
   */
  progressMessage: (done: number, failed: number, total: number) => string;
  /**
   * Cooperative cancel check. Called before each item dispatch; should
   * throw CompileCancelledError (from run/route.ts) when the compile
   * has been cancelled. Wiring lives in the orchestrator so this helper
   * stays independent of the route.
   */
  assertNotCancelled: (sessionId: string) => void;
}

export interface PerItemStepResult<Item> {
  succeeded: Item[];
  failed: Array<{ item: Item; error: Error }>;
}

/**
 * Bounded-concurrency task runner. Captures errors per task rather than
 * short-circuiting the whole batch (one bad item shouldn't kill the others).
 * Returns Error instances in-place so the caller can correlate with the
 * input order.
 */
async function pLimitRun<Item>(
  items: Item[],
  limit: number,
  work: (item: Item, idx: number) => Promise<void>
): Promise<Array<Error | null>> {
  const results: Array<Error | null> = new Array(items.length).fill(null);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try {
        await work(items[i], i);
      } catch (e) {
        results[i] = e instanceof Error ? e : new Error(String(e));
      }
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

export async function runPerItemStep<Item>(
  opts: PerItemStepOptions<Item>
): Promise<PerItemStepResult<Item>> {
  const { sessionId, stepKey, items, run, onFailure, progressMessage } = opts;
  const concurrency = opts.concurrency ?? 1;

  // Empty-items fast path: mark done with a 'skipped' detail so
  // resetForRetry treats this step as completed (prevents legacy-retry
  // wiping already-done downstream steps). 'done' status is used because
  // updateCompileStep's type is 'running' | 'done' | 'failed' — no 'skipped'.
  if (items.length === 0) {
    updateCompileStep(sessionId, stepKey, 'done', 'skipped (no items)');
    return { succeeded: [], failed: [] };
  }

  updateCompileStep(sessionId, stepKey, 'running');

  const total = items.length;
  let done = 0;
  let failedCount = 0;
  const succeeded: Item[] = [];
  const failed: Array<{ item: Item; error: Error }> = [];
  // Accumulate onFailure work so one slow failure-side insert doesn't
  // block the next item's dispatch. Awaited at the end for correctness.
  const onFailureTasks: Array<Promise<void>> = [];
  let cancelledError: Error | null = null;

  // Check for cancellation up-front — saves a worker spin-up if the user
  // already cancelled between the last assertNotCancelled in the orchestrator
  // and now.
  opts.assertNotCancelled(sessionId);

  await pLimitRun(items, concurrency, async (item) => {
    // Cooperative cancel check per item. Throwing here marks the item as
    // failed in pLimitRun's results array — we detect that below and
    // re-throw once so the orchestrator sees a single CompileCancelledError.
    try {
      opts.assertNotCancelled(sessionId);
    } catch (e) {
      cancelledError = e instanceof Error ? e : new Error(String(e));
      throw cancelledError;
    }

    try {
      await run(item);
      succeeded.push(item);
      done++;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      failedCount++;
      failed.push({ item, error: err });
      if (onFailure) {
        // Wrap so an exception in the failure-writer doesn't derail the
        // batch — just log to console and keep going.
        onFailureTasks.push(
          Promise.resolve(onFailure(item, err)).catch((fErr) => {
            console.error(
              `[runPerItemStep:${stepKey}] onFailure threw — item error recorded but side-effect failed:`,
              fErr
            );
          })
        );
      }
    }

    updateCompileStep(
      sessionId,
      stepKey,
      'running',
      progressMessage(done, failedCount, total)
    );
  });

  // Propagate cancel — orchestrator catches CompileCancelledError and exits
  // cleanly. The step stays in 'running' state on cancel, which is correct:
  // the session's compile_progress.status will be flipped to 'cancelled'
  // by cancelCompileProgress.
  if (cancelledError) throw cancelledError;

  // Wait for any pending failure-side inserts to finish before the step
  // reports 'done'. Without this, a crash right after the step completes
  // could leave onFailure writes pending in event-loop tasks that never fire.
  await Promise.all(onFailureTasks);

  updateCompileStep(
    sessionId,
    stepKey,
    'done',
    progressMessage(done, failedCount, total)
  );
  return { succeeded, failed };
}
