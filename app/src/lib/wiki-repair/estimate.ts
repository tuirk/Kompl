/**
 * Cost and time estimate of a wiki repair run (Settings > Wiki health).
 * Pure functions with no DB, fetch or Node imports: lib/wiki-repair/plan.ts
 * gathers the inputs and the Settings card formats the result with the page
 * update's helpers (lib/page-upgrade-estimate.ts).
 *
 * A run makes three kinds of AI calls, all priced from nlp-service GET
 * /llm/pricing (where the calls are made):
 *   - name checks: one disambiguate_entities call per REPAIR_ALIAS_BATCH
 *     name matches; input = NAME_CHECK_PROMPT_OVERHEAD_TOKENS + the pairs'
 *     names and contexts; output = answers + thinking, capped;
 *   - page rebuilds: one draft_page call per page, as the page update
 *     estimates it (estimatePageCost); the low end counts the pages that
 *     change whatever the AI answers, the high end every page that can;
 *   - labels: one consolidate_labels call over the wiki's labels.
 * Thinking is a cap or an effort level as draft_thinking_budget_is_cap says
 * (THINKING_LOW_FACTOR / THINKING_EFFORT_HIGH_FACTOR). Sums are rounded
 * outward. Time: calls one after another, CALL_SECONDS each for name checks
 * and the label call (an assumption until a run has been timed), the page
 * update's SECONDS_PER_PAGE per page, plus FIXED_SECONDS for the backup and
 * the mention rewrite.
 */

import type { LlmModel } from '../llm-models';
import {
  CHARS_PER_TOKEN,
  THINKING_EFFORT_HIGH_FACTOR,
  THINKING_LOW_FACTOR,
  estimateUpgrade,
  roundCostDown,
  roundCostUp,
  type DraftPricing,
  type PageEstimateInput,
} from '../page-upgrade-estimate';

/** Layer 3's system prompt (~2.5–2.8k chars) and the request wrapper. */
export const NAME_CHECK_PROMPT_OVERHEAD_TOKENS = 1_000;
/** JSON keys and types around each pair's names and contexts. */
export const NAME_CHECK_PAIR_FRAMING_CHARS = 150;
/** One answer per pair: both names, the decision, the canonical and a reason. */
export const NAME_CHECK_ANSWER_TOKENS = { low: 60, high: 250 } as const;
/** The label prompt (~2.2k chars) and its wrapper. */
export const LABEL_PROMPT_OVERHEAD_TOKENS = 800;
/** Per label shown: a merge names it, its target and a reason. */
export const LABEL_ANSWER_TOKENS_PER_LABEL = 25;
/** Seconds per name-check or label call: an assumption, not measured yet. */
export const CALL_SECONDS = { low: 4, high: 40 } as const;
/** The backup and the mention rewrite. */
export const FIXED_SECONDS = { low: 10, high: 60 } as const;

/** GET /llm/pricing fields the estimate reads. */
export interface RepairPricing extends DraftPricing {
  disambiguate_thinking_budget: number;
  disambiguate_max_output_tokens: number;
  label_merge_thinking_budget: number;
  label_merge_max_output_tokens: number;
}

export interface RepairEstimateInput {
  /** Per name-check call, the characters of each pair's names and contexts. */
  nameCheckBatches: number[][];
  /** Pages rebuilt whatever the AI answers. */
  pagesLow: PageEstimateInput[];
  /** Every page that can be rebuilt. */
  pagesHigh: PageEstimateInput[];
  /** Labels the label call is shown, and their characters. */
  labels: { count: number; chars: number };
}

export interface RepairEstimate {
  calls_low: number;
  calls_high: number;
  cost_usd_low: number;
  cost_usd_high: number;
  minutes_low: number;
  minutes_high: number;
  /** Unrounded high cost (the spend guard's per-unit fallback). */
  raw_cost_usd_high: number;
}

const perToken = (usdPerMillion: number) => usdPerMillion / 1_000_000;

function thinking(budget: number, isCap: boolean): { low: number; high: number } {
  const b = Math.max(0, budget);
  return { low: b * THINKING_LOW_FACTOR, high: b * (isCap ? 1 : THINKING_EFFORT_HIGH_FACTOR) };
}

export function estimateRepair(input: RepairEstimateInput, pricing: RepairPricing, model: LlmModel): RepairEstimate {
  let low = 0;
  let high = 0;

  const nameThinking = thinking(pricing.disambiguate_thinking_budget, pricing.draft_thinking_budget_is_cap);
  for (const batch of input.nameCheckBatches) {
    const chars = batch.reduce((sum, c) => sum + Math.max(0, c) + NAME_CHECK_PAIR_FRAMING_CHARS, 0);
    const inputUsd = (NAME_CHECK_PROMPT_OVERHEAD_TOKENS + chars / CHARS_PER_TOKEN) * perToken(pricing.input_usd_per_m);
    const cap = pricing.disambiguate_max_output_tokens;
    low += inputUsd + Math.min(batch.length * NAME_CHECK_ANSWER_TOKENS.low + nameThinking.low, cap) * perToken(pricing.output_usd_per_m);
    high += inputUsd + Math.min(batch.length * NAME_CHECK_ANSWER_TOKENS.high + nameThinking.high, cap) * perToken(pricing.output_usd_per_m);
  }

  const pagesLow = estimateUpgrade(input.pagesLow, pricing, model);
  const pagesHigh = estimateUpgrade(input.pagesHigh, pricing, model);
  low += pagesLow.raw.cost_usd_low;
  high += pagesHigh.raw.cost_usd_high;

  const labelCall = input.labels.count >= 2 ? 1 : 0;
  if (labelCall) {
    const t = thinking(pricing.label_merge_thinking_budget, pricing.draft_thinking_budget_is_cap);
    const inputUsd =
      (LABEL_PROMPT_OVERHEAD_TOKENS + (input.labels.chars + 4 * input.labels.count) / CHARS_PER_TOKEN) *
      perToken(pricing.input_usd_per_m);
    const cap = pricing.label_merge_max_output_tokens;
    low += inputUsd + Math.min(t.low, cap) * perToken(pricing.output_usd_per_m);
    high += inputUsd + Math.min(input.labels.count * LABEL_ANSWER_TOKENS_PER_LABEL + t.high, cap) * perToken(pricing.output_usd_per_m);
  }

  const calls = input.nameCheckBatches.length + labelCall;
  const secondsLow = FIXED_SECONDS.low + calls * CALL_SECONDS.low + pagesLow.raw.seconds_low;
  const secondsHigh = FIXED_SECONDS.high + calls * CALL_SECONDS.high + pagesHigh.raw.seconds_high;
  const minutesLow = Math.max(1, Math.floor(secondsLow / 60));
  return {
    calls_low: calls + input.pagesLow.length,
    calls_high: calls + input.pagesHigh.length,
    cost_usd_low: roundCostDown(low),
    cost_usd_high: roundCostUp(high),
    minutes_low: minutesLow,
    minutes_high: Math.max(minutesLow, Math.ceil(secondsHigh / 60)),
    raw_cost_usd_high: high,
  };
}
