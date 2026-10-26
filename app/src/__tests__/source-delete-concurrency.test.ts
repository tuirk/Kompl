/**
 * A source delete rewrites pages for up to twenty minutes. It must survive a
 * restart halfway and never overwrite another writer's page.
 *
 *   - The source's provenance leaves each page only when that page is
 *     handled, so after a restart, deleting the source again finds the
 *     pages the first delete had not reached.
 *   - Deletes run one at a time, and none starts while a compile, the wiki
 *     repair or the page update runs: they write the same pages.
 *   - The rewrite takes the page lock (lib/redraft.ts) and checks the page
 *     version token (lib/page-rewrite.ts) in its commit, so a page changed
 *     during the LLM call is not overwritten: the rewrite is tried once
 *     more from the page as it is now.
 *   - After the file write it clears the outbox only while it still holds
 *     its own text.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DELETE as deleteRoute } from '../app/api/sources/[source_id]/route';
import { POST as bulkDeletePOST } from '../app/api/sources/bulk-delete/route';
import { DATA_ROOT, getPagesBySourceId } from '../lib/db';
import { __resetPageUpgradeStateForTesting, pageUpgradeState } from '../lib/page-upgrade-state';
import { recompilePage } from '../lib/recompile';
import { withPageLock } from '../lib/redraft';
import { deleteOneSourceWithCascade } from '../lib/source-delete';
import { __resetWikiRepairStateForTesting, repairState } from '../lib/wiki-repair/state';
import { setupTestDb, seedPage, seedProvenance, seedSource, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle;
const LONG_MD = 'Ethereum moved to proof of stake. '.repeat(30);

interface Calls {
  drafts: string[];
  writes: string[];
}

/** nlp-service stub. `onDraft` runs inside each draft-page call (the LLM call in flight). */
function mockNlp(hooks: { onDraft?: (n: number, title: string) => void; onWrite?: () => void } = {}): Calls {
  const calls: Calls = { drafts: [], writes: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/pipeline/draft-page')) {
        const { title } = JSON.parse(String(init?.body ?? '{}')) as { title: string };
        calls.drafts.push(title);
        hooks.onDraft?.(calls.drafts.length, title);
        return Response.json({ markdown: `---\ntitle: ${title}\n---\n\nRewrite ${calls.drafts.length} [S1].\n` });
      }
      if (u.endsWith('/storage/write-page')) {
        calls.writes.push((JSON.parse(String(init?.body ?? '{}')) as { page_id: string }).page_id);
        hooks.onWrite?.();
        return Response.json({ current_path: 'x', previous_path: null });
      }
      return Response.json({ ok: true });
    }),
  );
  return calls;
}

/** Pages shared by "blog" (the source to delete) and two sources that stay. */
function seedSharedPages(pageIds: string[]): void {
  for (const sid of ['blog', 'k1', 'k2']) seedSource(handle.db, { source_id: sid, raw_markdown: LONG_MD });
  for (const pageId of pageIds) {
    seedPage(handle.db, { page_id: pageId, title: `Page ${pageId}`, page_type: 'entity' });
    for (const sid of ['blog', 'k1', 'k2']) seedProvenance(handle.db, pageId, sid);
  }
}

function deleteRequest(sourceId: string): Promise<Response> {
  return deleteRoute(new Request(`http://localhost/api/sources/${sourceId}`, { method: 'DELETE' }), {
    params: Promise.resolve({ source_id: sourceId }),
  });
}

function bulkRequest(ids: string[]): Promise<Response> {
  return bulkDeletePOST(
    new Request('http://localhost/api/sources/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }),
  );
}

function writePageFile(pageId: string, markdown: string): void {
  fs.writeFileSync(path.join(DATA_ROOT, 'pages', `${pageId}.md.gz`), zlib.gzipSync(Buffer.from(markdown)));
}

function readFileGz(pageId: string): string {
  return zlib.gunzipSync(fs.readFileSync(path.join(DATA_ROOT, 'pages', `${pageId}.md.gz`))).toString('utf-8');
}

function pageRow(pageId: string): { page_type: string; pending_content: string | null } {
  return handle.db.prepare('SELECT page_type, pending_content FROM pages WHERE page_id = ?').get(pageId) as never;
}

beforeEach(() => {
  handle = setupTestDb();
});

afterEach(() => {
  vi.useRealTimers();
  __resetPageUpgradeStateForTesting();
  __resetWikiRepairStateForTesting();
  handle.cleanup();
  vi.unstubAllGlobals();
});

describe('a delete stopped halfway', () => {
  it('leaves the source on the pages it has not reached, so deleting again finds them', async () => {
    seedSharedPages(['p1', 'p2', 'p3']);
    const seen: string[][] = [];
    mockNlp({ onDraft: () => seen.push(getPagesBySourceId('blog').map((p) => p.page_id).sort()) });

    const result = await deleteOneSourceWithCascade('blog');

    expect(result).toMatchObject({ status: 'ok', pages_rewritten: 3 });
    // While each page's rewrite was in flight, that page and the ones after it still named the source.
    expect(seen).toEqual([['p1', 'p2', 'p3'], ['p2', 'p3'], ['p3']]);
    expect(handle.db.prepare("SELECT COUNT(*) AS n FROM provenance WHERE source_id = 'blog'").get()).toEqual({ n: 0 });
    expect(handle.db.prepare("SELECT 1 FROM sources WHERE source_id = 'blog'").get()).toBeUndefined();
  });
});

describe('the note a short source leaves when deleted', () => {
  it('goes through the normal page write, which archives the text it replaces, never into the live file in place', async () => {
    for (const sid of ['k1', 'k2']) seedSource(handle.db, { source_id: sid, raw_markdown: LONG_MD });
    seedSource(handle.db, { source_id: 'tweet', title: 'A tweet', raw_markdown: 'short' });
    seedPage(handle.db, { page_id: 'p1', title: 'Page p1', page_type: 'entity' });
    for (const sid of ['tweet', 'k1', 'k2']) seedProvenance(handle.db, 'p1', sid);
    writePageFile('p1', '---\ntitle: Page p1\n---\n\nBody.\n');
    const written: Array<{ page_id: string; markdown: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/storage/write-page')) {
          written.push(JSON.parse(String(init?.body ?? '{}')) as { page_id: string; markdown: string });
          return Response.json({ current_path: 'x', previous_path: '/data/pages/p1.20261026-000000-000000.md.gz' });
        }
        return Response.json({ ok: true });
      }),
    );

    const result = await deleteOneSourceWithCascade('tweet');

    expect(result).toMatchObject({ status: 'ok', pages_noted: 1 });
    expect(written).toHaveLength(1);
    expect(written[0].page_id).toBe('p1');
    expect(written[0].markdown).toMatch(/Body\.\n+> _Source "A tweet" deleted on \d{4}-\d{2}-\d{2}\._\n$/);
    // The file on disk was left to nlp-service's atomic write.
    expect(readFileGz('p1')).toBe('---\ntitle: Page p1\n---\n\nBody.\n');
    expect(pageRow('p1').pending_content).toBeNull();
  });
});

describe('a delete while something else writes pages', () => {
  it('is refused while a compile runs, and changes nothing', async () => {
    seedSharedPages(['p1']);
    handle.db
      .prepare(`INSERT INTO compile_progress (session_id, status, steps, started_at) VALUES ('busy', 'running', '{}', datetime('now'))`)
      .run();
    const calls = mockNlp();

    const one = await deleteRequest('blog');
    const bulk = await bulkRequest(['blog', 'k1']);

    expect(one.status).toBe(409);
    expect(await one.json()).toMatchObject({ error_code: 'session_in_progress' });
    expect(bulk.status).toBe(409);
    expect(await bulk.json()).toMatchObject({ error_code: 'session_in_progress' });
    expect(calls.drafts).toEqual([]);
    expect(handle.db.prepare("SELECT COUNT(*) AS n FROM provenance WHERE source_id = 'blog'").get()).toEqual({ n: 1 });
    expect(handle.db.prepare("SELECT 1 FROM sources WHERE source_id = 'blog'").get()).toBeDefined();
  });

  it('runs deletes sent together one after the other, each seeing what the one before left', async () => {
    seedSharedPages(['p1']);
    const calls = mockNlp();

    const [first, second] = await Promise.all([deleteRequest('blog'), deleteRequest('k1')]);

    expect(await first.json()).toMatchObject({ pages_rewritten: 1 });
    // k1 was then the page's last source but one, so the page went.
    expect(await second.json()).toMatchObject({ pages_deleted: 1 });
    expect(calls.drafts).toEqual(['Page p1']);
    expect(handle.db.prepare("SELECT 1 FROM pages WHERE page_id = 'p1'").get()).toBeUndefined();
  });

  it('is refused while the wiki repair or the page update runs', async () => {
    seedSharedPages(['p1']);
    mockNlp();

    repairState().starting = true;
    const repairing = await deleteRequest('blog');
    expect(repairing.status).toBe(409);
    expect(await repairing.json()).toMatchObject({ error_code: 'wiki_repair_in_progress' });
    __resetWikiRepairStateForTesting();

    pageUpgradeState().starting = true;
    const upgrading = await bulkRequest(['blog']);
    expect(upgrading.status).toBe(409);
    expect(await upgrading.json()).toMatchObject({ error_code: 'page_upgrade_in_progress' });

    expect(handle.db.prepare("SELECT 1 FROM sources WHERE source_id = 'blog'").get()).toBeDefined();
  });

  it('does not overwrite a page changed during the rewrite; it rewrites it again from the page as it is now', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    seedSharedPages(['p1']);
    seedSource(handle.db, { source_id: 'k3', raw_markdown: LONG_MD });
    // A compile credits k3 to the page while the first rewrite waits for the model.
    const calls = mockNlp({ onDraft: (n) => n === 1 && seedProvenance(handle.db, 'p1', 'k3', 'updated') });

    const pending = deleteOneSourceWithCascade('blog');
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({ status: 'ok', pages_rewritten: 1, pages_hidden: 0 });
    expect(calls.drafts).toHaveLength(2);
    // Only the second rewrite, drafted after the change, was written.
    expect(calls.writes).toEqual(['p1']);
    expect(pageRow('p1').page_type).toBe('entity');
  });

  it('waits its turn behind another action on the same page', async () => {
    seedSharedPages(['p1']);
    mockNlp();

    await withPageLock('p1', async () => {
      await expect(recompilePage('p1', 'blog')).rejects.toMatchObject({ code: 'page_action_in_progress' });
    });
    await expect(recompilePage('p1', 'blog')).resolves.toEqual({ outcome: 'rewritten' });
  });

  it("leaves newer text in the outbox when another writer queued it during the file write", async () => {
    seedSharedPages(['p1']);
    mockNlp({ onWrite: () => handle.db.prepare("UPDATE pages SET pending_content = 'newer text' WHERE page_id = 'p1'").run() });

    await recompilePage('p1', 'blog');

    expect(pageRow('p1').pending_content).toBe('newer text');
  });
});
