/**
 * A backup made before every source and page went in still restores: all
 * the pages and files it holds come back, and the rows it holds for the
 * sources and pages it lacks are left out and reported. The test takes a
 * backup of a full wiki and cuts it down as older releases wrote it (the
 * 200 newest sources only, no page whose sources were all archived).
 */

import Database from 'better-sqlite3';
import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { GET as exportGET } from '../app/api/export/route';
import { POST as importPOST } from '../app/api/import/route';
import { __setDbForTesting, DATA_ROOT } from '../lib/db';
import { EVERYDAY_SCALE, listSeededFiles, removeSeededFiles, seedWiki } from './helpers/backup-fixture';

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, 'helpers', 'schema.sql'), 'utf8');
const opened: Database.Database[] = [];

function openDb(): Database.Database {
  const db = new Database(':memory:');
  opened.push(db);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  __setDbForTesting(db);
  return db;
}

afterAll(() => {
  vi.unstubAllGlobals();
  __setDbForTesting(null);
  for (const db of opened) if (db.open) db.close();
  removeSeededFiles();
  fs.rmSync(path.join(DATA_ROOT, 'llm-config.json'), { force: true });
});

type Row = Record<string, unknown>;

describe('a backup from before every source and page went in', () => {
  it('restores every page it holds and reports the rows it had to leave out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    removeSeededFiles();
    const source = openDb();
    seedWiki(source, EVERYDAY_SCALE);
    const hidden = new Set(
      (source
        .prepare(
          `SELECT page_id FROM pages WHERE page_type = 'archived' OR page_id IN (
             SELECT pr.page_id FROM provenance pr JOIN sources s ON s.source_id = pr.source_id
              GROUP BY pr.page_id HAVING COUNT(*) = SUM(s.status = 'archived'))`,
        )
        .all() as Array<{ page_id: string }>).map((r) => r.page_id),
    );
    const zip = await JSZip.loadAsync(
      Buffer.from(await (await exportGET(new Request('http://test/api/export?format=kompl'))).arrayBuffer()),
    );

    // As older releases wrote it: the 200 newest sources and the visible pages.
    const read = async (name: string) => JSON.parse(await zip.file(name)!.async('string')) as Row[];
    const sources = (await read('db/sources.json'))
      .sort((a, b) => String(b.date_ingested).localeCompare(String(a.date_ingested)))
      .slice(0, 200);
    const kept = new Set(sources.map((s) => s.source_id as string));
    const pages = (await read('db/pages.json')).filter((p) => !hidden.has(p.page_id as string));
    zip.file('db/sources.json', JSON.stringify(sources));
    zip.file('db/pages.json', JSON.stringify(pages));
    for (const name of Object.keys(zip.files)) {
      const id = path.basename(name).split('.')[0];
      if (name.startsWith('raw/') && !kept.has(id)) zip.remove(name);
      if (name.startsWith('pages/') && hidden.has(id)) zip.remove(name);
    }
    const provenance = await read('db/provenance.json');
    const restorable = provenance.filter((r) => kept.has(r.source_id as string) && !hidden.has(r.page_id as string));

    source.close();
    removeSeededFiles();
    const target = openDb();
    const form = new FormData();
    form.set('file', new File([new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))], 'old.kompl.zip'));
    const res = await importPOST(new Request('http://test/api/import', { method: 'POST', body: form }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped: { total: number; tables: Record<string, number>; missing_count: number } };

    const count = (table: string) => (target.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count('sources')).toBe(200);
    expect(count('pages')).toBe(pages.length);
    expect(count('provenance')).toBe(restorable.length);
    // Every page the backup holds comes back with its file.
    const files = new Set(listSeededFiles());
    expect(pages.filter((p) => !files.has(`pages/${p.page_id as string}.md.gz`))).toEqual([]);
    // What was left out is reported, table by table.
    expect(body.skipped.tables.provenance).toBe(provenance.length - restorable.length);
    expect(body.skipped.total).toBeGreaterThan(body.skipped.tables.provenance);
    expect(body.skipped.missing_count).toBe(EVERYDAY_SCALE.sources - 200 + hidden.size);
  }, 60_000);
});
