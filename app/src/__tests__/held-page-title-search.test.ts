/**
 * A page archived until a failed rewrite succeeds (lib/page-hold.ts) may
 * still hold a deleted source's material. It stays out of search, also
 * after a restore, and it keeps its title: the next compile that names it
 * makes no second page with the same title.
 */

import JSZip from 'jszip';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST as planPOST } from '../app/api/compile/plan/route';
import { GET as searchGET } from '../app/api/pages/search/route';
import { POST as importPOST } from '../app/api/import/route';
import { getTopicPageByTitle } from '../lib/db';
import { holdPage } from '../lib/page-hold';
import { seedExtraction, seedPage, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

const AT = '2026-10-01 00:00:00';

function pageRow(page_id: string, title: string, page_type: string, extra: Record<string, unknown> = {}) {
  return {
    page_id, title, page_type, category: null, summary: null, content_path: `/data/pages/${page_id}.md.gz`,
    previous_content_path: null, last_updated: AT, source_count: 2, created_at: AT, ...extra,
  };
}

async function importBackup(): Promise<Response> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ format: 'kompl', version: 1, schema_version: 30 }));
  zip.file('db/sources.json', '[]');
  zip.file(
    'db/pages.json',
    JSON.stringify([
      pageRow('page-live', 'Bitcoin', 'entity'),
      pageRow('page-held', 'Ethereum', 'archived', { restore_page_type: 'entity', archive_reason: 'Could not rewrite it.' }),
      pageRow('page-gone', 'Dogecoin', 'archived'),
    ]),
  );
  for (const [id, text] of [['page-live', 'Bitcoin uses proof of work.'], ['page-held', 'Ethereum leaked plan.'], ['page-gone', 'Dogecoin leaked plan.']]) {
    zip.file(`pages/${id}.md.gz`, zlib.gzipSync(Buffer.from(`---\ntitle: x\n---\n\n${text}\n`)));
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const form = new FormData();
  form.set('file', new File([new Uint8Array(buf)], 'backup.kompl.zip'));
  return importPOST(new Request('http://test/api/import', { method: 'POST', body: form }));
}

async function keywordSearch(q: string): Promise<string[]> {
  const res = await searchGET(new Request(`http://test/api/pages/search?q=${encodeURIComponent(q)}`));
  return ((await res.json()) as { items: Array<{ page_id: string }> }).items.map((p) => p.page_id);
}

describe('after a restore', () => {
  it('held and archived pages are not in search; live pages are', async () => {
    handle = setupTestDb();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));

    expect((await importBackup()).status).toBe(200);

    expect(await keywordSearch('leaked')).toEqual([]);
    expect(await keywordSearch('proof')).toEqual(['page-live']);
    const indexed = handle.db.prepare('SELECT page_id FROM pages_fts ORDER BY page_id').all();
    expect(indexed).toEqual([{ page_id: 'page-live' }]);
  });
});

describe('the next compile', () => {
  it('makes no second page with a held page\'s title', async () => {
    handle = setupTestDb();
    const { db } = handle;
    seedPage(db, { page_id: 'gpt-4-page', title: 'GPT-4', page_type: 'entity' });
    expect(holdPage('gpt-4-page', 'Kompl could not rewrite this page.')).toBe(true);
    for (const [sid, session] of [['s-old', 'sess-a'], ['s-new', 'sess-b']]) {
      seedSource(db, { source_id: sid, onboarding_session_id: session, compile_status: 'extracted', raw_markdown: 'x'.repeat(600) });
      seedExtraction(db, { source_id: sid, llm_output: { entities: [{ name: 'GPT-4', type: 'PRODUCT' }], concepts: [], relationships: [] } });
    }

    expect(getTopicPageByTitle('GPT-4')?.page_id).toBe('gpt-4-page');
    const res = await planPOST(
      new Request('http://test/api/compile/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: 'sess-b',
          canonical_entities: [{ canonical: 'GPT-4', type: 'PRODUCT', aliases: [], source_ids: ['s-new'], method: 'exact' }],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const { pages } = (await res.json()) as { pages: Array<{ title: string }> };
    expect(pages.map((p) => p.title)).not.toContain('GPT-4');
  });

  it('still finds a live page with the title first', () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'old-held', title: 'GPT-4', page_type: 'entity' });
    holdPage('old-held', 'held');
    seedPage(handle.db, { page_id: 'live', title: 'GPT-4', page_type: 'concept' });
    expect(getTopicPageByTitle('GPT-4')?.page_id).toBe('live');
  });
});
