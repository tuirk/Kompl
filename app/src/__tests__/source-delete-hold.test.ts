/**
 * Issue #8: when the rewrite after a source delete fails, the page must not
 * stay live with the deleted source's material in it.
 *
 * Kompl tries the rewrite once more when the failure looks temporary (rate
 * limit, a model error, nlp-service unreachable), and only once per delete.
 * If the rewrite still fails, the page is archived (lib/page-hold.ts): it
 * leaves the wiki, search and the graph, stays readable under "Show
 * archived" with a plain reason, and comes back when a rewrite succeeds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/recompile', () => ({
  recompilePage: vi.fn(async () => ({ outcome: 'rewritten' as const })),
}));

import { recompilePage } from '../lib/recompile';
import { deleteOneSourceWithCascade } from '../lib/source-delete';
import { getAllPages, getCategoryGroups, searchPages } from '../lib/db';
import { getPageHold } from '../lib/page-hold';
import { getWikiGraph } from '../lib/wiki-graph';
import { setupTestDb, seedSource, seedPage, seedProvenance, getActivityCounts, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle;
const LONG_MD = 'x'.repeat(600);

function rateLimited(): Error {
  return Object.assign(new Error('llm_rate_limited'), { status: 429 });
}

function costCeiling(): Error {
  return Object.assign(new Error('daily_cost_ceiling'), { status: 503 });
}

/** A page shared by the source to delete and two that stay. */
function seedSharedPage(pageId: string, deleted: string, title = 'Ethereum'): void {
  seedPage(handle.db, { page_id: pageId, title, page_type: 'entity' });
  handle.db.prepare('INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)').run(pageId, title, 'proof of stake');
  for (const sid of [deleted, `${pageId}-k1`, `${pageId}-k2`]) {
    if (!handle.db.prepare('SELECT 1 FROM sources WHERE source_id = ?').get(sid)) {
      seedSource(handle.db, { source_id: sid, title: sid === deleted ? 'Old blog post' : sid, raw_markdown: LONG_MD });
    }
    seedProvenance(handle.db, pageId, sid);
  }
}

function pageType(pageId: string): string {
  return (handle.db.prepare('SELECT page_type FROM pages WHERE page_id = ?').get(pageId) as { page_type: string }).page_type;
}

beforeEach(() => {
  handle = setupTestDb();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
  vi.mocked(recompilePage).mockReset();
  vi.mocked(recompilePage).mockResolvedValue({ outcome: 'rewritten' });
});

afterEach(() => {
  vi.useRealTimers();
  handle.cleanup();
  vi.unstubAllGlobals();
});

describe('a rewrite that fails after a source delete', () => {
  it('archives the page with a plain reason instead of leaving it live', async () => {
    seedSharedPage('eth', 'blog');
    vi.mocked(recompilePage).mockRejectedValue(costCeiling());

    const result = await deleteOneSourceWithCascade('blog');

    expect(result).toMatchObject({ status: 'ok', pages_hidden: 1, pages_noted: 0, pages_rewritten: 0 });
    // A spending-limit refusal is not retried: it would fail the same way.
    expect(vi.mocked(recompilePage)).toHaveBeenCalledTimes(1);
    expect(pageType('eth')).toBe('archived');
    const hold = getPageHold('eth');
    expect(hold?.restore_page_type).toBe('entity');
    expect(hold?.reason).toContain('Old blog post');
    // The page left the wiki list, search and the graph.
    expect(getAllPages().map((p) => p.page_id)).not.toContain('eth');
    expect(getCategoryGroups().flatMap((g) => g.pages.map((p) => p.page_id))).not.toContain('eth');
    expect(searchPages('stake').map((p) => p.page_id)).not.toContain('eth');
    expect(getWikiGraph().nodes.map((n) => n.id)).not.toContain('eth');
    // ...but stays under Show archived.
    expect(getAllPages(true).map((p) => p.page_id)).toContain('eth');
    expect(getWikiGraph(true).nodes.find((n) => n.id === 'eth')?.archived).toBe(true);

    const row = handle.db
      .prepare("SELECT details FROM activity_log WHERE action_type = 'page_recompile_failed'")
      .get() as { details: string };
    expect(JSON.parse(row.details)).toMatchObject({ page_id: 'eth', hidden: true, attempts: 1 });
    expect((handle.db.prepare('SELECT source_count FROM pages WHERE page_id = ?').get('eth') as { source_count: number }).source_count).toBe(2);
    // No "Rewrite failed" note is appended to the page file any more.
    const writes = vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('/storage/'));
    expect(writes).toHaveLength(0);
  });

  it('tries once more after a temporary failure and keeps the page live when that works', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    seedSharedPage('eth', 'blog');
    vi.mocked(recompilePage).mockRejectedValueOnce(rateLimited()).mockResolvedValueOnce({ outcome: 'rewritten' });

    const pending = deleteOneSourceWithCascade('blog');
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({ status: 'ok', pages_rewritten: 1, pages_hidden: 0 });
    expect(vi.mocked(recompilePage)).toHaveBeenCalledTimes(2);
    expect(pageType('eth')).toBe('entity');
    expect(getPageHold('eth')).toBeNull();
    const counts = getActivityCounts(handle.db);
    expect(counts.page_recompiled).toBe(1);
    expect(counts.page_recompile_failed ?? 0).toBe(0);
  });

  it('retries at most once per delete: after a failed retry, later pages are archived straight away', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    seedSharedPage('eth', 'blog');
    seedSharedPage('btc', 'blog', 'Bitcoin');
    vi.mocked(recompilePage).mockRejectedValue(rateLimited());

    const pending = deleteOneSourceWithCascade('blog');
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({ status: 'ok', pages_hidden: 2 });
    expect(vi.mocked(recompilePage)).toHaveBeenCalledTimes(3);
    expect(pageType('eth')).toBe('archived');
    expect(pageType('btc')).toBe('archived');
    const details = (handle.db
      .prepare("SELECT details FROM activity_log WHERE action_type = 'page_recompile_failed' ORDER BY id")
      .all() as Array<{ details: string }>).map((r) => JSON.parse(r.details) as { attempts: number });
    expect(details.map((d) => d.attempts)).toEqual([2, 1]);
  });

  it('does not retry a rewrite that timed out', async () => {
    seedSharedPage('eth', 'blog');
    vi.mocked(recompilePage).mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));

    const result = await deleteOneSourceWithCascade('blog');

    expect(result).toMatchObject({ status: 'ok', pages_hidden: 1 });
    expect(vi.mocked(recompilePage)).toHaveBeenCalledTimes(1);
  });
});
