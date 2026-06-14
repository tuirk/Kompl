/**
 * App-side mirror of the nlp-service DISAMBIGUATE_MAX_PAIRS cap
 * (CLAUDE.md rule #7 — every LLM loop needs a hard iteration cap).
 *
 * Regression target: /api/compile/resolve forwarded EVERY ambiguous pair
 * from Layer 2 to /resolve/disambiguate. A dense session (N entities in the
 * 0.7–0.9 cosine band) produces O(N²) pairs → unbounded LLM calls and spend.
 *
 * Asserts that the resolve route slices ambiguous pairs to 120 before
 * calling disambiguate, and that overflow pairs degrade safely to separate
 * singleton entities (never an over-merge).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as resolvePOST } from '../app/api/compile/resolve/route';
import { setupTestDb, seedSource, seedExtraction, type TestDbHandle } from './helpers/test-db';

const MAX_PAIRS = 120; // mirror of the route-private MAX_DISAMBIGUATE_PAIRS

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

function makeRequest(session_id: string): Request {
  return new Request('http://test/api/compile/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id }),
  });
}

it('slices ambiguous pairs to the cap and keeps overflow as singletons', async () => {
  handle = setupTestDb();
  const session_id = 'sess-cap';
  const source_id = seedSource(handle.db, {
    onboarding_session_id: session_id,
    compile_status: 'extracted',
  });

  // 2 entities are enough input — the (mocked) embedding layer is what
  // fabricates the oversized ambiguous-pair list.
  seedExtraction(handle.db, {
    source_id,
    llm_output: {
      entities: [
        { name: 'Entity A', type: 'ORG', context: 'ctx' },
        { name: 'Entity B', type: 'ORG', context: 'ctx' },
      ],
      concepts: [],
      relationships: [],
    },
  });

  const PAIR_COUNT = MAX_PAIRS + 17;
  const ambiguous = Array.from({ length: PAIR_COUNT }, (_, i) => ({
    entity_a: { name: `Amb${i}A`, type: 'ORG', source_id, context: '' },
    entity_b: { name: `Amb${i}B`, type: 'ORG', source_id, context: '' },
    similarity: 0.8,
  }));

  let disambiguateCalls = 0;
  let disambiguatePairsSent = -1;

  const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

    if (url.endsWith('/resolve/fuzzy')) {
      return Response.json({ resolved: [], unresolved: body.entities });
    }
    if (url.endsWith('/resolve/embedding')) {
      return Response.json({ resolved: [], ambiguous, unresolved: [] });
    }
    if (url.endsWith('/resolve/disambiguate')) {
      disambiguateCalls++;
      const pairs = body.pairs as typeof ambiguous;
      disambiguatePairsSent = pairs.length;
      return Response.json({
        results: pairs.map((p) => ({
          entity_a: p.entity_a.name,
          entity_b: p.entity_b.name,
          decision: 'different',
          canonical: null,
          reason: 'mock',
        })),
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', mockFetch);

  const res = await resolvePOST(makeRequest(session_id));
  expect(res.status).toBe(200);

  // The LLM layer saw exactly the cap, never the full pair list.
  expect(disambiguateCalls).toBe(1);
  expect(disambiguatePairsSent).toBe(MAX_PAIRS);

  // Overflow pairs degraded to separate singletons — both sides present,
  // nothing merged.
  const json = (await res.json()) as {
    canonical_entities: Array<{ canonical: string; method: string }>;
  };
  const names = new Set(json.canonical_entities.map((e) => e.canonical));
  expect(names.has(`Amb${MAX_PAIRS}A`)).toBe(true);
  expect(names.has(`Amb${MAX_PAIRS}B`)).toBe(true);
  expect(names.has(`Amb${PAIR_COUNT - 1}A`)).toBe(true);
  expect(names.has(`Amb${PAIR_COUNT - 1}B`)).toBe(true);
});

it('does not call disambiguate at all when every pair is overflow-free and empty', async () => {
  handle = setupTestDb();
  const session_id = 'sess-nopairs';
  const source_id = seedSource(handle.db, {
    onboarding_session_id: session_id,
    compile_status: 'extracted',
  });
  seedExtraction(handle.db, {
    source_id,
    llm_output: {
      entities: [{ name: 'Solo', type: 'ORG', context: '' }],
      concepts: [],
      relationships: [],
    },
  });

  const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.endsWith('/resolve/fuzzy')) {
      return Response.json({ resolved: [], unresolved: body.entities });
    }
    if (url.endsWith('/resolve/embedding')) {
      return Response.json({ resolved: [], ambiguous: [], unresolved: body.entities });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', mockFetch);

  const res = await resolvePOST(makeRequest(session_id));
  expect(res.status).toBe(200);
  expect(mockFetch.mock.calls.some(([u]) => String(u).includes('disambiguate'))).toBe(false);
});
