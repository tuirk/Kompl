/**
 * A .kompl backup with vectors is one snapshot of the database. Fetching the
 * vectors can take up to a minute; the tables were once read on both sides
 * of that wait, so a page committed meanwhile had its provenance and links
 * in the backup without the page, and the restore dropped them as rows
 * naming a page the backup lacks. The vectors are fetched first now, then
 * every table is read in one read transaction.
 */

import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildKomplBackup } from '../lib/kompl-backup';
import { seedPage, seedProvenance, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

describe('a backup with vectors', () => {
  it('holds a page committed while the vectors were fetched together with its rows', async () => {
    handle = setupTestDb();
    const db = handle.db;
    seedSource(db, { source_id: 'src-a', raw_markdown: 'Text.' });
    seedPage(db, { page_id: 'page-old', title: 'Old' });
    seedProvenance(db, 'page-old', 'src-a');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/vectors/export')) {
          // A compile commits a page while nlp-service answers.
          seedPage(db, { page_id: 'page-new', title: 'New' });
          seedProvenance(db, 'page-new', 'src-a');
          return Response.json({ count: 0, items: [] });
        }
        return new Response('not found', { status: 404 });
      }),
    );

    const zip = await JSZip.loadAsync(await buildKomplBackup({ includeVectors: true }));
    const read = async (name: string) => JSON.parse(await zip.file(name)!.async('string')) as Array<{ page_id: string }>;
    const pageIds = (await read('db/pages.json')).map((p) => p.page_id).sort();
    const provenancePages = [...new Set((await read('db/provenance.json')).map((p) => p.page_id))].sort();

    expect(pageIds).toEqual(['page-new', 'page-old']);
    expect(provenancePages).toEqual(pageIds);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as { page_count: number };
    expect(manifest.page_count).toBe(2);
  });
});
