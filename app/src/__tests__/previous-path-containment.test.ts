/**
 * Path containment for previous_content_path (arbitrary-file-read fix).
 *
 * Regression target: GET /api/wiki/[page_id]/previous read whatever absolute
 * path sat in pages.previous_content_path. The column round-trips through
 * .kompl import zips, so a crafted zip could point it at /data/db/kompl.db
 * (or any readable host file) and the route would gunzip + return it.
 *
 * Covers:
 *   - safePreviousContentPath unit cases (valid archive, wrong dir,
 *     traversal, wrong page_id prefix, non-archive filenames)
 *   - previous route 404s on a malicious path, serves a legit archive
 *   - import route nulls out non-conforming previous_content_path values
 *     and rejects zips with unsafe page/source ids
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { GET as previousGET } from '../app/api/wiki/[page_id]/previous/route';
import { POST as importPOST } from '../app/api/import/route';
import { DATA_ROOT, safePreviousContentPath } from '../lib/db';
import { setupTestDb, seedPage, type TestDbHandle } from './helpers/test-db';

const PAGES_DIR = path.join(DATA_ROOT, 'pages');

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe('safePreviousContentPath', () => {
  const valid = path.join(PAGES_DIR, 'my-page.20260101-120000-000123.md.gz');
  const validNoUsec = path.join(PAGES_DIR, 'my-page.20260101-120000.md.gz');

  it('accepts the archive shapes file_store.py writes', () => {
    expect(safePreviousContentPath('my-page', valid)).toBe(path.resolve(valid));
    expect(safePreviousContentPath('my-page', validNoUsec)).toBe(path.resolve(validNoUsec));
  });

  it.each([
    ['outside pages dir', path.join(DATA_ROOT, 'db', 'kompl.db')],
    ['system file', '/etc/passwd'],
    ['traversal escaping pages', path.join(PAGES_DIR, '..', 'db', 'kompl.db')],
    ['current (non-archive) page file', path.join(PAGES_DIR, 'my-page.md.gz')],
    ['archive of a DIFFERENT page', path.join(PAGES_DIR, 'other-page.20260101-120000.md.gz')],
    ['non-gz extension', path.join(PAGES_DIR, 'my-page.20260101-120000.md')],
  ])('rejects %s', (_label, p) => {
    expect(safePreviousContentPath('my-page', p)).toBeNull();
  });

  it('rejects null and unsafe page ids', () => {
    expect(safePreviousContentPath('my-page', null)).toBeNull();
    expect(safePreviousContentPath('../evil', valid)).toBeNull();
  });
});

describe('GET /api/wiki/[page_id]/previous', () => {
  function getPrevious(page_id: string) {
    return previousGET(new Request('http://test'), {
      params: Promise.resolve({ page_id }),
    });
  }

  it('404s (invalid_path) when previous_content_path points outside pages dir', async () => {
    handle = setupTestDb();
    const page_id = seedPage(handle.db, { title: 'Victim' });
    handle.db
      .prepare('UPDATE pages SET previous_content_path = ? WHERE page_id = ?')
      .run(path.join(DATA_ROOT, 'db', 'kompl.db'), page_id);

    const res = await getPrevious(page_id);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_path');
  });

  it('serves a legitimate archive of the same page', async () => {
    handle = setupTestDb();
    const page_id = seedPage(handle.db, { title: 'Versioned' });
    const archivePath = path.join(PAGES_DIR, `${page_id}.20260101-120000-000001.md.gz`);
    fs.mkdirSync(PAGES_DIR, { recursive: true });
    fs.writeFileSync(archivePath, zlib.gzipSync('# old version'));
    handle.db
      .prepare('UPDATE pages SET previous_content_path = ? WHERE page_id = ?')
      .run(archivePath, page_id);

    const res = await getPrevious(page_id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content: string }).content).toBe('# old version');
    fs.unlinkSync(archivePath);
  });
});

describe('POST /api/import — id and path validation', () => {
  async function buildZip(pages: Record<string, unknown>[], sources: Record<string, unknown>[] = []) {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ format: 'kompl', version: 1 }));
    zip.file('db/pages.json', JSON.stringify(pages));
    zip.file('db/sources.json', JSON.stringify(sources));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const form = new FormData();
    form.set('file', new File([new Uint8Array(buf)], 'export.kompl.zip'));
    return new Request('http://test/api/import', { method: 'POST', body: form });
  }

  const basePage = {
    title: 'Page',
    page_type: 'entity',
    content_path: '/data/pages/x.md.gz',
    last_updated: '2026-01-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    source_count: 0,
  };

  it('rejects a zip whose page_id contains traversal segments', async () => {
    handle = setupTestDb();
    const res = await importPOST(await buildZip([{ ...basePage, page_id: '../../evil' }]));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_ids');
  });

  it('nulls out a previous_content_path pointing at the DB file', async () => {
    handle = setupTestDb();
    const res = await importPOST(
      await buildZip([
        {
          ...basePage,
          page_id: 'imported-page',
          previous_content_path: '/data/db/kompl.db',
        },
      ])
    );
    expect(res.status).toBe(200);

    const row = handle.db
      .prepare('SELECT previous_content_path FROM pages WHERE page_id = ?')
      .get('imported-page') as { previous_content_path: string | null };
    expect(row.previous_content_path).toBeNull();
  });
});
