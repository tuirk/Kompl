import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callConvertUrl } from '../lib/nlp-convert';

describe('callConvertUrl error-code branches', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('maps AbortSignal.timeout DOMException (name=TimeoutError) to nlp_convert_timeout', async () => {
    const timeoutErr = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    globalThis.fetch = vi.fn().mockRejectedValue(timeoutErr) as typeof fetch;

    const result = await callConvertUrl('src-1', 'https://example.com/slow');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('nlp_convert_timeout');
      expect(result.detail).toContain('aborted');
    }
  });

  it('maps ECONNREFUSED-style TypeError to nlp_unreachable', async () => {
    const connErr = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    globalThis.fetch = vi.fn().mockRejectedValue(connErr) as typeof fetch;

    const result = await callConvertUrl('src-2', 'https://example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('nlp_unreachable');
    }
  });

  it('maps 504 response to nlp_convert_failed (Firecrawl timeout is an upstream failure, not unreachable)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('firecrawl_timeout', { status: 504 })
    ) as typeof fetch;

    const result = await callConvertUrl('src-3', 'https://example.com/hard');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('nlp_convert_failed');
      expect(result.detail).toContain('504');
    }
  });

  it('maps 502 response to nlp_convert_failed (Firecrawl error is an upstream failure)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"detail":"firecrawl_error"}', { status: 502 })
    ) as typeof fetch;

    const result = await callConvertUrl('src-4', 'https://example.com/blocked');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('nlp_convert_failed');
    }
  });

  it('maps 503 response to nlp_unreachable (FastAPI shutdown is the only true unreachable status)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('service unavailable', { status: 503 })
    ) as typeof fetch;

    const result = await callConvertUrl('src-5', 'https://example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('nlp_unreachable');
    }
  });

  it('maps 500 response to nlp_convert_failed', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('internal error', { status: 500 })
    ) as typeof fetch;

    const result = await callConvertUrl('src-6', 'https://example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('nlp_convert_failed');
    }
  });

  it('maps 422 response to nlp_convert_failed', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('conversion_failed: insufficient content', { status: 422 })
    ) as typeof fetch;

    const result = await callConvertUrl('src-7', 'https://example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('nlp_convert_failed');
    }
  });

  it('returns ok:true with parsed JSON on 200', async () => {
    const payload = {
      source_id: 'src-8',
      source_type: 'url',
      title: 'Ex',
      source_url: 'https://example.com',
      markdown: '# Ex',
      content_hash: 'abc',
      metadata: {},
    };
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    ) as typeof fetch;

    const result = await callConvertUrl('src-8', 'https://example.com');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.markdown).toBe('# Ex');
    }
  });
});
