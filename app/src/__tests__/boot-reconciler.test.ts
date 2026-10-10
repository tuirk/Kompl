/**
 * The boot reconciler (src/instrumentation.ts): a page whose save was
 * deferred (pending_content still set) is written at startup, and only then
 * is its search vector refreshed. The commit's own refresh needs the file on
 * disk, so without this the vector would keep the old text. Saved Links has
 * no vector.
 */

import { afterEach, expect, it, vi } from 'vitest';
import { register } from '../instrumentation';
import { setSetting } from '../lib/db';
import { seedPage, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  handle?.cleanup();
  handle = null;
});

it('writes a deferred page at startup, then refreshes its vector', async () => {
  handle = setupTestDb();
  const db = handle.db;
  seedPage(db, { page_id: 'deferred', title: 'Deferred', page_type: 'concept', category: 'Crypto' });
  seedPage(db, { page_id: 'saved-links', title: 'Saved Links', page_type: 'overview' });
  db.prepare('UPDATE pages SET pending_content = ? WHERE page_id IN (?, ?)').run(
    '---\ntitle: "Deferred"\n---\n\nText.\n',
    'deferred',
    'saved-links',
  );
  setSetting('wikilinks_resync_version', '1'); // not under test here
  vi.spyOn(console, 'log').mockImplementation(() => {});

  const order: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const body = JSON.parse(String(init?.body ?? '{}')) as { page_id: string; metadata?: Record<string, unknown> };
      if (u.endsWith('/storage/write-page')) {
        order.push(`write:${body.page_id}`);
        return Response.json({ current_path: `/data/pages/${body.page_id}.md.gz`, previous_path: null });
      }
      if (u.endsWith('/vectors/upsert')) {
        order.push(`vector:${body.page_id}`);
        expect(body.metadata).toMatchObject({ title: 'Deferred', page_type: 'concept', category: 'Crypto' });
        return Response.json({ ok: true });
      }
      return new Response('not found', { status: 404 });
    }),
  );

  await register();

  await vi.waitFor(() => expect(order).toContain('vector:deferred'));
  expect(order.indexOf('write:deferred')).toBeLessThan(order.indexOf('vector:deferred'));
  expect(order).toContain('write:saved-links');
  expect(order).not.toContain('vector:saved-links');
  const pending = db.prepare('SELECT COUNT(*) AS n FROM pages WHERE pending_content IS NOT NULL').get() as { n: number };
  expect(pending.n).toBe(0);
});
