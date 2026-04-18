/**
 * Unit tests for triggerSessionCompile — the shared n8n webhook helper that
 * replaced three fire-and-forget call sites (confirm, retry, recompile).
 *
 * Covers:
 *   1. Happy path — first POST returns 2xx → ok:true, no retry.
 *   2. Transient failure — first POST 5xx, second POST 2xx → ok:true.
 *   3. Persistent webhook error — both POSTs return 502 → ok:false, webhook_failed + upstreamStatus.
 *   4. Network error — fetch throws non-timeout → ok:false, n8n_unreachable.
 *   5. Timeout — fetch throws TimeoutError → ok:false, n8n_timeout.
 *   6. Retry count — exactly 2 POSTs on persistent failure, never more.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { triggerSessionCompile } from '../lib/trigger-n8n';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubFetch(responses: Array<Response | Error>): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('stubFetch: no more responses configured');
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function timeoutError(): Error {
  const e = new Error('timed out');
  e.name = 'TimeoutError';
  return e;
}

describe('triggerSessionCompile', () => {
  it('returns ok:true on first-attempt 2xx', async () => {
    vi.useFakeTimers();
    const spy = stubFetch([new Response(null, { status: 202 })]);
    const p = triggerSessionCompile('sid-1');
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('retries once on transient 5xx then succeeds', async () => {
    vi.useFakeTimers();
    const spy = stubFetch([
      new Response(null, { status: 503 }),
      new Response(null, { status: 202 }),
    ]);
    const p = triggerSessionCompile('sid-2');
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('returns webhook_failed + upstreamStatus on persistent non-2xx', async () => {
    vi.useFakeTimers();
    stubFetch([
      new Response(null, { status: 404 }),
      new Response(null, { status: 404 }),
    ]);
    const p = triggerSessionCompile('sid-3');
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result).toEqual({
      ok: false,
      reason: 'n8n_webhook_failed',
      upstreamStatus: 404,
    });
  });

  it('returns n8n_unreachable on network error', async () => {
    vi.useFakeTimers();
    stubFetch([new TypeError('fetch failed'), new TypeError('fetch failed')]);
    const p = triggerSessionCompile('sid-4');
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('n8n_unreachable');
  });

  it('returns n8n_timeout when AbortSignal fires TimeoutError', async () => {
    vi.useFakeTimers();
    stubFetch([timeoutError(), timeoutError()]);
    const p = triggerSessionCompile('sid-5');
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('n8n_timeout');
  });

  it('caps at 2 POST attempts — never a 3rd', async () => {
    vi.useFakeTimers();
    const spy = stubFetch([
      new Response(null, { status: 500 }),
      new Response(null, { status: 500 }),
      new Response(null, { status: 500 }), // third response should never be consumed
    ]);
    const p = triggerSessionCompile('sid-6');
    await vi.runAllTimersAsync();
    await p;
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
