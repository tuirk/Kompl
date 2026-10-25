/**
 * Sources added before publication dates were kept (plan 3.2) are dated
 * once from what they already hold (lib/source-date-backfill.ts): a tweet's
 * own date, else a date their stored text gives near its top. No LLM, no
 * fetch. Runs once per install at boot (versioned settings key, never
 * backed up) and after an import; never overwrites a date already set, and
 * leaves a source it can't date NULL, read as the day it was added.
 */

import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { POST as importPOST } from '../app/api/import/route';
import { isBackedUpSetting } from '../lib/backup-settings';
import { getSetting, getSource } from '../lib/db';
import {
  backfillSourceDates,
  backfillSourceDatesOnce,
  SOURCE_DATES_BACKFILL_KEY,
  SOURCE_DATES_BACKFILL_VERSION,
} from '../lib/source-date-backfill';
import { sourceDateOf } from '../lib/source-dates';
import { seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

function seed(): void {
  handle = setupTestDb();
  const db = handle.db;
  const add = (id: string, text: string, extra: Record<string, unknown> = {}) => {
    seedSource(db, { source_id: id, title: id, raw_markdown: text, ...extra });
    db.prepare("UPDATE sources SET date_ingested = '2026-06-01 10:00:00' WHERE source_id = ?").run(id);
  };
  add('article', '# Night trams\n\n*By Ana · Published March 5, 2024*\n\nText.');
  add('video', '# Talk\n\n**Channel:** C\n**Published:** 2023-11-02T15:00:00Z\n\n## Transcript\n\nhello');
  add('tweet', 'Bitcoin hit a new high.', { source_type: 'tweet' });
  db.prepare('UPDATE sources SET metadata = ? WHERE source_id = ?').run(
    JSON.stringify({ date_saved: '2022-08-01T10:00:00.000Z' }),
    'tweet',
  );
  add('undated', 'A note with no date in it.');
  // A date after the source was added cannot be its publication date.
  add('later', 'Published December 1, 2026');
  add('kept', 'Published January 1, 2020');
  db.prepare("UPDATE sources SET published_at = '2019-05-05', published_at_source = 'page_published' WHERE source_id = 'kept'").run();
}

function stored(): Record<string, [string | null, string | null]> {
  const rows = handle!.db
    .prepare('SELECT source_id, published_at, published_at_source FROM sources ORDER BY source_id')
    .all() as Array<{ source_id: string; published_at: string | null; published_at_source: string | null }>;
  return Object.fromEntries(rows.map((r) => [r.source_id, [r.published_at, r.published_at_source]]));
}

describe('backfillSourceDates', () => {
  it('dates what it can from the stored text and metadata, and leaves the rest alone', () => {
    seed();
    expect(backfillSourceDates(handle!.db)).toEqual({ undated: 5, dated: 3, no_text: 0 });
    expect(stored()).toEqual({
      article: ['2024-03-05', 'source_text'],
      kept: ['2019-05-05', 'page_published'],
      later: [null, null],
      tweet: ['2022-08-01', 'tweet'],
      undated: [null, null],
      video: ['2023-11-02', 'source_text'],
    });
    expect(sourceDateOf(getSource('undated')!)).toEqual({ published_at: '2026-06-01', published_at_source: 'ingested' });
  });

  it('changes nothing on a second run, and counts sources whose text is missing', () => {
    seed();
    backfillSourceDates(handle!.db);
    const after = stored();
    expect(backfillSourceDates(handle!.db, () => null)).toEqual({ undated: 2, dated: 0, no_text: 2 });
    expect(stored()).toEqual(after);
  });

  it('runs once per version at boot, and the version is never backed up', () => {
    seed();
    expect(backfillSourceDatesOnce(handle!.db)?.dated).toBe(3);
    expect(getSetting(SOURCE_DATES_BACKFILL_KEY)).toBe(SOURCE_DATES_BACKFILL_VERSION);
    expect(backfillSourceDatesOnce(handle!.db)).toBeNull();
    expect(isBackedUpSetting(SOURCE_DATES_BACKFILL_KEY)).toBe(false);
    const boot = readFileSync(join(__dirname, '../instrumentation.ts'), 'utf8');
    expect(boot).toContain('backfillSourceDatesOnce(getDb())');
  });
});

describe('POST /api/import', () => {
  it("dates an older backup's sources from their restored text, keeping dates the backup carries", async () => {
    handle = setupTestDb();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const source = (id: string, extra: Record<string, unknown> = {}) => ({
      source_id: id,
      title: id,
      source_type: 'url',
      source_url: null,
      content_hash: `h-${id}`,
      file_path: `/data/raw/${id}.md.gz`,
      status: 'active',
      date_ingested: '2026-05-01 10:00:00',
      metadata: null,
      ...extra,
    });
    const { gzipSync } = await import('node:zlib');
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ format: 'kompl', version: 1, schema_version: 29 }));
    zip.file('db/pages.json', '[]');
    zip.file(
      'db/sources.json',
      JSON.stringify([source('old'), source('dated', { published_at: '2001-01-01', published_at_source: 'file_metadata' })]),
    );
    zip.file('raw/old.md.gz', gzipSync('Posted on March 5, 2024 by admin.'));
    zip.file('raw/dated.md.gz', gzipSync('Published March 5, 2024.'));
    const form = new FormData();
    form.set('file', new File([new Uint8Array(await zip.generateAsync({ type: 'nodebuffer' }))], 'backup.kompl.zip'));
    const res = await importPOST(new Request('http://test/api/import', { method: 'POST', body: form }));
    expect(res.status).toBe(200);
    expect(stored()).toEqual({ dated: ['2001-01-01', 'file_metadata'], old: ['2024-03-05', 'source_text'] });
  });
});
