/**
 * Hybrid search (lib/hybrid-search.ts) behind GET /api/pages/search?mode=hybrid,
 * which MCP search_wiki uses. Pins: plain-language questions find pages, meaning
 * matches are merged with keyword matches, weak vector matches are dropped,
 * archived pages and Saved Links never appear, filters apply, and a failing
 * NLP service degrades to keyword results instead of failing the search.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/api/pages/search/route';
import { setSourceStatus } from '../lib/db';
import { hybridSearch } from '../lib/hybrid-search';
import { seedPage, seedProvenance, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

type Match = { page_id: string; similarity: number };

function mockVectors(result: { matches?: Match[]; status?: number; error?: Error }) {
  const fetchMock = vi.fn(async (url: string | URL) => {
    if (!String(url).endsWith('/vectors/search')) return new Response('unexpected call', { status: 599 });
    if (result.error) throw result.error;
    if (result.status !== undefined) return new Response('down', { status: result.status });
    return Response.json({ matches: result.matches ?? [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function page(id: string, title: string, content: string, extra: { page_type?: string; category?: string } = {}) {
  seedPage(handle!.db, { page_id: id, title, ...extra });
  handle!.db.prepare('INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)').run(id, title, content);
}

function seedWiki() {
  handle = setupTestDb();
  page('bitcoin', 'Bitcoin', 'Bitcoin was created by Satoshi Nakamoto in 2009.', { category: 'Crypto' });
  page('pow', 'Proof of work', 'A consensus mechanism securing the network through computation.', {
    page_type: 'concept',
    category: 'Crypto',
  });
  page('python', 'Python', 'Python is a programming language created by Guido van Rossum.', {
    category: 'Programming',
  });
}

const ids = (items: Array<{ page_id: string }>) => items.map((i) => i.page_id);

describe('hybridSearch', () => {
  it('answers a plain-language question that strict keyword search misses', async () => {
    seedWiki();
    mockVectors({ matches: [] });
    const { items, degraded } = await hybridSearch('who created bitcoin', { limit: 5 });
    expect(ids(items)[0]).toBe('bitcoin');
    expect(degraded).toBe(false);
  });

  it('adds meaning matches and ranks pages found both ways first', async () => {
    seedWiki();
    mockVectors({
      matches: [
        { page_id: 'pow', similarity: 0.62 },
        { page_id: 'bitcoin', similarity: 0.41 },
      ],
    });
    // No keyword overlap with "pow"; "bitcoin" matches by keyword and meaning.
    const { items } = await hybridSearch('how does bitcoin agree on history', { limit: 5 });
    expect(ids(items)).toEqual(['bitcoin', 'pow']);
  });

  it('drops weak meaning matches instead of padding the list', async () => {
    seedWiki();
    mockVectors({ matches: [{ page_id: 'python', similarity: 0.12 }] });
    const { items } = await hybridSearch('consensus mechanism', { limit: 5 });
    expect(ids(items)).toEqual(['pow']);
  });

  it('never returns archived pages or Saved Links', async () => {
    seedWiki();
    page('saved-links', 'Saved Links', 'bitcoin links not yet imported', { page_type: 'overview' });
    page('retired', 'Retired bitcoin page', 'bitcoin', { page_type: 'archived' });
    const lone = seedSource(handle!.db, { title: 'Lone source' });
    page('hidden', 'Hidden bitcoin page', 'bitcoin');
    seedProvenance(handle!.db, 'hidden', lone);
    setSourceStatus(lone, 'archived');
    mockVectors({ matches: [{ page_id: 'hidden', similarity: 0.9 }, { page_id: 'saved-links', similarity: 0.8 }] });

    const { items } = await hybridSearch('bitcoin', { limit: 10 });
    expect(ids(items)).toEqual(['bitcoin']);
  });

  it('applies category and page type filters to both sides', async () => {
    seedWiki();
    mockVectors({ matches: [{ page_id: 'python', similarity: 0.5 }, { page_id: 'pow', similarity: 0.5 }] });
    expect(ids((await hybridSearch('created', { limit: 5, category: 'programming' })).items)).toEqual(['python']);
    expect(ids((await hybridSearch('created', { limit: 5, pageType: 'concept' })).items)).toEqual(['pow']);
  });

  it('filters before taking candidates, so a filtered search is not cut short', async () => {
    seedWiki();
    for (let i = 0; i < 120; i++) page(`btc-${i}`, `Bitcoin note ${i}`, 'bitcoin bitcoin bitcoin', { category: 'Crypto' });
    page('btc-lang', 'Bitcoin scripting', 'bitcoin script is a stack language', { category: 'Programming' });
    mockVectors({ matches: [] });
    const { items } = await hybridSearch('bitcoin', { limit: 1, category: 'PROGRAMMING' });
    expect(ids(items)).toEqual(['btc-lang']);
  });

  it('ranks pages matching every word above pages sharing one word', async () => {
    seedWiki();
    page('history-only', 'History', 'A page about history in general.');
    page('all-words', 'Bitcoin network timeline', 'The bitcoin network history since 2009.');
    mockVectors({ matches: [] });
    const { items } = await hybridSearch('bitcoin network history', { limit: 5 });
    expect(ids(items)[0]).toBe('all-words');
    expect(ids(items)).toContain('history-only');
  });

  it('leaves questions made only of common words to meaning search', async () => {
    seedWiki();
    const fetchMock = mockVectors({ matches: [{ page_id: 'python', similarity: 0.3 }] });
    const { items } = await hybridSearch('what is it', { limit: 5 });
    expect(ids(items)).toEqual(['python']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to keyword matches when the NLP service is down or slow', async () => {
    seedWiki();
    mockVectors({ status: 503 });
    const down = await hybridSearch('bitcoin', { limit: 5 });
    expect(ids(down.items)).toEqual(['bitcoin']);
    expect(down.degraded).toBe(true);

    mockVectors({ error: new DOMException('The operation was aborted due to timeout', 'TimeoutError') });
    const slow = await hybridSearch('bitcoin', { limit: 5 });
    expect(ids(slow.items)).toEqual(['bitcoin']);
    expect(slow.degraded).toBe(true);
  });
});

describe('GET /api/pages/search', () => {
  async function search(query: string) {
    const res = await GET(new Request(`http://test/api/pages/search?${query}`));
    return (await res.json()) as Record<string, unknown>;
  }

  it('hybrid mode returns public fields and the degraded flag', async () => {
    seedWiki();
    mockVectors({ matches: [] });
    const body = await search('q=who%20invented%20bitcoin&mode=hybrid&limit=3');
    expect(body.count).toBe(1);
    expect(body.degraded).toBe(false);
    expect((body.items as Array<Record<string, unknown>>)[0]).toEqual({
      page_id: 'bitcoin',
      title: 'Bitcoin',
      page_type: 'entity',
      category: 'Crypto',
      summary: null,
      source_count: 1,
      last_updated: expect.any(String),
    });
  });

  it('hybrid mode clamps the limit to 1–100 and ignores blank filters', async () => {
    seedWiki();
    mockVectors({ matches: [] });
    expect((await search('q=created&mode=hybrid&limit=0')).count).toBe(1);
    expect((await search('q=created&mode=hybrid&limit=abc&category=%20')).count).toBe(2);
  });

  it('default mode is unchanged: strict keywords, no vector call, no degraded flag', async () => {
    seedWiki();
    const fetchMock = mockVectors({ matches: [{ page_id: 'pow', similarity: 0.9 }] });
    const body = await search('q=who%20invented%20bitcoin');
    expect(body).toEqual({ items: [], count: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
