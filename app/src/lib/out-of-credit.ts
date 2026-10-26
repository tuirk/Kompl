/**
 * An AI provider account with no credit left (DeepSeek answers HTTP 402).
 * nlp-service answers it like the daily spending limit, with status 503, so
 * whatever stops at the limit stops at it too, and names it in the detail
 * (llm_client.cost_ceiling_detail): raising the limit would not help,
 * topping up the account does. A compile step stops at once on it instead
 * of failing every remaining page or source with its own call.
 */

export const OUT_OF_CREDIT = 'provider_out_of_credit';

export const OUT_OF_CREDIT_MESSAGE =
  'The AI provider account has no credit left. Top it up with the provider, then try again.';

/** An nlp-service (or compile route) answer saying the account is empty. */
export function isOutOfCredit(status: number, body: string): boolean {
  return status === 503 && body.includes(OUT_OF_CREDIT);
}

export class OutOfCreditError extends Error {
  readonly status = 503;
  readonly code = OUT_OF_CREDIT;

  constructor() {
    super(OUT_OF_CREDIT_MESSAGE);
    this.name = 'OutOfCreditError';
  }
}
