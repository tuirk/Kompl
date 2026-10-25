/**
 * Exports carry every source. getAllSources once defaulted to 200 rows, so
 * a .kompl backup (and the JSON export) of a larger wiki silently left the
 * oldest sources, their raw text included, out of the file.
 */

import JSZip from 'jszip';
import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET as exportGET } from '../app/api/export/route';
import { getAllSources, rawFilePath } from '../lib/db';
import { seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

const COUNT = 205;

function seedMany(): string[] {
  handle = setupTestDb();
  const db = handle.db;
  const ids: string[] = [];
  db.transaction(() => {
    for (let i = 0; i < COUNT; i++) {
      const id = `src-${String(i).padStart(3, '0')}`;
      seedSource(db, { source_id: id, title: `Source ${i}`, raw_markdown: `Text ${i}.` });
      db.prepare('UPDATE sources SET date_ingested = ? WHERE source_id = ?').run(
        `2025-01-01 00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
        id,
      );
      ids.push(id);
    }
  })();
  return ids;
}

// Zipping 205 sources takes about a second alone but well past the default
// 5 s when the whole suite runs in parallel.
describe('exports carry every source', { timeout: 30_000 }, () => {
  it('getAllSources returns them all unless a limit is asked for', () => {
    seedMany();
    expect(getAllSources()).toHaveLength(COUNT);
    expect(getAllSources({ limit: 10 })).toHaveLength(10);
  });

  it('the .kompl backup holds every source row and its raw text', async () => {
    const ids = seedMany();
    const res = await exportGET(new Request('http://test/api/export?format=kompl'));
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as { source_count: number };
    const rows = JSON.parse(await zip.file('db/sources.json')!.async('string')) as Array<{ source_id: string }>;
    expect(manifest.source_count).toBe(COUNT);
    expect(rows.map((r) => r.source_id).sort()).toEqual(ids);
    // The oldest source, the first one a 200-row cut dropped, keeps its text.
    expect(zip.file('raw/src-000.md.gz')).not.toBeNull();
  });

  it('the JSON export lists every source', async () => {
    seedMany();
    const res = await exportGET(new Request('http://test/api/export?format=json'));
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text()) as { source_count: number; sources: unknown[] };
    expect(body.source_count).toBe(COUNT);
    expect(body.sources).toHaveLength(COUNT);
  });

  it('the backup manifest names a source file missing on disk', async () => {
    seedMany();
    rmSync(rawFilePath('src-007'), { force: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await exportGET(new Request('http://test/api/export?format=kompl'));
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as { missing_files: string[] };
    expect(manifest.missing_files).toEqual(['raw/src-007.md.gz']);
    expect(zip.file('raw/src-007.md.gz')).toBeNull();
    vi.restoreAllMocks();
  });
});
