/**
 * Old .kompl.zip backups must keep importing cleanly after schema and
 * default-model changes.
 *
 * Covers:
 *   - a backup's own schema_version row never overwrites the live one
 *     (it would make /api/health report the DB as broken until restart)
 *   - pre-v26 backups that kept the default model are pinned to
 *     gemini-2.5-flash, the model they were built with (mirrors migrate.py v26)
 *   - an explicit compile_model in any backup is restored as-is
 *   - chat history from before chat was retired still imports
 *   - columns added after a backup was made import as NULL, and so do
 *     values of the wrong shape
 */

import { describe, it, expect, afterEach } from 'vitest';
import JSZip from 'jszip';
import { POST as importPOST } from '../app/api/import/route';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

async function buildBackup(opts: {
  manifest: Record<string, unknown>;
  settings?: Array<{ key: string; value: string }>;
  chatMessages?: Record<string, unknown>[];
  /** Further db/<table>.json files. */
  tables?: Record<string, Record<string, unknown>[]>;
}): Promise<Request> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(opts.manifest));
  zip.file('db/pages.json', '[]');
  zip.file('db/sources.json', '[]');
  if (opts.settings) zip.file('db/settings.json', JSON.stringify(opts.settings));
  if (opts.chatMessages) zip.file('db/chat_messages.json', JSON.stringify(opts.chatMessages));
  for (const [table, rows] of Object.entries(opts.tables ?? {})) zip.file(`db/${table}.json`, JSON.stringify(rows));
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const form = new FormData();
  form.set('file', new File([new Uint8Array(buf)], 'backup.kompl.zip'));
  return new Request('http://test/api/import', { method: 'POST', body: form });
}

function setting(key: string): string | undefined {
  const row = handle!.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

describe('POST /api/import — backups from older versions', () => {
  it('keeps the live schema_version when a backup carries an older one', async () => {
    handle = setupTestDb();
    const res = await importPOST(
      await buildBackup({
        manifest: { format: 'kompl', version: 1, schema_version: 25 },
        settings: [
          { key: 'schema_version', value: '25' },
          { key: 'auto_approve', value: '0' },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(setting('schema_version')).toBe('30');
    expect(setting('auto_approve')).toBe('0');
  });

  it('pins gemini-2.5-flash for a pre-v26 backup that kept the default model', async () => {
    handle = setupTestDb();
    const res = await importPOST(
      await buildBackup({
        manifest: { format: 'kompl', version: 1, schema_version: 25 },
        settings: [{ key: 'auto_approve', value: '1' }],
      }),
    );
    expect(res.status).toBe(200);
    expect(setting('compile_model')).toBe('gemini-2.5-flash');
  });

  it('treats a manifest without schema_version as pre-v26', async () => {
    handle = setupTestDb();
    const res = await importPOST(
      await buildBackup({ manifest: { format: 'kompl', version: 1 }, settings: [] }),
    );
    expect(res.status).toBe(200);
    expect(setting('compile_model')).toBe('gemini-2.5-flash');
  });

  it('restores an explicit model choice from an old backup unchanged', async () => {
    handle = setupTestDb();
    const res = await importPOST(
      await buildBackup({
        manifest: { format: 'kompl', version: 1, schema_version: 25 },
        settings: [{ key: 'compile_model', value: 'deepseek-v4-pro' }],
      }),
    );
    expect(res.status).toBe(200);
    expect(setting('compile_model')).toBe('deepseek-v4-pro');
  });

  it('restores the model stored in a v26 backup', async () => {
    handle = setupTestDb();
    const res = await importPOST(
      await buildBackup({
        manifest: { format: 'kompl', version: 1, schema_version: 26 },
        settings: [{ key: 'compile_model', value: 'gemini-3.8-flash' }],
      }),
    );
    expect(res.status).toBe(200);
    expect(setting('compile_model')).toBe('gemini-3.8-flash');
  });

  it('imports chat history from a backup taken before chat was retired', async () => {
    handle = setupTestDb();
    const res = await importPOST(
      await buildBackup({
        manifest: { format: 'kompl', version: 1, schema_version: 25 },
        chatMessages: [
          { session_id: 's1', role: 'user', content: 'What is X?', citations: null, pages_used: null, chat_model: 'gemini-2.5-flash-lite', created_at: '2026-05-01 10:00:00' },
          { session_id: 's1', role: 'assistant', content: 'X is Y.', citations: '[]', pages_used: '[]', chat_model: null, created_at: '2026-05-01 10:00:05' },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const n = (handle.db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get() as { n: number }).n;
    expect(n).toBe(2);
  });

  it('an old backup missing sources and pages restores the rest and says what it left out', async () => {
    handle = setupTestDb();
    const source = {
      source_id: 'src-1', title: 'S', source_type: 'url', source_url: null, content_hash: 'h',
      file_path: '/data/raw/src-1.md.gz', status: 'active', date_ingested: '2025-01-01 00:00:00', metadata: null,
    };
    const page = {
      page_id: 'page-1', title: 'Page one', page_type: 'entity', category: null, summary: 'One.',
      content_path: '/data/pages/page-1.md.gz', previous_content_path: null, last_updated: '2025-01-01 00:00:00',
      source_count: 1, created_at: '2025-01-01 00:00:00',
    };
    const at = '2025-01-01 00:00:00';
    // As backups made before every source and page went in: rows for the
    // 200 newest sources' older siblings and for pages hidden by archiving.
    const res = await importPOST(
      await buildBackup({
        manifest: { format: 'kompl', version: 1, schema_version: 30 },
        tables: {
          sources: [source],
          pages: [page],
          provenance: [
            { source_id: 'src-1', page_id: 'page-1', content_hash: 'h', date_compiled: at, contribution_type: 'created' },
            { source_id: 'src-old', page_id: 'page-1', content_hash: 'h', date_compiled: at, contribution_type: 'updated' },
            { source_id: 'src-1', page_id: 'hidden-page', content_hash: 'h', date_compiled: at, contribution_type: 'created' },
          ],
          extractions: [
            { source_id: 'src-1', ner_output: '{}', profile: 'default', llm_output: '{}', created_at: at },
            { source_id: 'src-old', ner_output: '{}', profile: 'default', llm_output: '{}', created_at: at },
          ],
          entity_mentions: [
            { canonical_name: 'Kept', source_id: 'src-1', entity_type: null, first_seen_at: at },
            { canonical_name: 'Lost', source_id: 'src-old', entity_type: null, first_seen_at: at },
          ],
          relationship_mentions: [
            { from_canonical: 'A', to_canonical: 'B', relationship_type: 'uses', source_id: 'src-old', first_seen_at: at },
          ],
          page_links: [{ source_page_id: 'page-1', target_page_id: 'hidden-page', link_type: 'entity-ref', created_at: at }],
          aliases: [
            { alias: 'P1', canonical_name: 'Page one', canonical_page_id: 'page-1', method: 'exact', status: 'active' },
            { alias: 'HP', canonical_name: 'Hidden', canonical_page_id: 'hidden-page', method: 'exact', status: 'active' },
          ],
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      skipped: { total: number; tables: Record<string, number>; missing_count: number; missing: string[] };
    };
    expect(body.skipped).toEqual({
      total: 7,
      tables: { provenance: 2, extractions: 1, entity_mentions: 1, relationship_mentions: 1, page_links: 1, aliases: 1 },
      missing_count: 2,
      missing: ['source src-old', 'page hidden-page'],
    });
    const count = (table: string) => (handle!.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(['sources', 'pages', 'provenance', 'extractions', 'entity_mentions', 'aliases'].map(count)).toEqual([1, 1, 1, 1, 1, 1]);
    const logged = handle.db
      .prepare(`SELECT details FROM activity_log WHERE action_type = 'wiki_imported'`)
      .all() as Array<{ details: string }>;
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0].details)).toMatchObject({ skipped_rows: 7, skipped: body.skipped });
  });

  it('a complete backup leaves nothing out', async () => {
    handle = setupTestDb();
    const res = await importPOST(await buildBackup({ manifest: { format: 'kompl', version: 1, schema_version: 30 } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped: { total: number } };
    expect(body.skipped.total).toBe(0);
  });

  it('a backup the restore cannot hold restores nothing and says why', async () => {
    handle = setupTestDb();
    const res = await importPOST(
      await buildBackup({
        manifest: { format: 'kompl', version: 1, schema_version: 30 },
        tables: {
          sources: [{
            source_id: 'src-1', title: 'S', source_type: 'url', source_url: null, content_hash: 'h',
            file_path: '/data/raw/src-1.md.gz', status: 'active', date_ingested: '2025-01-01 00:00:00', metadata: null,
          }],
          // An event with no type: a broken backup, not an old one.
          activity_log: [{ timestamp: '2025-01-01 00:00:00', source_id: null, details: null }],
        },
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('import_failed');
    expect(body.message).toMatch(/NOT NULL/);
    const count = (table: string) => (handle!.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect(count('sources')).toBe(0);
  });

  it('imports columns added after the backup was made as NULL, and values of the wrong shape too', async () => {
    handle = setupTestDb();
    const source = {
      source_id: 'src-old', title: 'Old source', source_type: 'url', source_url: null, content_hash: 'h',
      file_path: '/data/raw/src-old.md.gz', status: 'active', date_ingested: '2025-01-01 00:00:00', metadata: null,
    };
    const session = {
      session_id: 's-old', status: 'completed', current_step: null, steps: '[]', error: null,
      started_at: null, completed_at: null, created_at: '2025-01-01 00:00:00', source_count: 1,
    };
    const plan = {
      plan_id: 'p-old', session_id: 's-old', title: 'T', page_type: 'entity', action: 'create',
      source_ids: '["src-old"]', existing_page_id: null, related_plan_ids: null, draft_content: 'x',
      draft_status: 'drafted', created_at: '2025-01-01 00:00:00',
    };
    const res = await importPOST(
      await buildBackup({
        manifest: { format: 'kompl', version: 1, schema_version: 19 },
        tables: {
          sources: [
            source,
            { ...source, source_id: 'src-bad', title_source: 7, title_rescued_at: false, compile_status: 'weird', compile_attempts: -1 },
            { ...source, source_id: 'src-kept', compile_status: 'failed', compile_attempts: 2, onboarding_session_id: 's-old' },
          ],
          activity_log: [{ timestamp: '2025-01-01 00:00:00', action_type: 'source_added', source_id: null, details: null }],
          compile_progress: [session, { ...session, session_id: 's-bad', compile_model: 'not-a-model' }],
          page_plans: [plan, { ...plan, plan_id: 'p-bad', used_source_ids: '{"not":"a list"}', draft_error: 3 }],
        },
      }),
    );
    expect(res.status).toBe(200);
    const rows = (sql: string) => handle!.db.prepare(sql).all();
    expect(rows('SELECT source_id, title_source, title_rescued_at FROM sources ORDER BY source_id')).toEqual([
      { source_id: 'src-bad', title_source: null, title_rescued_at: null },
      { source_id: 'src-kept', title_source: null, title_rescued_at: null },
      { source_id: 'src-old', title_source: null, title_rescued_at: null },
    ]);
    // A source's compile state comes back when the backup has it; otherwise
    // the source is restored compiled, with no session, as before.
    expect(
      rows('SELECT source_id, compile_status, compile_attempts, onboarding_session_id FROM sources ORDER BY source_id'),
    ).toEqual([
      { source_id: 'src-bad', compile_status: 'active', compile_attempts: 0, onboarding_session_id: null },
      { source_id: 'src-kept', compile_status: 'failed', compile_attempts: 2, onboarding_session_id: 's-old' },
      { source_id: 'src-old', compile_status: 'active', compile_attempts: 0, onboarding_session_id: null },
    ]);
    expect(rows(`SELECT session_id, step_key FROM activity_log WHERE action_type = 'source_added'`)).toEqual([
      { session_id: null, step_key: null },
    ]);
    expect(rows('SELECT session_id, compile_model FROM compile_progress ORDER BY session_id')).toEqual([
      { session_id: 's-bad', compile_model: null },
      { session_id: 's-old', compile_model: null },
    ]);
    expect(rows('SELECT plan_id, draft_error, used_source_ids FROM page_plans ORDER BY plan_id')).toEqual([
      { plan_id: 'p-bad', draft_error: null, used_source_ids: null },
      { plan_id: 'p-old', draft_error: null, used_source_ids: null },
    ]);
  });
});
