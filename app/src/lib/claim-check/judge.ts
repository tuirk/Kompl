/**
 * The claim judge: verdicts for claim pairs from nlp-service
 * POST /pipeline/judge-claims (routers/claims.py), in batches of
 * CLAIM_JUDGE_BATCH_SIZE, CLAIM_JUDGE_CONCURRENCY calls at a time.
 *
 * No database: give it pairs, get verdicts. The compile's claim check and
 * the whole-wiki check (./run.ts) call it on the pairs they ranked; the
 * accuracy gate (plan 3.7) can call it the same way on labelled pairs and
 * compare the verdicts with the labels:
 *
 *   const outcome = await judgeClaimPairs(
 *     [{ pair_id: 'ex-1', subject: 'Bitcoin',
 *        a: { claim: 'Bitcoin launched in 2008.', source_title: 'Some article', date: '2019-05-01', date_kind: 'published' },
 *        b: { claim: 'Bitcoin launched in 2009.', source_title: 'Another one', date: '2023-02-01', date_kind: 'published' } }],
 *     'deepseek-flash',
 *   );
 *   // outcome.verdicts: [{ pair_id: 'ex-1', verdict: 'disputed', topic, reason, newer: null }]
 *
 * Put the earlier-dated claim in `a`: the runs do, so the gate measures the
 * judge as it is used (LLM judges are sensitive to the order of what they
 * compare; Shi et al. 2025, "Judging the Judges").
 *
 * A pair the judge left unanswered (or answered with an unknown verdict)
 * has no verdict. The run stops taking new batches at the daily cost
 * ceiling (503), a rate limit (429), MAX_CONSECUTIVE_JUDGE_FAILURES failed
 * calls in a row, or when `shouldStop` says so; calls in flight finish.
 */

import { CLAIM_JUDGE_BATCH_SIZE, CLAIM_JUDGE_CONCURRENCY, MAX_CONSECUTIVE_JUDGE_FAILURES } from './limits';
import type { ClaimVerdict } from './verdicts';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';
// One call judges a handful of pairs (at most 8192 output tokens); a slow
// answer counts as a failed call and its pairs stay unjudged.
const JUDGE_TIMEOUT_MS = 180_000;

export interface JudgeSide {
  claim: string;
  /** The source's own sentence, when it was found in the source. */
  quote?: string | null;
  /** The source's title. */
  source_title?: string | null;
  /** The source's date, YYYY-MM-DD (lib/source-dates.ts promptDate). */
  date?: string | null;
  /** 'saved': no publication date is known; `date` is the day the source was added. */
  date_kind?: 'published' | 'saved' | null;
}

export interface JudgePair {
  /** Unique within one judgeClaimPairs call. */
  pair_id: string;
  /** The shared subject the pair was found on. */
  subject: string;
  a: JudgeSide;
  b: JudgeSide;
}

export interface JudgedPair {
  pair_id: string;
  verdict: ClaimVerdict;
  topic: string;
  reason: string;
  /** outdated only: the side whose source is provably later (D5). */
  newer: 'a' | 'b' | null;
}

export type JudgeStop = 'daily_cost_ceiling' | 'rate_limited' | 'failures' | 'stopped';

export interface JudgeOutcome {
  verdicts: JudgedPair[];
  /** Calls answered, and calls that failed (timeouts, errors, bad answers). */
  calls: number;
  failed_calls: number;
  /** Why the run stopped early; null when every batch was sent. */
  stopped: JudgeStop | null;
}

export interface JudgeOptions {
  /** Each answered batch's verdicts, as they land (the runs save them right away). */
  onBatch?: (verdicts: JudgedPair[]) => void;
  /** Asked before each batch; a reason stops the run. */
  shouldStop?: () => JudgeStop | null;
  batchSize?: number;
  concurrency?: number;
}

type CallResult = { verdicts: JudgedPair[] } | { limit: 'daily_cost_ceiling' | 'rate_limited' } | { failed: true };

async function callJudge(pairs: JudgePair[], model: string): Promise<CallResult> {
  try {
    const res = await fetch(`${NLP_SERVICE_URL}/pipeline/judge-claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairs, compile_model: model }),
      signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    });
    if (res.status === 503) return { limit: 'daily_cost_ceiling' };
    if (res.status === 429) return { limit: 'rate_limited' };
    if (!res.ok) return { failed: true };
    const body = (await res.json()) as { items?: JudgedPair[] };
    return Array.isArray(body.items) ? { verdicts: body.items } : { failed: true };
  } catch {
    return { failed: true };
  }
}

/** Verdicts for `pairs` with `model` (an allowlisted model id). */
export async function judgeClaimPairs(pairs: readonly JudgePair[], model: string, options: JudgeOptions = {}): Promise<JudgeOutcome> {
  const size = Math.max(1, options.batchSize ?? CLAIM_JUDGE_BATCH_SIZE);
  const batches: JudgePair[][] = [];
  for (let i = 0; i < pairs.length; i += size) batches.push(pairs.slice(i, i + size));

  const outcome: JudgeOutcome = { verdicts: [], calls: 0, failed_calls: 0, stopped: null };
  let consecutiveFailures = 0;

  const worker = async (): Promise<void> => {
    while (batches.length > 0 && outcome.stopped === null) {
      const reason = options.shouldStop?.() ?? null;
      if (reason) {
        outcome.stopped = reason;
        return;
      }
      const batch = batches.shift()!;
      const result = await callJudge(batch, model);
      if ('limit' in result) {
        outcome.stopped ??= result.limit;
        return;
      }
      if ('failed' in result) {
        outcome.failed_calls++;
        if (++consecutiveFailures >= MAX_CONSECUTIVE_JUDGE_FAILURES) outcome.stopped ??= 'failures';
        continue;
      }
      consecutiveFailures = 0;
      outcome.calls++;
      outcome.verdicts.push(...result.verdicts);
      options.onBatch?.(result.verdicts);
    }
  };

  const workers = Math.max(1, Math.min(options.concurrency ?? CLAIM_JUDGE_CONCURRENCY, batches.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return outcome;
}
