/**
 * Every ingest path stores the source's publication date and its origin
 * (plan 3.2, D5; schema v30 step): url and file sources take the date
 * conversion read from their metadata, else the text's, else the day they
 * were added; tweets take their own date; notes and pastes the text's. A
 * backup carries the columns; an older one imports NULL, which reads as the
 * ingest day. Nothing here fetches: the nlp-service is stubbed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { POST as importPOST } from '../app/api/import/route';
import { runIngestTextsStep } from '../lib/compile/steps/ingest-texts';
import { runIngestUrlsStep } from '../lib/compile/steps/ingest-urls';
import { getAllSources, getSource, type StagingRow } from '../lib/db';
import { sourceDateOf } from '../lib/source-dates';
import { seedCompileProgress, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

const today = () => new Date().toISOString().slice(0, 10);

function staging(connector: StagingRow['connector'], payload: Record<string, unknown>, i: number): StagingRow {
  return {
    stage_id: `stage-${i}`,
    session_id: 'sess',
    connector,
    payload,
    included: true,
    status: 'pending',
    resolved_source_id: null,
    error_code: null,
    error_message: null,
    created_at: '2026-10-24 10:00:00',
    ingested_at: null,
  };
}

function dates(): Array<{ title: string; published_at: string | null; published_at_source: string | null }> {
  return handle!.db
    .prepare('SELECT title, published_at, published_at_source FROM sources ORDER BY title')
    .all() as Array<{ title: string; published_at: string | null; published_at_source: string | null }>;
}

describe('schema', () => {
  it('sources has nullable published_at and published_at_source, added in the v30 step', () => {
    handle = setupTestDb();
    const cols = handle.db.prepare('PRAGMA table_info(sources)').all() as Array<{ name: string; notnull: number }>;
    for (const name of ['published_at', 'published_at_source']) {
      expect(cols.find((c) => c.name === name)?.notnull).toBe(0);
    }
    const migrate = readFileSync(join(__dirname, '../../../scripts/migrate.py'), 'utf8');
    expect(migrate).toContain('ALTER TABLE sources ADD COLUMN {col} TEXT');
    expect(migrate.match(/_ensure_source_dates\(conn\)/g)).toHaveLength(2);
  });
});

describe('ingest', () => {
  it('notes, tweets and pastes take their own date, else the text\'s, else today', async () => {
    handle = setupTestDb();
    seedCompileProgress(handle.db, 'sess');
    await runIngestTextsStep(
      'sess',
      [
        staging('text', {
          markdown: 'Bitcoin hit a new high.',
          title_hint: 'Tweet by @a',
          source_type_hint: 'tweet',
          metadata: { date_saved: '2022-08-01T10:00:00.000Z' },
        }, 1),
        staging('text', { markdown: 'Meeting notes\n\nDate: 2025-02-03\n\nWe agreed.', title_hint: 'Notes' }, 2),
        staging('text', { markdown: 'Shopping list without a date.', title_hint: 'List' }, 3),
        staging('paste', { title: 'Pasted', text: 'Posted on March 5, 2024 by admin.\n\nText.', source_url: null }, 4),
      ],
      () => {}
    );
    expect(dates()).toEqual([
      { title: 'List', published_at: today(), published_at_source: 'ingested' },
      { title: 'Notes', published_at: '2025-02-03', published_at_source: 'source_text' },
      { title: 'Pasted', published_at: '2024-03-05', published_at_source: 'source_text' },
      { title: 'Tweet by @a', published_at: '2022-08-01', published_at_source: 'tweet' },
    ]);
  });

  it("url sources take conversion's metadata date, else the text's", async () => {
    handle = setupTestDb();
    seedCompileProgress(handle.db, 'sess');
    const replies: Record<string, Record<string, unknown>> = {
      'https://example.com/a': { title: 'Article', published_at: '2023-11-02', published_at_source: 'page_published' },
      'https://example.com/b': { title: 'Blog', markdown: 'Published January 2, 2024\n\nText.' },
    };
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const { source_id, url } = JSON.parse(String(init?.body)) as { source_id: string; url: string };
      const reply = replies[url];
      return Response.json({
        source_id,
        source_type: 'url',
        title_source: 'markitdown',
        source_url: url,
        markdown: 'Body text.',
        content_hash: `hash-${url}`,
        metadata: {},
        ...reply,
      });
    }));
    await runIngestUrlsStep(
      'sess',
      Object.keys(replies).map((url, i) => staging('url', { url }, i)),
      () => {}
    );
    expect(dates()).toEqual([
      { title: 'Article', published_at: '2023-11-02', published_at_source: 'page_published' },
      { title: 'Blog', published_at: '2024-01-02', published_at_source: 'source_text' },
    ]);
    const [article] = getAllSources({ search: 'Article' });
    expect(getSource(article.source_id)).toMatchObject({ published_at: '2023-11-02', published_at_source: 'page_published' });
  });
});

describe('backups', () => {
  const SOURCE = {
    source_id: 'src-a',
    title: 'Bitcoin whitepaper',
    source_type: 'url',
    source_url: 'https://example.com/btc',
    content_hash: 'sha256-a',
    file_path: '/data/raw/src-a.md.gz',
    status: 'active',
    date_ingested: '2026-05-01 10:00:00',
    metadata: null,
  };

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

  it('export carries the date; import restores it, and an older backup reads as its ingest day', async () => {
    handle = setupTestDb();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const res = await importSources([
      { ...SOURCE, published_at: '2008-10-31', published_at_source: 'file_metadata' },
      { ...SOURCE, source_id: 'src-b', title: 'Older backup', content_hash: 'sha256-b' },
    ]);
    expect(res.status).toBe(200);
    const [a, b] = ['src-a', 'src-b'].map((id) => getSource(id)!);
    expect(sourceDateOf(a)).toEqual({ published_at: '2008-10-31', published_at_source: 'file_metadata' });
    expect(b.published_at).toBeNull();
    expect(sourceDateOf(b)).toEqual({ published_at: '2026-05-01', published_at_source: 'ingested' });
    expect(getAllSources().find((s) => s.source_id === 'src-a')).toMatchObject({ published_at: '2008-10-31' });
  });
});
