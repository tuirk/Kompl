/**
 * Cost and time estimate for updating older pages to the current writing
 * rules (Settings > Wiki health). Pure functions with no DB, fetch or Node
 * imports: the server gathers the inputs (lib/page-upgrade.ts) and the
 * Settings card formats the result with the same helpers.
 *
 * One page update is one draft_page call over ALL of the page's active
 * sources (lib/redraft.ts). Prices and the call's limits come from the
 * nlp-service (GET /llm/pricing), which is where the call is made. Per page:
 *
 *   input tokens    = min(source chars + SOURCE_HEADER_CHARS per source,
 *                         draft_prompt_char_cap) / CHARS_PER_TOKEN
 *                     + PROMPT_OVERHEAD_TOKENS
 *   text tokens     = current page chars / CHARS_PER_TOKEN
 *                     × [OUTPUT_LOW_FACTOR, OUTPUT_HIGH_FACTOR]
 *   thinking tokens = draft_thinking_budget × [THINKING_LOW_FACTOR, 1]
 *                       where the budget is a hard cap (Gemini 2.5)
 *                     draft_thinking_budget × [THINKING_LOW_FACTOR, THINKING_EFFORT_HIGH_FACTOR]
 *                       where it only picks an effort level (Gemini 3.x,
 *                       DeepSeek), which does not bound the token count
 *   output tokens   = min(text + thinking, draft_max_output_tokens)
 *   cost            = input × input price + output × output price
 *                     (both providers bill thinking at the output price);
 *                     the low end bills the first CACHED_PREFIX_TOKENS of
 *                     each prompt (the system prompt, the same on every page
 *                     of a type) at the cached-input price.
 *
 * The page sums are rounded outward to a coarse step (low down, high up), so
 * the range never claims more precision than it has.
 *
 * Time: pages run one at a time, so pages × SECONDS_PER_PAGE[model], plus
 * APP_SECONDS_PER_PAGE for the cleanup, save and links after each call.
 */

import type { LlmModel } from './llm-models';

/** Rough English average; the same rule of thumb the nlp-service caps use. */
export const CHARS_PER_TOKEN = 4;
/**
 * Prompt text around the sources: system prompt (~500 tokens), wiki schema,
 * up to 200 link titles, citation and link rules, category list, final check.
 */
export const PROMPT_OVERHEAD_TOKENS = 4_000;
/** "--- Source [S1]: <title> ---" header and spacing per source. */
export const SOURCE_HEADER_CHARS = 60;
/** System prompt tokens repeated identically across pages (low end only). */
export const CACHED_PREFIX_TOKENS = 500;
/** New text vs the current page: stricter grounding can shorten it ... */
export const OUTPUT_LOW_FACTOR = 0.7;
/** ... and drafting from every source (not a capped dossier) can lengthen it. */
export const OUTPUT_HIGH_FACTOR = 1.5;
/** Share of the thinking budget assumed at the low end. */
export const THINKING_LOW_FACTOR = 0.5;
/** Effort-level thinking (no hard cap): high end as a multiple of the budget. */
export const THINKING_EFFORT_HIGH_FACTOR = 4;
/** App work per page after the LLM call: cleanup, save, links. */
export const APP_SECONDS_PER_PAGE = 1;

/**
 * Seconds per draft_page call, sequential. "measured": from real compiles
 * (DeepSeek V4.1 Flash 5–30 s per draft, Gemini 2.5 Flash 7–8 s). The rest
 * are assumptions from each model's class (Lite faster, Pro and preview
 * slower), set wide on purpose; revise them once a run has been timed.
 */
export const SECONDS_PER_PAGE: Record<LlmModel, { low: number; high: number; measured: boolean }> = {
  'deepseek-flash': { low: 5, high: 30, measured: true },
  // Legacy ID, served by V4.1 Flash.
  'deepseek-v4-flash': { low: 5, high: 30, measured: true },
  'deepseek-v4-pro': { low: 15, high: 90, measured: false },
  'gemini-2.5-flash': { low: 7, high: 8, measured: true },
  'gemini-2.5-flash-lite': { low: 4, high: 10, measured: false },
  'gemini-2.5-pro': { low: 20, high: 60, measured: false },
  'gemini-3.8-flash': { low: 7, high: 20, measured: false },
  'gemini-3.5-flash-lite': { low: 4, high: 12, measured: false },
  'gemini-3.1-pro-preview': { low: 20, high: 90, measured: false },
};

/** GET /llm/pricing on the nlp-service (routers/llm.py LLMPricingResponse). */
export interface DraftPricing {
  input_usd_per_m: number;
  output_usd_per_m: number;
  cached_input_usd_per_m: number;
  draft_thinking_budget: number;
  draft_thinking_budget_is_cap: boolean;
  draft_max_output_tokens: number;
  draft_prompt_char_cap: number;
}

/** What one page's update reads and writes. */
export interface PageEstimateInput {
  /** Characters of all the page's active sources. */
  source_chars: number;
  source_count: number;
  /** Characters of the page as it is now. */
  page_chars: number;
}

export interface PageCostEstimate {
  input_tokens: number;
  output_tokens_low: number;
  output_tokens_high: number;
  cost_usd_low: number;
  cost_usd_high: number;
}

export function estimatePageCost(page: PageEstimateInput, pricing: DraftPricing): PageCostEstimate {
  const promptChars = Math.min(
    Math.max(0, page.source_chars) + SOURCE_HEADER_CHARS * Math.max(0, page.source_count),
    pricing.draft_prompt_char_cap,
  );
  const inputTokens = promptChars / CHARS_PER_TOKEN + PROMPT_OVERHEAD_TOKENS;

  const textTokens = Math.max(0, page.page_chars) / CHARS_PER_TOKEN;
  const budget = Math.max(0, pricing.draft_thinking_budget);
  const thinkingLow = budget * THINKING_LOW_FACTOR;
  const thinkingHigh = budget * (pricing.draft_thinking_budget_is_cap ? 1 : THINKING_EFFORT_HIGH_FACTOR);
  const outLow = Math.min(textTokens * OUTPUT_LOW_FACTOR + thinkingLow, pricing.draft_max_output_tokens);
  const outHigh = Math.min(textTokens * OUTPUT_HIGH_FACTOR + thinkingHigh, pricing.draft_max_output_tokens);

  const cached = Math.min(CACHED_PREFIX_TOKENS, inputTokens);
  const perToken = (usdPerMillion: number) => usdPerMillion / 1_000_000;
  const costLow =
    (inputTokens - cached) * perToken(pricing.input_usd_per_m) +
    cached * perToken(pricing.cached_input_usd_per_m) +
    outLow * perToken(pricing.output_usd_per_m);
  const costHigh = inputTokens * perToken(pricing.input_usd_per_m) + outHigh * perToken(pricing.output_usd_per_m);

  return {
    input_tokens: inputTokens,
    output_tokens_low: outLow,
    output_tokens_high: outHigh,
    cost_usd_low: costLow,
    cost_usd_high: costHigh,
  };
}

export interface UpgradeEstimate {
  pages: number;
  /** Rounded down to a coarse step. */
  cost_usd_low: number;
  /** Rounded up to a coarse step. The spend guard is a multiple of this. */
  cost_usd_high: number;
  minutes_low: number;
  minutes_high: number;
  /** Unrounded sums, for logs and the per-page fallback in the spend guard. */
  raw: { cost_usd_low: number; cost_usd_high: number; seconds_low: number; seconds_high: number };
}

export function estimateUpgrade(
  pages: ReadonlyArray<PageEstimateInput>,
  pricing: DraftPricing,
  model: LlmModel,
): UpgradeEstimate {
  let low = 0;
  let high = 0;
  for (const page of pages) {
    const e = estimatePageCost(page, pricing);
    low += e.cost_usd_low;
    high += e.cost_usd_high;
  }
  const speed = SECONDS_PER_PAGE[model];
  const secondsLow = pages.length * (speed.low + APP_SECONDS_PER_PAGE);
  const secondsHigh = pages.length * (speed.high + APP_SECONDS_PER_PAGE);
  const minutesLow = pages.length === 0 ? 0 : Math.max(1, Math.floor(secondsLow / 60));
  const minutesHigh = pages.length === 0 ? 0 : Math.max(minutesLow, Math.ceil(secondsHigh / 60));
  return {
    pages: pages.length,
    cost_usd_low: roundCostDown(low),
    cost_usd_high: roundCostUp(high),
    minutes_low: minutesLow,
    minutes_high: minutesHigh,
    raw: { cost_usd_low: low, cost_usd_high: high, seconds_low: secondsLow, seconds_high: secondsHigh },
  };
}

// ── Rounding and wording ───────────────────────────────────────────────────

/** Rounding step for a dollar amount: about two significant figures. */
export function costStep(usd: number): number {
  if (usd < 0.1) return 0.01;
  if (usd < 1) return 0.05;
  if (usd < 10) return 0.1;
  if (usd < 100) return 1;
  return 10;
}

const EPSILON = 1e-9;
const cents = (usd: number) => Math.round(usd * 100) / 100;

export function roundCostDown(usd: number): number {
  if (usd <= 0) return 0;
  const step = costStep(usd);
  return cents(Math.floor(usd / step + EPSILON) * step);
}

export function roundCostUp(usd: number): number {
  if (usd <= 0) return 0;
  const step = costStep(usd);
  return cents(Math.ceil(usd / step - EPSILON) * step);
}

/** "$0.45", "$3.20", "$12". */
export function formatUsd(usd: number): string {
  return usd >= 10 ? `$${usd.toFixed(0)}` : `$${usd.toFixed(2)}`;
}

/** An amount already spent: "$0.18", or "under $0.01" for a sliver. */
export function formatSpent(usd: number): string {
  if (usd > 0 && usd < 0.005) return 'under $0.01';
  return formatUsd(usd);
}

/**
 * The cost phrase after "costs": "about $0.20–$0.60", "about $0.40",
 * "up to $0.02", "less than $0.01". Takes rounded values (UpgradeEstimate).
 */
export function formatCostRange(low: number, high: number): string {
  if (high < 0.01) return 'less than $0.01';
  if (low <= 0) return `up to ${formatUsd(high)}`;
  if (formatUsd(low) === formatUsd(high)) return `about ${formatUsd(high)}`;
  return `about ${formatUsd(low)}–${formatUsd(high)}`;
}

function hours(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** The duration phrase after "takes about": "4–19 minutes", "1 minute", "1.5–9 hours". */
export function formatDuration(minutesLow: number, minutesHigh: number): string {
  if (minutesHigh <= 1) return '1 minute';
  if (minutesHigh <= 90) {
    return minutesLow === minutesHigh ? `${minutesHigh} minutes` : `${minutesLow}–${minutesHigh} minutes`;
  }
  const low = Math.max(0.5, Math.floor(minutesLow / 30) / 2);
  const high = Math.ceil(minutesHigh / 30) / 2;
  return low === high ? `${hours(high)} hours` : `${hours(low)}–${hours(high)} hours`;
}

/**
 * Would the high estimate pass today's remaining spending limit?
 * `remainingUsd` null means no daily limit is set.
 */
export function exceedsBudget(costHighUsd: number, remainingUsd: number | null): boolean {
  return remainingUsd !== null && costHighUsd > remainingUsd;
}

/** "1 page was" / "12 pages were". */
export function pagesWere(n: number): string {
  return n === 1 ? '1 page was' : `${n} pages were`;
}
