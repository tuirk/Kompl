/**
 * After the ingest steps: did every staged item fail to import?
 *
 * Each ingest step ends 'done' however many of its items failed (one bad
 * link must not stop the rest). When none was imported the session has
 * nothing to compile; it used to take the no-sources path and end
 * 'completed' with no pages. Decided from collect_staging, not from this
 * run's step results, so a plain Retry (which imports nothing, the failed
 * rows being no longer 'pending') fails the same way. One imported row (a new
 * source, a duplicate linked to an existing source, or a saved link) and the
 * session goes on as before.
 */

import type { CompileStepKey } from '../../compile-steps';
import { getStagingBySession, type StagingConnector } from '../../db';
import type { CompileRun } from '../compile-run';

const STEP_OF_CONNECTOR: Record<StagingConnector, CompileStepKey> = {
  'file-upload': 'ingest_files',
  url: 'ingest_urls',
  text: 'ingest_texts',
  'saved-link': 'ingest_texts',
  paste: 'ingest_texts',
};

const INGEST_STEPS: CompileStepKey[] = ['ingest_files', 'ingest_urls', 'ingest_texts'];

/**
 * Fails the session when its included staging rows include failures and no
 * import; returns true when it did. The steps whose items failed turn
 * 'failed' and the session error says why (both shown on the progress page,
 * next to the "Retry N failed" button).
 */
export function failIfNothingIngested(run: CompileRun): boolean {
  const rows = getStagingBySession(run.sessionId).filter((r) => r.included);
  if (rows.some((r) => r.status === 'ingested')) return false;
  const failed = rows.filter((r) => r.status === 'failed');
  if (failed.length === 0) return false;

  const perStep = new Map<CompileStepKey, number>();
  for (const r of failed) {
    const step = STEP_OF_CONNECTOR[r.connector] ?? 'ingest_texts';
    perStep.set(step, (perStep.get(step) ?? 0) + 1);
  }
  for (const step of INGEST_STEPS) {
    const n = perStep.get(step);
    if (n) run.step(step, 'failed', `${n} failed, nothing was imported`);
  }
  run.fail(
    `Nothing to compile: all ${failed.length} item(s) failed to import. ` +
      'Open the failed step to see why, then retry the failed items.'
  );
  return true;
}
