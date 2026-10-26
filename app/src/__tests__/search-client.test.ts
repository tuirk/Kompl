/**
 * The app's search boxes (lib/search-client.ts): they ask for hybrid search,
 * the route understands what they send, archived pages stay hidden, and a
 * newer query (or an emptied box) cancels the search in flight so a slow
 * answer can't replace newer results.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/api/pages/search/route';
import { createSearch, debounce, searchUrl, type SearchHit } from '../lib/search-client';
import { seedPage, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  handle?.cleanup();
  handle = null;
});

function hit(page_id: string): SearchHit {
  return {
    page_id,
    title: page_id,
    page_type: 'entity',
    category: null,
    summary: null,
    source_count: 1,
    last_updated: '2026-10-10 12:00:00',
  };
}

/** A server that answers when the test says so; an abort rejects the request, like fetch. */
function slowServer() {
  const requests: Array<{ url: string; signal: AbortSignal; answer(items: SearchHit[], status?: number): void }> = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      requests.push({
        url: String(input),
        signal,
        answer: (items, status = 200) => resolve(Response.json({ items, count: items.length, degraded: false }, { status })),
      });
    })) as typeof fetch;
  return { fetchFn, requests };
}

describe('searchUrl', () => {
  it('asks for hybrid search with the trimmed query and an optional limit', () => {
    expect(searchUrl('  who founded Vilnius? ')).toBe('/api/pages/search?q=who+founded+Vilnius%3F&mode=hybrid');
    expect(searchUrl('lake', 3)).toBe('/api/pages/search?q=lake&mode=hybrid&limit=3');
  });
});

describe('createSearch', () => {
  it('returns the hits', async () => {
    const server = slowServer();
    const search = createSearch(server.fetchFn);
    const pending = search('bitcoin', 3);
    server.requests[0].answer([hit('bitcoin')]);
    expect(await pending).toEqual([hit('bitcoin')]);
    expect(server.requests[0].url).toBe('/api/pages/search?q=bitcoin&mode=hybrid&limit=3');
  });

  it('a newer query cancels the one in flight, whose late answer is dropped', async () => {
    const server = slowServer();
    const search = createSearch(server.fetchFn);
    const older = search('lake');
    const newer = search('lake galve');
    expect(server.requests[0].signal.aborted).toBe(true);
    expect(server.requests[1].signal.aborted).toBe(false);
    server.requests[1].answer([hit('lake-galve')]);
    expect(await older).toBeNull();
    expect(await newer).toEqual([hit('lake-galve')]);
  });

  it('drops an answer that arrives after the abort anyway', async () => {
    const answers: Array<() => void> = [];
    const stubborn = (async () =>
      new Promise<Response>((resolve) => {
        answers.push(() => resolve(Response.json({ items: [hit('stale')], count: 1, degraded: false })));
      })) as typeof fetch;
    const search = createSearch(stubborn);
    const older = search('lake');
    search.cancel();
    answers[0]();
    expect(await older).toBeNull();
  });

  it('cancel drops the search in flight', async () => {
    const server = slowServer();
    const search = createSearch(server.fetchFn);
    const pending = search('vilnius');
    search.cancel();
    expect(server.requests[0].signal.aborted).toBe(true);
    expect(await pending).toBeNull();
  });

  it('a failed request rejects, so the box can show the error', async () => {
    const server = slowServer();
    const search = createSearch(server.fetchFn);
    const pending = search('bitcoin');
    server.requests[0].answer([], 500);
    await expect(pending).rejects.toThrow('search failed: 500');
  });

  it('the route understands the request: meaning-style questions match, archived pages stay hidden', async () => {
    handle = setupTestDb();
    for (const [id, title, content, page_type] of [
      ['bitcoin', 'Bitcoin', 'Bitcoin was created by Satoshi Nakamoto in 2009.', 'entity'],
      ['old-bitcoin', 'Bitcoin (old notes)', 'Bitcoin was created by Satoshi Nakamoto.', 'archived'],
    ] as const) {
      seedPage(handle.db, { page_id: id, title, page_type });
      handle.db.prepare('INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)').run(id, title, content);
    }
    // The meaning half (NLP service) finds nothing extra here.
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ matches: [] })));
    const search = createSearch((input, init) => GET(new Request(new URL(String(input), 'http://test'), init)));

    // Keyword-only search needs every word ("who" isn't in the page); hybrid doesn't.
    expect((await search('who created bitcoin', 3))?.map((h) => h.page_id)).toEqual(['bitcoin']);
  });
});

describe('debounce', () => {
  it('calls once typing pauses, with the latest query', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 250);
    debounced('la');
    vi.advanceTimersByTime(200);
    debounced('lake');
    vi.advanceTimersByTime(249);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('lake');
  });

  it('cancel drops the call still waiting', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const debounced = debounce(fn, 250);
    debounced('lake');
    debounced.cancel();
    vi.advanceTimersByTime(1_000);
    expect(fn).not.toHaveBeenCalled();
  });
});
