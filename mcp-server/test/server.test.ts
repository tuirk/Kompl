import { describe, expect, it } from 'vitest';
import { call, connect, fakeKompl, json } from './helpers.js';

const PAGE = {
  page_id: 'proof-of-work-1',
  title: 'Proof of work',
  page_type: 'concept',
  category: 'Cryptocurrency',
  summary: 'A consensus mechanism.',
  source_count: 2,
  last_updated: '2026-10-01 10:00:00',
};
const PYTHON = { ...PAGE, page_id: 'p2', title: 'Python', page_type: 'entity', category: 'Programming' };

const down = (async () => {
  throw new TypeError('fetch failed');
}) as typeof fetch;

describe('tool catalogue', () => {
  it('lists every tool with a title and read-only annotations', async () => {
    const client = await connect(fakeKompl({}).fetchImpl);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['list_pages', 'read_page', 'search_wiki', 'wiki_stats']);
    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.openWorldHint).toBe(false);
    }
  });

  it('sends server instructions that explain [n] citations', async () => {
    const client = await connect(fakeKompl({}).fetchImpl);
    expect(client.getInstructions()).toMatch(/\[n\]/);
  });
});

describe('kompl client failures', () => {
  it('flags an unreachable app as an error', async () => {
    const res = await call(await connect(down), 'search_wiki', { query: 'x' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/isn't reachable.*kompl start/);
  });

  it('flags a slow app as an error', async () => {
    const slow = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof fetch;
    const res = await call(await connect(slow, 50), 'search_wiki', { query: 'x' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/took longer than/);
  });

  it('reports a timeout while reading the body as a timeout', async () => {
    const stalled = (async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new DOMException('timed out', 'TimeoutError'));
          },
        }),
        { status: 200 }
      )) as typeof fetch;
    const res = await call(await connect(stalled), 'search_wiki', { query: 'x' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/took longer than/);
  });

  it('flags an invalid KOMPL_URL instead of throwing', async () => {
    const res = await call(await connect(down, 1000, ''), 'search_wiki', { query: 'x' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/KOMPL_URL "" isn't a valid URL/);
  });

  it('passes the app error code through', async () => {
    const kompl = fakeKompl({ '/api/pages/search': () => json({ error: 'db_locked' }, 500) });
    const res = await call(await connect(kompl.fetchImpl), 'search_wiki', { query: 'x' });
    expect(res).toEqual({ text: 'Search failed: db_locked', isError: true });
  });
});

describe('search_wiki', () => {
  it('passes the query and limit and keeps the result format', async () => {
    const kompl = fakeKompl({ '/api/pages/search': { items: [PAGE], count: 1 } });
    const res = await call(await connect(kompl.fetchImpl), 'search_wiki', { query: 'consensus', limit: 5 });
    expect(res).toEqual({
      text:
        '1 result(s):\n\n' +
        '**Proof of work** (concept) [Cryptocurrency] — A consensus mechanism.\n  ID: `proof-of-work-1`',
      isError: false,
    });
    expect(kompl.requested[0].searchParams.get('q')).toBe('consensus');
    expect(kompl.requested[0].searchParams.get('limit')).toBe('5');
  });

  it('reports an empty result without flagging an error', async () => {
    const client = await connect(fakeKompl({ '/api/pages/search': { items: [], count: 0 } }).fetchImpl);
    expect(await call(client, 'search_wiki', { query: 'nothing' })).toEqual({
      text: 'No results found.',
      isError: false,
    });
  });
});

describe('read_page', () => {
  const pageData = (overrides: Record<string, unknown>) =>
    fakeKompl({ '/api/wiki/proof-of-work-1/data': { ...PAGE, ...overrides } }).fetchImpl;

  it('keeps the page format with numbered sources', async () => {
    const fetchImpl = pageData({
      content: 'Miners compete [1].',
      sources: [{ n: 1, source_id: 's1', title: 'Bitcoin paper', contribution_type: 'cited' }],
    });
    const res = await call(await connect(fetchImpl), 'read_page', { page_id: 'proof-of-work-1' });
    expect(res).toEqual({
      text: [
        '# Proof of work',
        'Type: concept | Category: Cryptocurrency | Sources: 2',
        'Last updated: 2026-10-01 10:00:00',
        '',
        'Miners compete [1].',
        '',
        '---',
        '**Sources** (the [n] markers above refer to these):',
        '  [1] Bitcoin paper',
      ].join('\n'),
      isError: false,
    });
  });

  it('lists unnumbered sources from older apps by contribution', async () => {
    const fetchImpl = pageData({
      content: 'Text.',
      sources: [{ source_id: 's1', title: 'Bitcoin paper', contribution_type: 'primary' }],
    });
    const res = await call(await connect(fetchImpl), 'read_page', { page_id: 'proof-of-work-1' });
    expect(res.text).toContain('\n  - Bitcoin paper (primary)');
  });

  it('marks empty content and no sources', async () => {
    const res = await call(await connect(pageData({ content: '', sources: [] })), 'read_page', {
      page_id: 'proof-of-work-1',
    });
    expect(res.text).toContain('\n(no content)\n');
    expect(res.text.endsWith('\n  (none)')).toBe(true);
  });

  it('flags an unknown page as an error with a next step', async () => {
    const res = await call(await connect(fakeKompl({}).fetchImpl), 'read_page', { page_id: 'nope' });
    expect(res).toEqual({ text: 'Page not found: nope. Use search_wiki to find page ids.', isError: true });
  });
});

describe('list_pages', () => {
  const index = fakeKompl({
    '/api/wiki/index': { total_pages: 2, categories: {}, pages: [PAGE, PYTHON] },
  }).fetchImpl;

  it('filters by category (case-insensitive) and keeps the list format', async () => {
    expect(await call(await connect(index), 'list_pages', { category: 'programming' })).toEqual({
      text: '1 page(s):\n\n• **Python** (entity) [Programming] — 2 source(s)\n  ID: `p2`',
      isError: false,
    });
  });

  it('filters by page type', async () => {
    const res = await call(await connect(index), 'list_pages', { page_type: 'concept' });
    expect(res.text).toContain('Proof of work');
    expect(res.text).not.toContain('Python');
  });

  it('says when nothing matches', async () => {
    expect(await call(await connect(index), 'list_pages', { page_type: 'comparison' })).toEqual({
      text: 'No pages match the given filters.',
      isError: false,
    });
  });

  it('flags a failed catalogue load', async () => {
    const res = await call(await connect(down), 'list_pages');
    expect(res.isError).toBe(true);
  });
});

describe('wiki_stats', () => {
  const STATS = {
    source_count: 13,
    page_count: 23,
    entity_count: 7,
    concept_count: 7,
    last_ingested: '2026-10-09 18:00:00',
    last_compiled: null,
  };

  it('reads the stats routes and never the side-effecting health check', async () => {
    const kompl = fakeKompl({
      '/api/wiki/stats': STATS,
      '/api/wiki/index': { total_pages: 23, categories: { A: [], B: [] }, pages: [] },
      '/api/health': () => json({ error: 'must not be called' }, 500),
    });
    const res = await call(await connect(kompl.fetchImpl), 'wiki_stats');
    expect(res).toEqual({
      text: [
        '**Kompl Wiki Stats**',
        '• Sources: 13 active',
        '• Pages: 23 (7 entities, 7 concepts)',
        '• Categories: 2',
        '• Last source added: 2026-10-09 18:00:00',
        '• Last compile: never',
      ].join('\n'),
      isError: false,
    });
    expect(kompl.requested.map((u) => u.pathname)).not.toContain('/api/health');
  });

  it('still answers when only the category count is unavailable', async () => {
    const kompl = fakeKompl({ '/api/wiki/stats': STATS });
    const res = await call(await connect(kompl.fetchImpl), 'wiki_stats');
    expect(res.isError).toBe(false);
    expect(res.text).toContain('• Categories: unknown');
  });

  it('flags missing stats as an error', async () => {
    const res = await call(await connect(fakeKompl({}).fetchImpl), 'wiki_stats');
    expect(res.isError).toBe(true);
  });
});
