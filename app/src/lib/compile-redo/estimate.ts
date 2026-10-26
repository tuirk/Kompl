/**
 * Cost and time estimate of a redo of the last compile. Pure functions, no
 * DB or fetch: lib/compile-redo/plan.ts gathers the sizes, prices come from
 * nlp-service GET /llm/pricing (lib/wiki-repair/calls.ts fetchRepairPricing).
 *
 *   - page writing: one draft_page call per page, priced as the page update
 *     prices it (estimateUpgrade); the low end over the pages the redo
 *     writes for sure, the high end over the most it may write;
 *   - checks (re-plan only): the name matching and the page checks run
 *     again. How many calls they make depends on the AI's answers, so the
 *     low end counts none and the high end CHECK_CALLS_PER_SOURCE_HIGH per
 *     source, each priced as CHECK_CALL_INPUT_TOKENS in and
 *     CHECK_CALL_OUTPUT_TOKENS out plus thinking (an assumption until a
 *     redo has been measured; NFR-3);
 *   - categories: one label-merge call when pages are written.
 * A re-save writes no page text: no AI cost is expected.
 */

import type { LlmModel } from '../llm-models';
import { estimateUpgrade, roundCostDown, roundCostUp, THINKING_LOW_FACTOR, THINKING_EFFORT_HIGH_FACTOR, type PageEstimateInput } from '../page-upgrade-estimate';
import { MAX_TRIAGE_CANDIDATES_PER_SOURCE } from '../triage-candidates';
import type { RepairPricing } from '../wiki-repair/estimate';
import { CALL_SECONDS } from '../wiki-repair/estimate';

/** Page checks per source (match) plus one name-matching batch (resolve). */
export const CHECK_CALLS_PER_SOURCE_HIGH = MAX_TRIAGE_CANDIDATES_PER_SOURCE + 1;
export const CHECK_CALL_INPUT_TOKENS = 3_000;
export const CHECK_CALL_OUTPUT_TOKENS = { low: 150, high: 1_000 } as const;
export const LABEL_CALL_TOKENS = { input: 1_500, output: 600 } as const;

export interface RedoEstimateInput {
  draftsLow: PageEstimateInput[];
  draftsHigh: PageEstimateInput[];
  /** Sources whose checks run again (re-plan); 0 otherwise. */
  checkSources: number;
}

export interface RedoEstimate {
  calls_low: number;
  calls_high: number;
  cost_usd_low: number;
  cost_usd_high: number;
  minutes_low: number;
  minutes_high: number;
}

const perToken = (usdPerMillion: number) => usdPerMillion / 1_000_000;

export function estimateRedo(input: RedoEstimateInput, pricing: RepairPricing, model: LlmModel): RedoEstimate {
  const low = estimateUpgrade(input.draftsLow, pricing, model);
  const high = estimateUpgrade(input.draftsHigh, pricing, model);
  let costLow = low.raw.cost_usd_low;
  let costHigh = high.raw.cost_usd_high;
  let secondsLow = low.raw.seconds_low;
  let secondsHigh = high.raw.seconds_high;

  const checkCalls = input.checkSources * CHECK_CALLS_PER_SOURCE_HIGH;
  if (checkCalls > 0) {
    const budget = Math.max(0, pricing.disambiguate_thinking_budget);
    const thinkingHigh = budget * (pricing.draft_thinking_budget_is_cap ? 1 : THINKING_EFFORT_HIGH_FACTOR);
    const out = Math.min(CHECK_CALL_OUTPUT_TOKENS.high + thinkingHigh, pricing.disambiguate_max_output_tokens);
    costHigh += checkCalls * (CHECK_CALL_INPUT_TOKENS * perToken(pricing.input_usd_per_m) + out * perToken(pricing.output_usd_per_m));
    secondsHigh += checkCalls * CALL_SECONDS.high;
  }

  const labelCall = input.draftsHigh.length > 0 ? 1 : 0;
  if (labelCall) {
    const budget = Math.max(0, pricing.label_merge_thinking_budget);
    const callUsd = (thinking: number) =>
      LABEL_CALL_TOKENS.input * perToken(pricing.input_usd_per_m) +
      Math.min(LABEL_CALL_TOKENS.output + thinking, pricing.label_merge_max_output_tokens) * perToken(pricing.output_usd_per_m);
    if (input.draftsLow.length > 0) {
      costLow += callUsd(budget * THINKING_LOW_FACTOR);
      secondsLow += CALL_SECONDS.low;
    }
    costHigh += callUsd(budget * (pricing.draft_thinking_budget_is_cap ? 1 : THINKING_EFFORT_HIGH_FACTOR));
    secondsHigh += CALL_SECONDS.high;
  }

  const callsLow = input.draftsLow.length + (input.draftsLow.length > 0 ? labelCall : 0);
  const callsHigh = input.draftsHigh.length + labelCall + checkCalls;
  const minutesLow = callsHigh === 0 ? 0 : Math.max(1, Math.floor(secondsLow / 60));
  return {
    calls_low: callsLow,
    calls_high: callsHigh,
    cost_usd_low: roundCostDown(costLow),
    cost_usd_high: roundCostUp(costHigh),
    minutes_low: minutesLow,
    minutes_high: callsHigh === 0 ? 1 : Math.max(minutesLow, Math.ceil(secondsHigh / 60)),
  };
}
