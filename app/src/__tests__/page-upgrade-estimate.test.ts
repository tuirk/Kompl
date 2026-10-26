/**
 * Cost and time estimate for updating pages to the v0.4 writing rules
 * (lib/page-upgrade-estimate.ts). Pure math: no DB, no fetch.
 *
 * The numbers the user confirms come from here, and the run's spend guard is
 * a multiple of the high end, so these tests pin the formula, its constants,
 * the per-provider thinking assumption, the clamps, and the outward rounding.
 */

import { describe, expect, it } from 'vitest';
import {
  APP_SECONDS_PER_PAGE,
  CACHED_PREFIX_TOKENS,
  CHARS_PER_TOKEN,
  OUTPUT_HIGH_FACTOR,
  OUTPUT_LOW_FACTOR,
  PROMPT_OVERHEAD_TOKENS,
  SECONDS_PER_PAGE,
  SOURCE_HEADER_CHARS,
  THINKING_EFFORT_HIGH_FACTOR,
  THINKING_LOW_FACTOR,
  costStep,
  estimatePageCost,
  estimateUpgrade,
  exceedsBudget,
  formatCostRange,
  formatDuration,
  formatSpent,
  formatUsd,
  pagesWere,
  roundCostDown,
  roundCostUp,
  type DraftPricing,
} from '../lib/page-upgrade-estimate';
import { LLM_MODELS } from '../lib/llm-models';

/** deepseek-flash list prices and the draft_page limits (GET /llm/pricing). */
const DEEPSEEK_FLASH: DraftPricing = {
  input_usd_per_m: 0.3,
  output_usd_per_m: 1.2,
  cached_input_usd_per_m: 0.006,
  draft_thinking_budget: 1024,
  draft_thinking_budget_is_cap: false,
  draft_max_output_tokens: 16384,
  draft_prompt_char_cap: 128000,
};

const GEMINI_25_FLASH: DraftPricing = {
  ...DEEPSEEK_FLASH,
  input_usd_per_m: 0.3,
  output_usd_per_m: 2.5,
  cached_input_usd_per_m: 0.03,
  draft_thinking_budget_is_cap: true,
};

const PAGE = { source_chars: 20_000, source_count: 2, page_chars: 8_000 };

describe('documented constants', () => {
  it('match the formula the module documents', () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(PROMPT_OVERHEAD_TOKENS).toBe(4_000);
    expect(SOURCE_HEADER_CHARS).toBe(60);
    expect(CACHED_PREFIX_TOKENS).toBe(500);
    expect(OUTPUT_LOW_FACTOR).toBe(0.7);
    expect(OUTPUT_HIGH_FACTOR).toBe(1.5);
    expect(THINKING_LOW_FACTOR).toBe(0.5);
    expect(THINKING_EFFORT_HIGH_FACTOR).toBe(4);
    expect(APP_SECONDS_PER_PAGE).toBe(1);
  });

  it('has a speed for every model, measured ones as reported', () => {
    for (const model of LLM_MODELS) {
      const s = SECONDS_PER_PAGE[model];
      expect(s.low).toBeGreaterThan(0);
      expect(s.high).toBeGreaterThanOrEqual(s.low);
    }
    expect(SECONDS_PER_PAGE['deepseek-flash']).toEqual({ low: 5, high: 30, measured: true });
    expect(SECONDS_PER_PAGE['gemini-2.5-flash']).toEqual({ low: 7, high: 8, measured: true });
  });
});

describe('estimatePageCost', () => {
  it('prices one page from its sources, its length and the model', () => {
    const e = estimatePageCost(PAGE, DEEPSEEK_FLASH);
    // (20,000 + 2 × 60) / 4 + 4,000
    expect(e.input_tokens).toBe(9_030);
    // 8,000 / 4 = 2,000 text tokens; thinking 1,024 × [0.5, 4] (effort, not a cap)
    expect(e.output_tokens_low).toBe(2_000 * 0.7 + 512);
    expect(e.output_tokens_high).toBe(2_000 * 1.5 + 4_096);
    // low: 500 cached prompt tokens at the cached price
    expect(e.cost_usd_low).toBeCloseTo(8_530 * 0.3e-6 + 500 * 0.006e-6 + 1_912 * 1.2e-6, 12);
    expect(e.cost_usd_high).toBeCloseTo(9_030 * 0.3e-6 + 7_096 * 1.2e-6, 12);
    expect(e.cost_usd_high).toBeGreaterThan(e.cost_usd_low);
  });

  it('takes a capped thinking budget at its word (Gemini 2.5)', () => {
    const e = estimatePageCost(PAGE, GEMINI_25_FLASH);
    expect(e.output_tokens_low).toBe(1_400 + 512);
    expect(e.output_tokens_high).toBe(3_000 + 1_024);
  });

  it('bills thinking at the output price', () => {
    const noThinking = estimatePageCost(PAGE, { ...DEEPSEEK_FLASH, draft_thinking_budget: 0 });
    const withThinking = estimatePageCost(PAGE, DEEPSEEK_FLASH);
    expect(withThinking.cost_usd_high - noThinking.cost_usd_high).toBeCloseTo(4_096 * 1.2e-6, 12);
  });

  it('clamps the prompt at the draft call cap and the output at its max tokens', () => {
    const huge = { source_chars: 2_000_000, source_count: 40, page_chars: 400_000 };
    const e = estimatePageCost(huge, DEEPSEEK_FLASH);
    expect(e.input_tokens).toBe(128_000 / 4 + 4_000);
    expect(e.output_tokens_low).toBe(16_384);
    expect(e.output_tokens_high).toBe(16_384);
  });

  it('never goes negative on empty or missing sizes', () => {
    const e = estimatePageCost({ source_chars: 0, source_count: 0, page_chars: 0 }, DEEPSEEK_FLASH);
    expect(e.input_tokens).toBe(4_000);
    expect(e.cost_usd_low).toBeGreaterThan(0);
  });
});

describe('estimateUpgrade', () => {
  it('sums the pages and rounds the range outward', () => {
    const pages = Array.from({ length: 40 }, () => PAGE);
    const e = estimateUpgrade(pages, DEEPSEEK_FLASH, 'deepseek-flash');
    const one = estimatePageCost(PAGE, DEEPSEEK_FLASH);
    expect(e.pages).toBe(40);
    expect(e.raw.cost_usd_low).toBeCloseTo(one.cost_usd_low * 40, 12);
    expect(e.raw.cost_usd_high).toBeCloseTo(one.cost_usd_high * 40, 12);
    // raw ≈ $0.194–$0.449 → $0.15–$0.45 at the $0.05 step
    expect(e.cost_usd_low).toBe(0.15);
    expect(e.cost_usd_high).toBe(0.45);
    expect(e.cost_usd_low).toBeLessThanOrEqual(e.raw.cost_usd_low);
    expect(e.cost_usd_high).toBeGreaterThanOrEqual(e.raw.cost_usd_high);
  });

  it('times pages one after another at the model speed', () => {
    const pages = Array.from({ length: 40 }, () => PAGE);
    const deepseek = estimateUpgrade(pages, DEEPSEEK_FLASH, 'deepseek-flash');
    // 40 × (5 + 1) s = 4 min; 40 × (30 + 1) s = 20.7 → 21 min
    expect(deepseek.raw.seconds_low).toBe(240);
    expect(deepseek.raw.seconds_high).toBe(1_240);
    expect([deepseek.minutes_low, deepseek.minutes_high]).toEqual([4, 21]);

    const gemini = estimateUpgrade(pages, GEMINI_25_FLASH, 'gemini-2.5-flash');
    // 40 × 8 s = 5.3 min; 40 × 9 s = 6 min
    expect([gemini.minutes_low, gemini.minutes_high]).toEqual([5, 6]);
  });

  it('reports at least a minute for a small run, and zero for none', () => {
    const one = estimateUpgrade([PAGE], DEEPSEEK_FLASH, 'deepseek-flash');
    expect([one.minutes_low, one.minutes_high]).toEqual([1, 1]);
    const none = estimateUpgrade([], DEEPSEEK_FLASH, 'deepseek-flash');
    expect(none).toMatchObject({ pages: 0, cost_usd_low: 0, cost_usd_high: 0, minutes_low: 0, minutes_high: 0 });
  });

  it('scales with the model price', () => {
    const pages = [PAGE, PAGE, PAGE];
    const cheap = estimateUpgrade(pages, DEEPSEEK_FLASH, 'deepseek-flash');
    const pricey = estimateUpgrade(pages, { ...DEEPSEEK_FLASH, input_usd_per_m: 3, output_usd_per_m: 12 }, 'deepseek-v4-pro');
    expect(pricey.raw.cost_usd_high).toBeGreaterThan(cheap.raw.cost_usd_high * 9);
  });
});

describe('rounding', () => {
  it('uses about two significant figures', () => {
    expect(costStep(0.004)).toBe(0.01);
    expect(costStep(0.45)).toBe(0.05);
    expect(costStep(3.2)).toBe(0.1);
    expect(costStep(42)).toBe(1);
    expect(costStep(420)).toBe(10);
  });

  it('rounds the low end down and the high end up', () => {
    expect(roundCostDown(0.194)).toBe(0.15);
    expect(roundCostUp(0.449)).toBe(0.45);
    expect(roundCostUp(0.4501)).toBe(0.5);
    expect(roundCostDown(3.27)).toBe(3.2);
    expect(roundCostUp(3.21)).toBe(3.3);
    expect(roundCostUp(41.2)).toBe(42);
    expect(roundCostUp(0.0042)).toBe(0.01);
    expect(roundCostDown(0.0042)).toBe(0);
    expect(roundCostUp(0)).toBe(0);
  });

  it('keeps exact steps exact despite floating point', () => {
    expect(roundCostUp(0.3)).toBe(0.3);
    expect(roundCostDown(0.3)).toBe(0.3);
    expect(roundCostUp(1.1)).toBe(1.1);
  });
});

describe('wording', () => {
  it('formats a cost range without false precision', () => {
    expect(formatCostRange(0.15, 0.45)).toBe('about $0.15–$0.45');
    expect(formatCostRange(12, 35)).toBe('about $12–$35');
    expect(formatCostRange(0.4, 0.4)).toBe('about $0.40');
    expect(formatCostRange(0, 0.02)).toBe('up to $0.02');
    expect(formatCostRange(0, 0.004)).toBe('less than $0.01');
  });

  it('formats money', () => {
    expect(formatUsd(0.5)).toBe('$0.50');
    expect(formatUsd(9.99)).toBe('$9.99');
    expect(formatUsd(10)).toBe('$10');
    expect(formatSpent(0)).toBe('$0.00');
    expect(formatSpent(0.003)).toBe('under $0.01');
    expect(formatSpent(0.18)).toBe('$0.18');
  });

  it('formats a duration in minutes, or hours for long runs', () => {
    expect(formatDuration(1, 1)).toBe('1 minute');
    expect(formatDuration(4, 21)).toBe('4–21 minutes');
    expect(formatDuration(5, 5)).toBe('5 minutes');
    expect(formatDuration(100, 517)).toBe('1.5–9 hours');
    expect(formatDuration(120, 120)).toBe('2 hours');
  });

  it('counts pages', () => {
    expect(pagesWere(1)).toBe('1 page was');
    expect(pagesWere(37)).toBe('37 pages were');
  });
});

describe('exceedsBudget', () => {
  it('warns only when a daily limit is set and the high estimate passes it', () => {
    expect(exceedsBudget(0.6, 1.2)).toBe(false);
    expect(exceedsBudget(1.3, 1.2)).toBe(true);
    expect(exceedsBudget(0.01, 0)).toBe(true);
    expect(exceedsBudget(500, null)).toBe(false);
  });
});
