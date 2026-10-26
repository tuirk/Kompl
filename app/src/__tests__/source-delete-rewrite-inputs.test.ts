/**
 * What a source delete rewrites a page from, and how often.
 *
 *   - A page can hold several provenance rows for one source (a 'mentioned'
 *     row next to its 'created' or 'updated' one). The delete still
 *     rewrites the page once: a second rewrite costs another LLM call, and
 *     if it failed it would archive a page the first one had already
 *     cleaned (lib/page-hold.ts). Remaining sources count once each.
 *   - A bulk delete rewrites a page shared with other sources in the batch
 *     from the sources that stay only. The later siblings skip the page as
 *     handled, so text drafted from them would stay live with no credit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as bulkDeletePOST } from '../app/api/sources/bulk-delete/route';
import { deleteOneSourceWithCascade } from '../lib/source-delete';
import { setupTestDb, seedPage, seedProvenance, seedSource, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle;
const LONG_MD = 'Ethereum moved to proof of stake. '.repeat(30);

interface Calls {
  /** The source ids each draft-page call was given. */
  drafts: string[][];
}

/** nlp-service stub: draft-page answers from `draftStatus` in turn (200 by default). */
function mockNlp(draftStatus: number[] = []): Calls {
  const calls: Calls = { drafts: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/pipeline/draft-page')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { title: string; source_contents: Array<{ source_id: string }> };
        calls.drafts.push(body.source_contents.map((s) => s.source_id).sort());
        const status = draftStatus[calls.drafts.length - 1] ?? 200;
        if (status !== 200) return new Response('model error', { status });
        return Response.json({ markdown: `---\ntitle: ${body.title}\n---\n\nRewritten from what is left [S1].\n` });
      }
      if (u.endsWith('/storage/write-page')) return Response.json({ current_path: 'x', previous_path: null });
      return Response.json({ ok: true });
    }),
  );
  return calls;
}

function page(pageId: string): { page_type: string; source_count: number } {
  return handle.db.prepare('SELECT page_type, source_count FROM pages WHERE page_id = ?').get(pageId) as never;
}

beforeEach(() => {
  handle = setupTestDb();
});

afterEach(() => {
  vi.useRealTimers();
  handle.cleanup();
  vi.unstubAllGlobals();
});

describe('a page with several provenance rows for the deleted source', () => {
  it('is rewritten once, and a failure the second rewrite would have had never archives it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    seedPage(handle.db, { page_id: 'eth', title: 'Ethereum', page_type: 'entity' });
    for (const sid of ['blog', 'k1', 'k2']) seedSource(handle.db, { source_id: sid, raw_markdown: LONG_MD });
    seedProvenance(handle.db, 'eth', 'blog', 'created');
    seedProvenance(handle.db, 'eth', 'blog', 'mentioned');
    seedProvenance(handle.db, 'eth', 'k1', 'created');
    seedProvenance(handle.db, 'eth', 'k1', 'mentioned');
    seedProvenance(handle.db, 'eth', 'k2', 'updated');
    // The first rewrite works; any further one fails, retry included.
    const calls = mockNlp([200, 500, 500]);

    const pending = deleteOneSourceWithCascade('blog');
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({ status: 'ok', pages_rewritten: 1, pages_hidden: 0 });
    expect(calls.drafts).toEqual([['k1', 'k2']]);
    // Two sources remain, however many rows they have.
    expect(page('eth')).toEqual({ page_type: 'entity', source_count: 2 });
  });
});

describe('a bulk delete of some of a page\'s sources', () => {
  it('rewrites the page from the sources that stay, not from batch siblings', async () => {
    seedPage(handle.db, { page_id: 'eth', title: 'Ethereum', page_type: 'entity' });
    for (const sid of ['a', 'b', 'c', 'd']) {
      seedSource(handle.db, { source_id: sid, raw_markdown: LONG_MD });
      seedProvenance(handle.db, 'eth', sid);
    }
    const calls = mockNlp();

    const res = await bulkDeletePOST(
      new Request('http://localhost/api/sources/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ['a', 'b'] }),
      }),
    );

    expect(res.status).toBe(200);
    expect(calls.drafts).toEqual([['c', 'd']]);
    expect(page('eth')).toEqual({ page_type: 'entity', source_count: 2 });
    const credited = handle.db.prepare('SELECT DISTINCT source_id FROM provenance WHERE page_id = ? ORDER BY source_id').all('eth');
    expect(credited).toEqual([{ source_id: 'c' }, { source_id: 'd' }]);
  });
});
