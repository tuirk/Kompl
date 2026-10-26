/**
 * A restore holds the whole backup in memory while it writes it in one
 * transaction (POST /api/import). A zip bomb, a small file that unpacks to
 * gigabytes or holds a vast number of entries, must be refused with a plain
 * reason instead of crashing the app. The limits are lowered here.
 */

import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/import-limits', () => ({ MAX_IMPORT_UNPACKED_BYTES: 50_000, MAX_IMPORT_ENTRIES: 20 }));

import { POST as importPOST } from '../app/api/import/route';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

const SOURCE = {
  source_id: 'src-1', title: 'S', source_type: 'url', source_url: null, content_hash: 'h',
  file_path: '/data/raw/src-1.md.gz', status: 'active', date_ingested: '2025-01-01 00:00:00', metadata: null,
};

async function importZip(fill: (zip: JSZip) => void): Promise<Response> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ format: 'kompl', version: 1, schema_version: 30 }));
  zip.file('db/pages.json', '[]');
  zip.file('db/sources.json', JSON.stringify([SOURCE]));
  fill(zip);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const form = new FormData();
  form.set('file', new File([new Uint8Array(buf)], 'backup.kompl.zip'));
  return importPOST(new Request('http://test/api/import', { method: 'POST', body: form }));
}

const sourceCount = () => (handle!.db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n;

describe('restoring a backup that unpacks too large', () => {
  it('refuses one entry that unpacks past the limit, and restores nothing', async () => {
    handle = setupTestDb();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    const res = await importZip((zip) => zip.file('raw/src-1.md.gz', Buffer.alloc(200_000)));

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('backup_too_large');
    expect(body.message).toMatch(/Nothing was restored/);
    expect(sourceCount()).toBe(0);
  });

  it('refuses a backup with more entries than a wiki has', async () => {
    handle = setupTestDb();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    const res = await importZip((zip) => {
      for (let i = 0; i < 30; i++) zip.file(`pages/p-${i}.md.gz`, 'x');
    });

    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe('backup_too_large');
    expect(sourceCount()).toBe(0);
  });

  it('restores a backup within the limits', async () => {
    handle = setupTestDb();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })));
    const res = await importZip((zip) => zip.file('raw/src-1.md.gz', Buffer.alloc(1_000)));

    expect(res.status).toBe(200);
    expect(sourceCount()).toBe(1);
  });
});
