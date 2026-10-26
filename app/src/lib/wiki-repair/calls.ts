/**
 * The wiki repair's nlp-service calls: the prices its estimate reads, and
 * one POST helper that turns the statuses a run must stop on into a
 * RepairCallError with a code the run reads (daily cost ceiling, rate
 * limit, service down).
 */

import type { LlmModel } from '../llm-models';
import { makeDispatcher } from '../long-http-agent';
import { OUT_OF_CREDIT_MESSAGE, isOutOfCredit } from '../out-of-credit';
import type { RepairPricing } from './estimate';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

export type RepairCallCode = 'daily_cost_ceiling' | 'rate_limited' | 'nlp_unreachable' | 'call_failed';

export class RepairCallError extends Error {
  constructor(
    readonly code: RepairCallCode,
    message: string,
  ) {
    super(message);
    this.name = 'RepairCallError';
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const PRICING_NUMBERS = [
  'input_usd_per_m', 'output_usd_per_m', 'cached_input_usd_per_m', 'draft_thinking_budget',
  'draft_max_output_tokens', 'draft_prompt_char_cap', 'disambiguate_thinking_budget',
  'disambiguate_max_output_tokens', 'label_merge_thinking_budget', 'label_merge_max_output_tokens',
] as const;

/** GET /llm/pricing, the fields the repair estimate reads (nlp-service routers/llm.py). */
export async function fetchRepairPricing(model: LlmModel): Promise<RepairPricing> {
  const res = await fetch(`${NLP_SERVICE_URL}/llm/pricing?model=${encodeURIComponent(model)}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`llm_pricing_failed: ${res.status}`);
  const b = (await res.json()) as Record<string, unknown>;
  for (const key of PRICING_NUMBERS) if (!isNum(b[key])) throw new Error(`llm_pricing_invalid: ${key}`);
  if (typeof b.draft_thinking_budget_is_cap !== 'boolean') throw new Error('llm_pricing_invalid: draft_thinking_budget_is_cap');
  const numbers = Object.fromEntries(PRICING_NUMBERS.map((k) => [k, b[k] as number])) as Omit<RepairPricing, 'draft_thinking_budget_is_cap'>;
  return { ...numbers, draft_thinking_budget_is_cap: b.draft_thinking_budget_is_cap };
}

export async function postNlp<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${NLP_SERVICE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      // @ts-expect-error — dispatcher is an undici-specific fetch option not in the DOM RequestInit type
      dispatcher: makeDispatcher(timeoutMs), // undici's default 300s headersTimeout would fire first
    });
  } catch (err) {
    throw new RepairCallError('nlp_unreachable', `Kompl's NLP service did not answer: ${String(err)}`);
  }
  if (res.status === 503) {
    const detail = await res.text().catch(() => '');
    throw new RepairCallError('daily_cost_ceiling', isOutOfCredit(res.status, detail) ? OUT_OF_CREDIT_MESSAGE : "Today's AI spending limit is reached.");
  }
  if (res.status === 429) throw new RepairCallError('rate_limited', 'The AI model is busy (rate-limited).');
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new RepairCallError('call_failed', `${path} failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}
