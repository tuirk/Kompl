/**
 * A redo writes a compile's update again from the page as it was before the
 * compile (audit, low). The page already holds the update being redone;
 * drafting the update on top of it again meant a redo could never undo a
 * bad update. nlp-service keeps the page's earlier versions as dated
 * archives next to it (file_store.py); the one from before the compile's
 * first save of the page is the base.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { POST as draftPOST } from '../app/api/compile/draft/route';
import { pageTextBeforeCompile } from '../lib/compile-redo/baseline';
import { saveRedo } from '../lib/compile-redo/state';
import { DATA_ROOT } from '../lib/db';
import { seedCompileProgress, seedPage, seedPagePlan, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;
const files: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
  for (const f of files.splice(0)) rmSync(f, { force: true });
});

const SESSION = 'sess-redo-base';
const BEFORE = '---\ntitle: "Topic"\n---\n\nTopic as it was before the compile.';
const AFTER = '---\ntitle: "Topic"\n---\n\nTopic as it was before the compile. The compile\'s bad update.';

function archive(pageId: string, stamp: string, text: string): void {
  const file = join(DATA_ROOT, 'pages', `${pageId}.${stamp}-000000.md.gz`);
  writeFileSync(file, gzipSync(Buffer.from(text, 'utf-8')));
  files.push(file);
}

/** A page this session's compile updated on 2026-10-01 at noon; its earlier versions kept. */
function seedUpdatedPage(): { page: string; source: string } {
  const db = handle!.db;
  seedCompileProgress(db, SESSION);
  const source = seedSource(db, { onboarding_session_id: SESSION, raw_markdown: 'News about the topic.' });
  const page = seedPage(db, { title: 'Topic' });
  db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run(AFTER, page);
  archive(page, '20260901-080000', 'An older version.');
  archive(page, '20260930-090000', BEFORE);
  db.prepare(
    `INSERT INTO activity_log (action_type, source_id, details, session_id, step_key, timestamp)
     VALUES ('page_compiled', ?, ?, ?, 'commit', '2026-10-01 12:00:00')`,
  ).run(source, JSON.stringify({ page_id: page, title: 'Topic', action: 'update' }), SESSION);
  return { page, source };
}

function redoRunning(): void {
  saveRedo({
    session_id: SESSION, point: 'write', status: 'running', model: 'm', model_label: 'm',
    confirmed: { pages: 1, max_pages: 1, calls_low: 0, calls_high: 0, cost_usd_low: 0, cost_usd_high: 0, minutes_low: 0, minutes_high: 0 },
    own_pages: [], skipped: [], usage_at_start: null, outcome: null, started_at: '', finished_at: null,
  });
}

async function draftedFrom(): Promise<string | null> {
  let existing: string | null = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/pipeline/draft-page')) {
        existing = (JSON.parse(String(init?.body)) as { existing_content: string | null }).existing_content;
        return Response.json({ markdown: '---\ntitle: "Topic"\n---\n\nNew text.' });
      }
      return new Response('not found', { status: 404 });
    }),
  );
  const res = await draftPOST(
    new Request('http://test/api/compile/draft', { method: 'POST', body: JSON.stringify({ session_id: SESSION }) }),
  );
  expect(res.status).toBe(200);
  return existing;
}

describe('redo of an update', () => {
  it('drafts the update again from the page as it was before the compile', async () => {
    handle = setupTestDb();
    const { page, source } = seedUpdatedPage();
    seedPagePlan(handle.db, { session_id: SESSION, title: 'Topic', action: 'update', source_ids: [source], existing_page_id: page, draft_status: 'planned' });
    // An earlier redo already wrote the page again: the compile's own
    // version, saved in the second of its first save, is kept too.
    archive(page, '20261001-120000', AFTER);
    redoRunning();

    const existing = await draftedFrom();
    expect(existing).toContain('Topic as it was before the compile.');
    expect(existing).not.toContain('bad update');
  });

  it('a normal compile updates the page as it is', async () => {
    handle = setupTestDb();
    const { page, source } = seedUpdatedPage();
    seedPagePlan(handle.db, { session_id: SESSION, title: 'Topic', action: 'update', source_ids: [source], existing_page_id: page, draft_status: 'planned' });

    expect(await draftedFrom()).toContain('bad update');
  });

  it('finds no earlier version for a page the session never saved, or with none kept', () => {
    handle = setupTestDb();
    const { page } = seedUpdatedPage();
    expect(pageTextBeforeCompile(handle.db, SESSION, page)).toBe(BEFORE);
    expect(pageTextBeforeCompile(handle.db, 'another-session', page)).toBeNull();
    const bare = seedPage(handle.db, { title: 'Bare' });
    handle.db
      .prepare(
        `INSERT INTO activity_log (action_type, source_id, details, session_id, step_key)
         VALUES ('page_compiled', NULL, ?, ?, 'commit')`,
      )
      .run(JSON.stringify({ page_id: bare }), SESSION);
    expect(pageTextBeforeCompile(handle.db, SESSION, bare)).toBeNull();
  });
});
