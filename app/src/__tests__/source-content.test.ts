/**
 * GET /api/sources/[source_id]/content — a source's stored text for MCP
 * read_source: ranked passages for a query, or the text in windows with a
 * next offset; clear errors for bad ids, unknown sources and missing text.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '../app/api/sources/[source_id]/content/route';
import { GET as listSources } from '../app/api/sources/route';
import { seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

async function content(sourceId: string, query = '') {
  const res = await GET(new Request(`http://test/api/sources/${sourceId}/content${query}`), {
    params: Promise.resolve({ source_id: sourceId }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const ARTICLE = [
  '# Bitcoin',
  'Bitcoin was described in a 2008 paper by Satoshi Nakamoto.',
  '## Mining',
  'Mining consumes significant energy to secure the network.',
].join('\n\n');

describe('source content', () => {
  it('returns the passages that match a query, with source details', async () => {
    handle = setupTestDb();
    const id = seedSource(handle.db, {
      title: 'Bitcoin explained',
      source_type: 'url',
      source_url: 'https://example.com/btc',
      raw_markdown: ARTICLE,
    });
    const { status, body } = await content(id, '?q=mining%20energy&k=1');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      source_id: id,
      title: 'Bitcoin explained',
      source_url: 'https://example.com/btc',
      total_chars: ARTICLE.length,
      mode: 'passages',
      query: 'mining energy',
    });
    expect(body.passages).toEqual([
      {
        text: 'Mining consumes significant energy to secure the network.',
        heading: 'Mining',
        start: ARTICLE.indexOf('Mining consumes'),
      },
    ]);
  });

  it('pages through the text without a query', async () => {
    handle = setupTestDb();
    const long = 'x'.repeat(8_000) + 'END';
    const id = seedSource(handle.db, { raw_markdown: long });

    const first = await content(id);
    expect(first.body).toMatchObject({ mode: 'text', offset: 0, next_offset: 8_000, total_chars: 8_003 });
    expect((first.body.text as string).length).toBe(8_000);

    const second = await content(id, '?offset=8000');
    expect(second.body).toMatchObject({ offset: 8_000, text: 'END', next_offset: null });
  });

  it('answers clearly for bad ids, unknown sources and missing text', async () => {
    handle = setupTestDb();
    expect((await content('../etc')).body.error).toBe('invalid_source_id');
    expect((await content('src-missing')).status).toBe(404);
    expect((await content('src-missing')).body.error).toBe('not_found');
    const noText = seedSource(handle.db, {});
    const res = await content(noText);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('no_text');
  });
});

describe('source list search', () => {
  it('matches the address as well as the title (MCP list_sources: "did this link make it in?")', async () => {
    handle = setupTestDb();
    const byUrl = seedSource(handle.db, { title: 'Example Domain', source_url: 'https://example.com/' });
    const byTitle = seedSource(handle.db, { title: 'Notes on example.com', source_url: null });
    seedSource(handle.db, { title: 'Unrelated', source_url: 'https://other.org/' });

    const res = await listSources(new Request('http://test/api/sources?search=example.com'));
    const body = (await res.json()) as { sources: Array<{ source_id: string }>; total: number };
    expect(body.sources.map((s) => s.source_id).sort()).toEqual([byUrl, byTitle].sort());
    expect(body.total).toBe(2);
  });

  it('matches % and _ literally instead of as wildcards', async () => {
    handle = setupTestDb();
    const pct = seedSource(handle.db, { title: '100% renewable grid' });
    seedSource(handle.db, { title: 'Plain title', source_url: 'https://example.com/a_b' });
    const res = await listSources(new Request('http://test/api/sources?search=%25'));
    const body = (await res.json()) as { sources: Array<{ source_id: string }> };
    expect(body.sources.map((s) => s.source_id)).toEqual([pct]);
  });
});
