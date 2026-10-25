/**
 * Re-checks stored triage failures (lib/triage-rechecks.ts) during a
 * compile's match step. Runs only when plan will use the step's matches
 * (the run route says so with will_plan), so every verdict reaches a plan.
 *
 *   - This session's own verdicts (from an earlier run of it that failed)
 *     are handed back without a call, even with the switch off: a retry
 *     that plans again rebuilds the same plans.
 *   - Other pairs only while the switch is on (CLAUDE.md rule 7), oldest
 *     first, at most MAX_TRIAGE_RECHECKS_PER_COMPILE triage calls. A pair
 *     whose source is not compiled yet waits: its own session triages it.
 *   - Dropped without a call: source or page gone or archived, source
 *     already linked to the page, source text unreadable, or as many
 *     failed attempts as MAX_TRIAGE_ATTEMPTS.
 *   - A verdict stays on the pair for this session and joins the matches,
 *     which plan Rule 6 treats like any triage verdict. A failure counts an
 *     attempt and drops the pair at the maximum. A daily cost ceiling
 *     refusal keeps the pair, counts nothing, and ends the re-checks for
 *     this compile (every further call would be refused too).
 *
 * One match_triage_rechecked activity row per compile when anything happened.
 */

import { getEffectiveCompileModel, logActivity, readRawMarkdown } from '../db';
import { callTriage, triageFailureOf, type MatchEntry, type TriageFailure } from '../triage-call';
import {
  MAX_TRIAGE_ATTEMPTS,
  MAX_TRIAGE_RECHECKS_PER_COMPILE,
  countWaitingTriagePairs,
  getTriageRecheckEnabled,
  listStoredTriagePairs,
  recordTriageFailure,
  removeTriagePair,
  stampRecheckVerdict,
  type StoredTriagePair,
} from '../triage-rechecks';

export interface RecheckStats {
  /** Triage calls made (cost ceiling refusals included). */
  rechecked: number;
  recheck_answered: number;
  /** Re-checks that gave no verdict and stay stored. */
  recheck_failed: number;
  /** Pairs removed without a verdict. */
  recheck_dropped: number;
}

export const NO_RECHECKS: RecheckStats = { rechecked: 0, recheck_answered: 0, recheck_failed: 0, recheck_dropped: 0 };

type DropReason = 'gave_up' | 'source_gone' | 'source_archived' | 'page_gone' | 'page_archived' | 'already_linked';

/** Shown in the activity row; given-up pairs first. */
const MAX_EXAMPLES = 5;

const COMPILED = new Set(['active', 'compiled']);

function dropReason(pair: StoredTriagePair, own: boolean): DropReason | null {
  if (!pair.source_exists) return 'source_gone';
  if (!pair.page_exists) return 'page_gone';
  if (pair.source_status === 'archived') return 'source_archived';
  if (pair.page_archived) return 'page_archived';
  if (pair.linked) return 'already_linked';
  // A verdict this session holds says nothing about failed attempts.
  if (!own && pair.attempts >= MAX_TRIAGE_ATTEMPTS) return 'gave_up';
  return null;
}

export async function recheckStoredTriages(
  sessionId: string,
): Promise<{ matches: MatchEntry[]; stats: RecheckStats }> {
  const enabled = getTriageRecheckEnabled();
  const model = getEffectiveCompileModel(sessionId);
  const matches: MatchEntry[] = [];
  const dropped: Array<{ pair: StoredTriagePair; why: DropReason }> = [];
  const failures: Record<TriageFailure, number> = { llm_rate_limited: 0, daily_cost_ceiling: 0, triage_error: 0 };
  let rechecked = 0;
  let answered = 0;
  let failed = 0;
  let ceilingHit = false;

  const drop = (pair: StoredTriagePair, why: DropReason) => {
    removeTriagePair(pair.source_id, pair.page_id);
    dropped.push({ pair, why });
  };

  for (const pair of listStoredTriagePairs()) {
    const own = pair.verdict !== null && pair.verdict_session_id === sessionId;
    if (!own && !enabled) continue;
    const why = dropReason(pair, own);
    if (why) {
      drop(pair, why);
      continue;
    }
    // Not compiled yet: its own session's match triages it again.
    if (!COMPILED.has(pair.compile_status ?? '')) continue;
    const entry = (decision: MatchEntry['decision'], reason: string): MatchEntry => ({
      source_id: pair.source_id,
      page_id: pair.page_id,
      page_title: pair.page_title!,
      decision,
      reason,
    });
    if (own) {
      matches.push(entry(pair.verdict!, pair.verdict_reason ?? ''));
      continue;
    }
    if (ceilingHit || rechecked >= MAX_TRIAGE_RECHECKS_PER_COMPILE) continue;

    const markdown = readRawMarkdown(pair.source_id);
    if (!markdown) {
      drop(pair, 'source_gone');
      continue;
    }

    rechecked++;
    try {
      const verdict = await callTriage(markdown, pair.page_summary ?? '', pair.page_title!, model);
      stampRecheckVerdict(pair.source_id, pair.page_id, verdict, sessionId);
      matches.push(entry(verdict.decision, verdict.reason));
      answered++;
    } catch (err) {
      const failure = triageFailureOf(err);
      failures[failure]++;
      console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'match_triage_recheck_failed', session_id: sessionId, source_id: pair.source_id, page_id: pair.page_id, reason: failure, error: err instanceof Error ? err.message : String(err) }));
      const attempts = recordTriageFailure(pair.source_id, pair.page_id, failure, sessionId);
      if (failure === 'daily_cost_ceiling') ceilingHit = true;
      if (attempts !== null && attempts >= MAX_TRIAGE_ATTEMPTS) {
        drop(pair, 'gave_up');
      } else {
        failed++;
      }
    }
  }

  const stats: RecheckStats = {
    rechecked,
    recheck_answered: answered,
    recheck_failed: failed,
    recheck_dropped: dropped.length,
  };

  if (rechecked > 0 || dropped.length > 0) {
    const gaveUp = dropped.filter((d) => d.why === 'gave_up');
    logActivity('match_triage_rechecked', {
      source_id: null,
      session_id: sessionId,
      step_key: 'match',
      details: {
        session_id: sessionId,
        rechecked,
        answered,
        failed,
        cost_ceiling: failures.daily_cost_ceiling,
        rate_limited: failures.llm_rate_limited,
        errors: failures.triage_error,
        dropped: dropped.length,
        gave_up: gaveUp.length,
        waiting: countWaitingTriagePairs(sessionId),
        examples: [...gaveUp, ...dropped.filter((d) => d.why !== 'gave_up')]
          .slice(0, MAX_EXAMPLES)
          .map((d) => ({ source_title: d.pair.source_title, page_title: d.pair.page_title, outcome: d.why })),
      },
    });
  }

  return { matches, stats };
}
