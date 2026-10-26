/**
 * Deleting a source removes its raw text file, and only that file.
 *
 * sources.file_path is a stored value; a restored backup can carry any
 * string there (POST /api/import). Deleting such a source must never unlink
 * what the column names, e.g. the live database. The raw file is found from
 * the source id, inside the raw-files folder, as readRawMarkdown finds it.
 */

import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/recompile', () => ({
  recompilePage: vi.fn(async () => ({ outcome: 'rewritten' as const })),
}));

import { POST as importPOST } from '../app/api/import/route';
import { DATA_ROOT, rawFilePath } from '../lib/db';
import { deleteOneSourceWithCascade } from '../lib/source-delete';
import { setupTestDb, seedSource, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle;
const VICTIM = path.join(DATA_ROOT, 'db', 'victim-kompl.db');

beforeEach(() => {
  handle = setupTestDb();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
  fs.mkdirSync(path.dirname(VICTIM), { recursive: true });
  fs.writeFileSync(VICTIM, 'live database');
});

afterEach(() => {
  handle.cleanup();
  vi.unstubAllGlobals();
  fs.rmSync(VICTIM, { force: true });
});

/** The unlink is fire-and-forget; give it a moment to land. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('deleting a source', () => {
  it('unlinks the raw file found from its id, never the stored file_path', async () => {
    seedSource(handle.db, { source_id: 'src-crafted', file_path: VICTIM, raw_markdown: 'some text' });
    expect(fs.existsSync(rawFilePath('src-crafted'))).toBe(true);

    const result = await deleteOneSourceWithCascade('src-crafted');
    await settle();

    expect(result.status).toBe('ok');
    expect(fs.readFileSync(VICTIM, 'utf-8')).toBe('live database');
    expect(fs.existsSync(rawFilePath('src-crafted'))).toBe(false);
  });
});

describe('restoring a backup', () => {
  async function importSources(sources: Record<string, unknown>[]): Promise<Response> {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ format: 'kompl', version: 1, schema_version: 30 }));
    zip.file('db/pages.json', '[]');
    zip.file('db/sources.json', JSON.stringify(sources));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const form = new FormData();
    form.set('file', new File([new Uint8Array(buf)], 'backup.kompl.zip'));
    return importPOST(new Request('http://test/api/import', { method: 'POST', body: form }));
  }

  const source = (source_id: string, file_path: unknown) => ({
    source_id, title: 'S', source_type: 'url', source_url: null, content_hash: 'h',
    file_path, status: 'active', date_ingested: '2025-01-01 00:00:00', metadata: null,
  });

  it("keeps a file_path that names the source's raw file and replaces anything else", async () => {
    const res = await importSources([
      source('src-normal', '/data/raw/src-normal.md.gz'),
      source('src-crafted', '/data/db/kompl.db'),
      source('src-climb', '/data/raw/../db/src-climb.md.gz'),
      source('src-other', '/data/raw/src-normal.md.gz'),
      source('src-missing', null),
    ]);
    expect(res.status).toBe(200);

    const stored = Object.fromEntries(
      (handle.db.prepare('SELECT source_id, file_path FROM sources').all() as Array<{ source_id: string; file_path: string }>)
        .map((r) => [r.source_id, r.file_path]),
    );
    expect(stored).toEqual({
      'src-normal': '/data/raw/src-normal.md.gz',
      'src-crafted': rawFilePath('src-crafted'),
      'src-climb': rawFilePath('src-climb'),
      'src-other': rawFilePath('src-other'),
      'src-missing': rawFilePath('src-missing'),
    });
  });
});
