/**
 * A staged file upload can only name a file the upload route saved.
 *
 * Regression target: POST /api/onboarding/stage took any item.file_path for
 * connector 'file-upload', and DELETE /api/onboarding/session unlinked every
 * staged path, so two requests deleted any file the app can write, the
 * database (/data/db/kompl.db) included. The import step also read the file.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { POST as stage } from '../app/api/onboarding/stage/route';
import { DELETE as discard } from '../app/api/onboarding/session/route';
import { insertCollectStaging } from '../lib/db';
import { UPLOADS_DIR } from '../lib/upload-path';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle;
let outside: string;
const created: string[] = [];

beforeEach(() => {
  handle = setupTestDb();
  mkdirSync(UPLOADS_DIR, { recursive: true });
  outside = mkdtempSync(join(tmpdir(), 'kompl-outside-'));
});

afterEach(() => {
  handle.cleanup();
  rmSync(outside, { recursive: true, force: true });
  for (const p of created.splice(0)) rmSync(p, { force: true });
});

/** A file in the uploads folder, as POST /api/onboarding/upload saves one. */
function upload(name: string): string {
  const p = join(UPLOADS_DIR, `${Date.now()}-${Math.random().toString(16).slice(2)}-${name}`);
  writeFileSync(p, 'uploaded');
  created.push(p);
  return p;
}

function stageFile(session_id: string, file_path: string): Promise<Response> {
  return stage(
    new Request('http://localhost/api/onboarding/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id, connector: 'file-upload', items: [{ file_path }] }),
    })
  );
}

describe('POST /api/onboarding/stage with a file upload', () => {
  it('stages a file from the uploads folder', async () => {
    expect((await stageFile('sess-ok', upload('paper.pdf'))).status).toBe(200);
  });

  it('refuses any other path: the database, a way out of the folder, a relative path, a link out', async () => {
    const victim = join(outside, 'kompl.db');
    writeFileSync(victim, 'db');
    const link = join(UPLOADS_DIR, `link-${Date.now()}.pdf`);
    // Windows without Developer Mode may not create symlinks (EPERM); the
    // link case then runs only where it can (CI is Linux).
    let linked = true;
    try {
      symlinkSync(victim, link);
      created.push(link);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EPERM') throw e;
      linked = false;
    }

    for (const file_path of [
      victim,
      process.env.DB_PATH!,
      join(UPLOADS_DIR, '..', '..', 'db', 'kompl.db'),
      'paper.pdf',
      UPLOADS_DIR,
      ...(linked ? [link] : []),
    ]) {
      const res = await stageFile('sess-bad', file_path);
      expect(res.status, file_path).toBe(422);
      expect(((await res.json()) as { error: string }).error).toMatch(/file_path/);
    }
  });
});

describe('DELETE /api/onboarding/session', () => {
  it('unlinks a staged upload but never a file outside the uploads folder', async () => {
    const mine = upload('notes.md');
    const victim = join(outside, 'kompl.db');
    writeFileSync(victim, 'db');
    // A row staged before the stage route checked paths.
    insertCollectStaging({ stage_id: 'st-1', session_id: 'sess-old', connector: 'file-upload', payload: { file_path: mine } });
    insertCollectStaging({ stage_id: 'st-2', session_id: 'sess-old', connector: 'file-upload', payload: { file_path: victim } });

    const res = await discard(new Request('http://localhost/api/onboarding/session?session_id=sess-old', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { removed: { files_unlinked: number } }).removed.files_unlinked).toBe(1);
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(victim)).toBe(true);
  });
});
