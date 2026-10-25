import { describe, expect, it } from 'vitest';
import { call, connect, fakeKompl, json } from './helpers.js';

const SOURCE = {
  source_id: 's1',
  title: 'Bitcoin explained',
  source_type: 'url',
  source_url: 'https://example.com/btc',
  status: 'active',
  date_ingested: '2026-09-30 08:00:00',
  total_chars: 9000,
};
const PAGE = {
  page_id: 'pow',
  title: 'Proof of work',
  page_type: 'concept',
  category: null,
  summary: null,
  source_count: 1,
  last_updated: '2026-10-01 10:00:00',
  content: 'Miners compete[1].',
  sources: [{ n: 1, source_id: 's1', title: 'Bitcoin explained', contribution_type: 'created' }],
};

describe('read_source', () => {
  it('returns the passages matching a query', async () => {
    const kompl = fakeKompl({
      '/api/sources/s1/content': {
        ...SOURCE,
        mode: 'passages',
        query: 'mining energy',
        passages: [{ text: 'Mining consumes significant energy.', heading: 'Mining', start: 120 }],
      },
    });
    const res = await call(await connect(kompl.fetchImpl), 'read_source', { source_id: 's1', query: 'mining energy' });
    expect(res).toEqual({
      text: [
        '# Bitcoin explained',
        'url · added 2026-09-30 · https://example.com/btc',
        '',
        'Passages matching "mining energy" (of 9000 characters):',
        '',
        '--- Mining (at character 120)\nMining consumes significant energy.',
      ].join('\n'),
      isError: false,
    });
    expect(kompl.requested[0].searchParams.get('q')).toBe('mining energy');
    expect(kompl.requested[0].searchParams.has('offset')).toBe(false);
  });

  it('follows citation [n] of a page and pages through the text', async () => {
    const kompl = fakeKompl({
      '/api/wiki/pow/data': PAGE,
      '/api/sources/s1/content': { ...SOURCE, mode: 'text', offset: 8000, text: 'The end.', next_offset: null },
    });
    const res = await call(await connect(kompl.fetchImpl), 'read_source', { page_id: 'pow', n: 1, offset: 8000 });
    expect(res.text).toContain('Source [1] of "Proof of work"');
    expect(res.text).toContain('Characters 8001–8008 of 9000:\n\nThe end.');
    expect(res.text).not.toContain('More:');
    expect(kompl.requested[1].searchParams.get('offset')).toBe('8000');
  });

  it('points to the next window when there is more text', async () => {
    const kompl = fakeKompl({
      '/api/sources/s1/content': { ...SOURCE, mode: 'text', offset: 0, text: 'x'.repeat(8000), next_offset: 8000 },
    });
    const res = await call(await connect(kompl.fetchImpl), 'read_source', { source_id: 's1' });
    expect(res.text).toContain('More: call again with offset=8000.');
  });

  it('says when no passage matches', async () => {
    const kompl = fakeKompl({
      '/api/sources/s1/content': { ...SOURCE, mode: 'passages', query: 'volcano', passages: [] },
    });
    const res = await call(await connect(kompl.fetchImpl), 'read_source', { source_id: 's1', query: 'volcano' });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('No passage of this 9000-character source matches "volcano"');
  });

  it('flags missing or unknown identifiers', async () => {
    const client = await connect(
      fakeKompl({
        '/api/wiki/pow/data': PAGE,
        '/api/sources/nope/content': () => json({ error: 'not_found', message: 'No source nope.' }, 404),
      }).fetchImpl
    );
    expect((await call(client, 'read_source', {})).isError).toBe(true);
    expect((await call(client, 'read_source', { page_id: 'pow' })).isError).toBe(true);
    const noSuchCitation = await call(client, 'read_source', { page_id: 'pow', n: 4 });
    expect(noSuchCitation).toEqual({
      text: '"Proof of work" has no source [4]; its sources are numbered 1–1.',
      isError: true,
    });
    const unknown = await call(client, 'read_source', { source_id: 'nope' });
    expect(unknown).toEqual({ text: 'No source nope. Use list_sources to find source ids.', isError: true });
  });

  it('says so when a page has no sources or the offset is past the end', async () => {
    const kompl = fakeKompl({
      '/api/wiki/empty/data': { ...PAGE, page_id: 'empty', title: 'Empty', sources: [] },
      '/api/sources/s1/content': { ...SOURCE, mode: 'text', offset: 9000, text: '', next_offset: null },
    });
    const client = await connect(kompl.fetchImpl);
    expect(await call(client, 'read_source', { page_id: 'empty', n: 1 })).toEqual({
      text: '"Empty" has no sources.',
      isError: true,
    });
    const past = await call(client, 'read_source', { source_id: 's1', offset: 9000 });
    expect(past.text).toContain('No text past character 9000: the source has 9000 characters.');
  });

  it('asks for an update when the app has no source-text route', async () => {
    const kompl = fakeKompl({ '/api/sources/s1/content': () => new Response('<html>404</html>', { status: 404 }) });
    const res = await call(await connect(kompl.fetchImpl), 'read_source', { source_id: 's1' });
    expect(res).toEqual({ text: "This Kompl app can't serve source text yet. Run `kompl update`.", isError: true });
  });
});

describe('list_sources', () => {
  const ITEM = { ...SOURCE, page_count: 3, compile_status: 'active' };

  it('passes the search and filters and lists sources with page counts', async () => {
    const kompl = fakeKompl({ '/api/sources': { sources: [ITEM], total: 1, returned: 1 } });
    const res = await call(await connect(kompl.fetchImpl), 'list_sources', { query: 'example.com', status: 'active' });
    expect(res).toEqual({
      text: [
        'Sources 1–1 of 1 matching "example.com", newest first:',
        '',
        '• **Bitcoin explained** (url, added 2026-09-30, in 3 page(s))\n  https://example.com/btc\n  ID: `s1`',
      ].join('\n'),
      isError: false,
    });
    expect(Object.fromEntries(kompl.requested[0].searchParams)).toEqual({
      search: 'example.com',
      status: 'active',
      limit: '20',
      offset: '0',
    });
  });

  it('marks archived sources and ones not in any page, and pages with offset', async () => {
    const archived = { ...ITEM, source_id: 's2', status: 'archived', page_count: 0, source_url: null };
    const kompl = fakeKompl({ '/api/sources': { sources: [archived], total: 5, returned: 1 } });
    const res = await call(await connect(kompl.fetchImpl), 'list_sources', { limit: 1, offset: 2 });
    expect(res.text).toContain('Sources 3–3 of 5, newest first:');
    expect(res.text).toContain('(url, added 2026-09-30, archived, in no pages yet)');
    expect(res.text).toContain('More: call again with offset=3.');
  });

  it('says when nothing matches or paging went past the end', async () => {
    const empty = fakeKompl({ '/api/sources': { sources: [], total: 0, returned: 0 } }).fetchImpl;
    expect((await call(await connect(empty), 'list_sources', { query: 'zzz' })).text).toBe('No sources match.');
    const past = fakeKompl({ '/api/sources': { sources: [], total: 4, returned: 0 } }).fetchImpl;
    expect((await call(await connect(past), 'list_sources', { offset: 10 })).text).toBe('No more sources: there are 4.');
  });
});

describe('id checks', () => {
  // `new URL()` folds dot segments, so '..' once reached /api/content and came
  // back as "Run `kompl update`". Ids are refused before any request.
  it.each([
    ['read_source', { source_id: '..' }, 'source_id'],
    ['read_source', { source_id: 's1/../../wiki' }, 'source_id'],
    ['read_source', { page_id: '.', n: 1 }, 'page_id'],
    ['read_page', { page_id: '..' }, 'page_id'],
    ['read_page', { page_id: 'a/b' }, 'page_id'],
    ['read_page', { page_id: 'Proof of work' }, 'page_id'],
  ])('%s refuses %j with a clear error', async (tool, args, field) => {
    const kompl = fakeKompl({});
    const res = await call(await connect(kompl.fetchImpl), tool, args);
    expect(res.isError).toBe(true);
    expect(res.text).toContain(field);
    expect(res.text).toContain('lower-case letters, digits, - and _');
    expect(res.text).not.toContain('kompl update');
    expect(kompl.requested).toEqual([]);
  });

  it('still takes real ids: page slugs and source UUIDs', async () => {
    const id = '0b9f1c2e-4a5d-4e6f-8a7b-9c0d1e2f3a4b';
    const kompl = fakeKompl({
      '/api/wiki/proof_of-work-2/data': { ...PAGE, page_id: 'proof_of-work-2' },
      [`/api/sources/${id}/content`]: { ...SOURCE, source_id: id, mode: 'text', offset: 0, text: 'x', next_offset: null },
    });
    const client = await connect(kompl.fetchImpl);
    expect((await call(client, 'read_page', { page_id: 'proof_of-work-2' })).isError).toBe(false);
    expect((await call(client, 'read_source', { source_id: id })).isError).toBe(false);
  });
});
