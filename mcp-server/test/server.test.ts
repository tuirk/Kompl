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
  it('lists every tool with a title; all but add_source are read-only', async () => {
    const client = await connect(fakeKompl({}).fetchImpl);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_source',
      'list_sources',
      'read_page',
      'read_source',
      'recent_changes',
      'research_topic',
      'search_wiki',
      'wiki_status',
    ]);
    for (const tool of tools.filter((t) => t.name !== 'add_source')) {
      expect(tool.title).toBeTruthy();
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.openWorldHint).toBe(false);
    }
  });

  it('sends server instructions that explain [n] citations, short enough for every client', async () => {
    const client = await connect(fakeKompl({}).fetchImpl);
    expect(client.getInstructions()).toMatch(/\[n\]/);
    expect(client.getInstructions()!.length).toBeLessThan(2000);
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

describe('search_wiki with a query', () => {
  it('asks for hybrid search with the filters and keeps the result format', async () => {
    const kompl = fakeKompl({ '/api/pages/search': { items: [PAGE], count: 1, degraded: false } });
    const res = await call(await connect(kompl.fetchImpl), 'search_wiki', {
      query: 'how do networks agree',
      category: 'Cryptocurrency',
      page_type: 'concept',
      limit: 5,
    });
    expect(res).toEqual({
      text:
        '1 result(s):\n\n' +
        '**Proof of work** (concept) [Cryptocurrency] — A consensus mechanism.\n  ID: `proof-of-work-1`',
      isError: false,
    });
    expect(Object.fromEntries(kompl.requested[0].searchParams)).toEqual({
      q: 'how do networks agree',
      mode: 'hybrid',
      limit: '5',
      category: 'Cryptocurrency',
      page_type: 'concept',
    });
  });

  it('pages through results with offset and says when more may match', async () => {
    const items = [PAGE, PYTHON, { ...PAGE, page_id: 'p3', title: 'Third' }];
    const kompl = fakeKompl({ '/api/pages/search': { items, count: 3, degraded: false } });
    const res = await call(await connect(kompl.fetchImpl), 'search_wiki', { query: 'x', limit: 2, offset: 1 });
    expect(kompl.requested[0].searchParams.get('limit')).toBe('3');
    expect(res.text.startsWith('2 result(s):')).toBe(true);
    expect(res.text).not.toContain('Proof of work');
    expect(res.text).toContain('More may match: call again with offset=3.');
  });

  it('says when meaning-based search was unavailable', async () => {
    const kompl = fakeKompl({ '/api/pages/search': { items: [PAGE], count: 1, degraded: true } });
    const res = await call(await connect(kompl.fetchImpl), 'search_wiki', { query: 'x' });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('keyword matches only');
  });

  it('reports an empty result without flagging an error', async () => {
    const client = await connect(fakeKompl({ '/api/pages/search': { items: [], count: 0, degraded: false } }).fetchImpl);
    expect(await call(client, 'search_wiki', { query: 'nothing' })).toEqual({
      text: 'No results found.',
      isError: false,
    });
  });

  it('says when paging went past the last result', async () => {
    const kompl = fakeKompl({ '/api/pages/search': { items: [PAGE], count: 1, degraded: false } });
    expect(await call(await connect(kompl.fetchImpl), 'search_wiki', { query: 'x', offset: 5 })).toEqual({
      text: 'No more results: 1 matched.',
      isError: false,
    });
  });

  it('applies filters itself and asks for an update when the app predates hybrid search', async () => {
    const SAVED = { ...PAGE, page_id: 'saved-links', title: 'Saved Links' };
    const kompl = fakeKompl({ '/api/pages/search': { items: [SAVED, PAGE, PYTHON], count: 3 } });
    const res = await call(await connect(kompl.fetchImpl), 'search_wiki', { query: 'x', category: 'programming' });
    expect(res.text).toContain('**Python**');
    expect(res.text).not.toContain('Proof of work');
    expect(res.text).not.toContain('Saved Links');
    expect(res.text).toContain('Run `kompl update`');
  });

  it('refuses offsets past the search cap', async () => {
    const res = await call(await connect(fakeKompl({}).fetchImpl), 'search_wiki', { query: 'x', offset: 100 });
    expect(res.isError).toBe(true);
  });
});

describe('search_wiki without a query (browse)', () => {
  const SAVED = { ...PAGE, page_id: 'saved-links', title: 'Saved Links', page_type: 'overview', category: null };
  const index = fakeKompl({
    '/api/wiki/index': { total_pages: 3, categories: {}, pages: [SAVED, PAGE, PYTHON] },
  }).fetchImpl;

  it('lists pages newest first, without Saved Links, in the list format', async () => {
    expect(await call(await connect(index), 'search_wiki', {})).toEqual({
      text: [
        'Pages 1–2 of 2, newest first:',
        '',
        '• **Proof of work** (concept) [Cryptocurrency] — 2 source(s)\n  ID: `proof-of-work-1`',
        '',
        '• **Python** (entity) [Programming] — 2 source(s)\n  ID: `p2`',
      ].join('\n'),
      isError: false,
    });
  });

  it('treats a blank query as browsing', async () => {
    const res = await call(await connect(index), 'search_wiki', { query: '   ' });
    expect(res.text.startsWith('Pages 1–2 of 2')).toBe(true);
  });

  it('filters by category (case-insensitive) and page type', async () => {
    expect((await call(await connect(index), 'search_wiki', { category: 'programming' })).text).toContain('Python');
    const concepts = await call(await connect(index), 'search_wiki', { page_type: 'concept' });
    expect(concepts.text).toContain('Proof of work');
    expect(concepts.text).not.toContain('Python');
  });

  it('pages with offset and points to the next page', async () => {
    const first = await call(await connect(index), 'search_wiki', { limit: 1 });
    expect(first.text).toContain('Pages 1–1 of 2');
    expect(first.text).toContain('More: call again with offset=1.');
    const past = await call(await connect(index), 'search_wiki', { offset: 5 });
    expect(past).toEqual({ text: 'No more pages: there are 2.', isError: false });
  });

  it('says when nothing matches the filters', async () => {
    expect(await call(await connect(index), 'search_wiki', { page_type: 'comparison' })).toEqual({
      text: 'No pages match the given filters.',
      isError: false,
    });
  });

  it('flags a failed catalogue load', async () => {
    expect((await call(await connect(down), 'search_wiki', {})).isError).toBe(true);
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
        '  [1] Bitcoin paper — source_id `s1`',
        '',
        'To check what a source says, call read_source with its source_id (or this page_id and n).',
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
    expect(res.text).toContain('\n  - Bitcoin paper (primary) · source_id `s1`');
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
