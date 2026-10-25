/**
 * The 'labels' step: merges category labels that mean the same thing in
 * this session's drafts, between crossref and commit
 * (lib/compile/label-merge.ts).
 *
 * Once per session: a retry after a later step failed finds the step done
 * and the merge already in the drafts, so it does not ask again (one call
 * per compile). /retry-failed resets every step, and its new drafts are
 * checked. Never fails the compile: anything but a cancel or a newer run
 * ends the step as skipped.
 */

import { CompileCancelledError, CompileSupersededError, type CompileRun } from '../compile-run';
import { getCompileProgress, getEffectiveCompileModel } from '../../db';
import { sanitizeLogValue } from '../../log-safe';
import { mergeDraftLabels } from '../label-merge';

function labelsStepDone(sessionId: string): boolean {
  const steps = getCompileProgress(sessionId)?.steps;
  if (!steps) return false;
  try {
    return (JSON.parse(steps) as Record<string, { status?: string }>).labels?.status === 'done';
  } catch {
    return false;
  }
}

export async function runLabelsStep(run: CompileRun): Promise<void> {
  const { sessionId } = run;
  if (labelsStepDone(sessionId)) return;
  run.step('labels', 'running');
  let detail: string;
  try {
    const outcome = await mergeDraftLabels(sessionId, getEffectiveCompileModel(sessionId), () => run.assertActive());
    detail = outcome.detail;
  } catch (err) {
    if (err instanceof CompileCancelledError || err instanceof CompileSupersededError) throw err;
    console.error('[compile:%s] labels step failed; drafts keep their labels', sanitizeLogValue(sessionId), err);
    // Not 'skipped …': the progress page hides steps whose detail starts so.
    detail = 'categories not merged (unexpected error)';
  }
  run.step('labels', 'done', detail);
}
