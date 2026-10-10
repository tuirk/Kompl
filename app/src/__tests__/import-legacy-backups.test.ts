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
}): Promise<Request> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(opts.manifest));
  zip.file('db/pages.json', '[]');
  zip.file('db/sources.json', '[]');
  if (opts.settings) zip.file('db/settings.json', JSON.stringify(opts.settings));
  if (opts.chatMessages) zip.file('db/chat_messages.json', JSON.stringify(opts.chatMessages));
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
    expect(setting('schema_version')).toBe('27');
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
});
