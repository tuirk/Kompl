/**
 * Cost and time estimate of a whole-wiki check run (plan 3.6, Settings >
 * Wiki health). Pure functions with no DB, fetch or Node imports: the server
 * gathers the inputs (./wiki-check.ts) and the Settings card formats the
 * result with the page-update helpers (lib/page-upgrade-estimate.ts).
 *
 * One call judges up to CLAIM_JUDGE_BATCH_SIZE pairs. Prices and the call's
 * limits come from the nlp-service (GET /llm/pricing), where the call is
 * made. Per call:
 *
 *   input tokens    = JUDGE_PROMPT_OVERHEAD_TOKENS
 *                     + Σ (pair chars + PAIR_FRAMING_CHARS) / CHARS_PER_TOKEN
 *   answer tokens   = pairs × ANSWER_TOKENS_PER_PAIR [low, high]
 *   thinking tokens = judge budget × [THINKING_LOW_FACTOR, 1] where the budget
 *                     is a hard cap (Gemini 2.5), × [THINKING_LOW_FACTOR,
 *                     THINKING_EFFORT_HIGH_FACTOR] where it only picks an
 *                     effort level (Gemini 3.x, DeepSeek)
 *   output tokens   = min(answer + thinking, judge max output tokens)
 *   cost            = input × input price + output × output price
 *
 * The sums are rounded outward (roundCostDown / roundCostUp). Time:
 * calls / CLAIM_JUDGE_CONCURRENCY × JUDGE_SECONDS_PER_CALL, an assumption
 * until a run has been timed.
 */

import {
  CHARS_PER_TOKEN,
  THINKING_EFFORT_HIGH_FACTOR,
  THINKING_LOW_FACTOR,
  roundCostDown,
  roundCostUp,
} from '../page-upgrade-estimate';
import { CLAIM_JUDGE_BATCH_SIZE, CLAIM_JUDGE_CONCURRENCY } from './limits';

/** The judge's system prompt with its response contract (~2.9k chars). */
export const JUDGE_PROMPT_OVERHEAD_TOKENS = 800;
/** "PAIR <id> (subject: …)", the A/B lines with their dates and quote labels. */
export const PAIR_FRAMING_CHARS = 170;
/** One answer: pair id, topic, one-sentence reason, verdict. */
export const ANSWER_TOKENS_PER_PAIR = { low: 45, high: 90 } as const;
/** Seconds per judge call: an assumption, not measured yet. */
export const JUDGE_SECONDS_PER_CALL = { low: 4, high: 30 } as const;

/** GET /llm/pricing fields the estimate reads. */
export interface JudgePricing {
  input_usd_per_m: number;
  output_usd_per_m: number;
  claim_judge_thinking_budget: number;
  /** Shared by every call site: whether the model takes the budget as a hard cap. */
  draft_thinking_budget_is_cap: boolean;
  claim_judge_max_output_tokens: number;
}

export interface WikiCheckEstimate {
  pairs: number;
  calls: number;
  cost_usd_low: number;
  cost_usd_high: number;
  minutes_low: number;
  minutes_high: number;
}

/**
 * The estimate for judging pairs whose texts (both claims and their quotes)
 * are `pairChars` characters long, in the order they will be sent.
 */
export function estimateWikiCheck(pairChars: readonly number[], pricing: JudgePricing): WikiCheckEstimate {
  const perToken = (usdPerMillion: number) => usdPerMillion / 1_000_000;
  const budget = Math.max(0, pricing.claim_judge_thinking_budget);
  let low = 0;
  let high = 0;
  let calls = 0;
  for (let i = 0; i < pairChars.length; i += CLAIM_JUDGE_BATCH_SIZE) {
    const batch = pairChars.slice(i, i + CLAIM_JUDGE_BATCH_SIZE);
    calls++;
    const chars = batch.reduce((sum, c) => sum + Math.max(0, c) + PAIR_FRAMING_CHARS, 0);
    const input = JUDGE_PROMPT_OVERHEAD_TOKENS + chars / CHARS_PER_TOKEN;
    const outLow = Math.min(
      batch.length * ANSWER_TOKENS_PER_PAIR.low + budget * THINKING_LOW_FACTOR,
      pricing.claim_judge_max_output_tokens,
    );
    const outHigh = Math.min(
      batch.length * ANSWER_TOKENS_PER_PAIR.high + budget * (pricing.draft_thinking_budget_is_cap ? 1 : THINKING_EFFORT_HIGH_FACTOR),
      pricing.claim_judge_max_output_tokens,
    );
    const inputUsd = input * perToken(pricing.input_usd_per_m);
    low += inputUsd + outLow * perToken(pricing.output_usd_per_m);
    high += inputUsd + outHigh * perToken(pricing.output_usd_per_m);
  }
  const rounds = Math.ceil(calls / CLAIM_JUDGE_CONCURRENCY);
  const minutesLow = calls === 0 ? 0 : Math.max(1, Math.floor((rounds * JUDGE_SECONDS_PER_CALL.low) / 60));
  const minutesHigh = calls === 0 ? 0 : Math.max(minutesLow, Math.ceil((rounds * JUDGE_SECONDS_PER_CALL.high) / 60));
  return {
    pairs: pairChars.length,
    calls,
    cost_usd_low: roundCostDown(low),
    cost_usd_high: roundCostUp(high),
    minutes_low: minutesLow,
    minutes_high: minutesHigh,
  };
}
