/**
 * The 'claims' step (plan 3.3): checks this session's new sources' claims
 * against the wiki's other claims, after the pages are committed (findings
 * are recorded on the subjects' pages, lib/claim-check/run.ts).
 *
 * Behind the claim_check_enabled flag (CLAUDE.md rule 7; on by default since
 * it passed the owner-vetted accuracy bar, lib/claim-check/flag.ts).
 * With the flag off the step is marked skipped as the pipeline starts, so
 * the progress page never shows it (it hides steps whose detail starts with
 * 'skipped'). Once per session: a retry finds the step done and does not ask
 * again; the saved verdicts would skip every judged pair anyway. Never fails
 * the compile: anything but a newer run of the session ends the step with a
 * note. The compile's model, locked at session start, judges.
 */

import { getClaimCheckEnabled } from '../../claim-check/flag';
import { MAX_CLAIM_CHECK_PAIRS_PER_COMPILE } from '../../claim-check/limits';
import { runClaimCheck, type ClaimCheckSummary } from '../../claim-check/run';
import { getCompileProgress, getDb, getEffectiveCompileModel } from '../../db';
import { sanitizeLogValue } from '../../log-safe';
import { CompileCancelledError, CompileSupersededError, type CompileRun } from '../compile-run';

const OFF_DETAIL = 'skipped (claim check off)';

function claimsStepDone(sessionId: string): boolean {
  const steps = getCompileProgress(sessionId)?.steps;
  if (!steps) return false;
  try {
    return (JSON.parse(steps) as Record<string, { status?: string }>).claims?.status === 'done';
  } catch {
    return false;
  }
}

/** Pipeline start: with the flag off, the step is skipped (and hidden) from the outset. */
export function skipClaimsStepIfOff(run: CompileRun): void {
  if (!getClaimCheckEnabled() && !claimsStepDone(run.sessionId)) run.step('claims', 'done', OFF_DETAIL);
}

/** This session's sources that have an extraction. */
function sessionSources(sessionId: string): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT s.source_id FROM sources s JOIN extractions e ON e.source_id = s.source_id
        WHERE s.onboarding_session_id = ?`,
    )
    .all(sessionId) as Array<{ source_id: string }>;
  return new Set(rows.map((r) => r.source_id));
}

const STOP_TEXT: Record<string, string> = {
  daily_cost_ceiling: "today's spending limit reached",
  rate_limited: 'rate limited',
  failures: '3 failed checks in a row',
  stopped: 'stopped',
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The step's detail line on the progress page. */
export function describeClaimCheck(s: ClaimCheckSummary): string {
  if (s.selected === 0) return 'no claim pairs to check';
  const stop = s.stopped ? STOP_TEXT[s.stopped] : undefined;
  if (s.judged === 0 && stop) return `claims not checked: ${stop}`;
  const parts = [
    `${plural(s.judged, 'claim pair', 'claim pairs')} checked`,
    s.findings > 0 ? plural(s.findings, 'possible disagreement', 'possible disagreements') : 'no disagreements',
  ];
  const left = s.candidates - s.judged;
  if (left > 0) parts.push(`${left} left for the wiki check`);
  if (stop) parts.push(`stopped: ${stop}`);
  return parts.join(' · ');
}

export async function runClaimsStep(run: CompileRun): Promise<void> {
  const { sessionId } = run;
  if (claimsStepDone(sessionId)) return;
  if (!getClaimCheckEnabled()) {
    run.step('claims', 'done', OFF_DETAIL);
    return;
  }
  run.step('claims', 'running');
  let detail: string;
  try {
    const sources = sessionSources(sessionId);
    if (sources.size === 0) {
      detail = 'no new claims to check';
    } else {
      const summary = await runClaimCheck({
        found_by: 'claim_check',
        model: getEffectiveCompileModel(sessionId),
        maxPairs: MAX_CLAIM_CHECK_PAIRS_PER_COMPILE,
        session_id: sessionId,
        newSourceIds: sources,
        shouldStop: () => (run.isCurrent ? null : 'stopped'),
      });
      detail = describeClaimCheck(summary);
    }
  } catch (err) {
    if (err instanceof CompileCancelledError || err instanceof CompileSupersededError) throw err;
    console.error('[compile:%s] claims step failed; the compile is not affected', sanitizeLogValue(sessionId), err);
    // Not 'skipped …': the progress page hides steps whose detail starts so.
    detail = 'claims not checked (unexpected error)';
  }
  // A newer run of this session took over meanwhile: stop here.
  run.assertActive();
  run.step('claims', 'done', detail);
}
