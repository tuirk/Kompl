/**
 * POST /api/sources/bulk-delete — issue #46 regression suite.
 *
 * Pre-fix, `Promise.allSettled` fan-out of single-source DELETEs left every
 * concurrent handler reading `remainingCount` after only its own provenance
 * prune, so N-1 of them recompiled pages that were about to be deleted. Net:
 * 19 wasted Gemini calls on a page shared by 20 sources.
 *
 * Fix: server-side bulk endpoint passes a `batchSiblingIds` set into the
 * shared per-source helper, which subtracts batch siblings from
 * `remainingCount`. Source #1 of a 5-shared-source bulk now sees 0 remaining
 * → deletePage fires once. Sources 2-5 find getPagesBySourceId=[] (provenance
 * cascaded by deletePage) and skip cleanly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/recompile', () => ({
  recompilePage: vi.fn(async () => ({ outcome: 'rewritten' as const })),
}));

import { POST } from '../app/api/sources/bulk-delete/route';
import { recompilePage } from '../lib/recompile';
import {
  setupTestDb,
  seedSource,
  seedPage,
  seedProvenance,
  getActivityCounts,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle;

const LONG_MD = 'x'.repeat(600); // ≥500 → triggers recompile branch
const SHORT_MD = 'short'; // <500 → triggers provenance-note branch

function postBulk(ids: string[]): Request {
  return new Request('http://localhost/api/sources/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}

function postRaw(body: string | object | null): Request {
  return new Request('http://localhost/api/sources/bulk-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  handle = setupTestDb();
  // Stub fetch — source-delete.ts fires fire-and-forget /vectors/delete calls
  // we don't want to actually hit during tests.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  vi.mocked(recompilePage).mockClear();
  vi.mocked(recompilePage).mockResolvedValue({ outcome: 'rewritten' });
});

afterEach(() => {
  handle.cleanup();
  vi.unstubAllGlobals();
});

describe('bulk-delete — canonical issue #46 regression', () => {
  it('5 sources sharing 1 page, all bulk-deleted → 1 page_deleted, 0 recompiles', async () => {
    const page_id = seedPage(handle.db, { page_id: 'shared-p' });
    const ids = [];
    for (let i = 1; i <= 5; i++) {
      const sid = seedSource(handle.db, { source_id: `s${i}`, raw_markdown: LONG_MD });
      seedProvenance(handle.db, page_id, sid);
      ids.push(sid);
    }

    const res = await POST(postBulk(ids));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { summary: { ok: number; not_found: number; error: number } };
    expect(body.summary).toEqual({ ok: 5, not_found: 0, error: 0 });

    expect(vi.mocked(recompilePage)).toHaveBeenCalledTimes(0);

    const counts = getActivityCounts(handle.db);
    expect(counts.page_deleted).toBe(1);
    expect(counts.page_recompiled ?? 0).toBe(0);
    expect(counts.page_provenance_updated ?? 0).toBe(0);
    expect(counts.source_deleted).toBe(5);

    // Pages and provenance gone.
    const pageRow = handle.db.prepare('SELECT 1 FROM pages WHERE page_id = ?').get(page_id);
    expect(pageRow).toBeUndefined();
    const provRows = handle.db.prepare('SELECT 1 FROM provenance').all();
    expect(provRows).toHaveLength(0);
  });

  it('20 sources sharing 1 page, all bulk-deleted → 1 page_deleted, 0 recompiles', async () => {
    // Pinned variant of the issue body's exact reproduction (20-source fixture).
    const page_id = seedPage(handle.db, { page_id: 'shared-20' });
    const ids = [];
    for (let i = 1; i <= 20; i++) {
      const sid = seedSource(handle.db, { source_id: `t${i}`, raw_markdown: LONG_MD });
      seedProvenance(handle.db, page_id, sid);
      ids.push(sid);
    }

    const res = await POST(postBulk(ids));
    expect(res.status).toBe(200);

    expect(vi.mocked(recompilePage)).toHaveBeenCalledTimes(0);
    const counts = getActivityCounts(handle.db);
    expect(counts.page_deleted).toBe(1);
    expect(counts.page_recompiled ?? 0).toBe(0);
    expect(counts.source_deleted).toBe(20);
  });
});

describe('bulk-delete — page survives partial deletion', () => {
  it('a,b,c,d,e share P; bulk-delete a,b,c → 3 page_recompiled (intermediate behavior)', async () => {
    const page_id = seedPage(handle.db, { page_id: 'p-survive' });
    const all = ['ps-a', 'ps-b', 'ps-c', 'ps-d', 'ps-e'].map((sid) =>
      seedSource(handle.db, { source_id: sid, raw_markdown: LONG_MD }),
    );
    for (const sid of all) seedProvenance(handle.db, page_id, sid);

    const toDelete = all.slice(0, 3);
    const res = await POST(postBulk(toDelete));
    expect(res.status).toBe(200);

    // Source A is processed first. remainingProvenance = [B,C,D,E].
    // batchSiblingIds = {A,B,C}. remainingExcludingBatch = [D,E]. remainingCount=2 → recompile.
    // Source B: getPagesBySourceId returns P only if B's provenance row still exists —
    //   it does (B's prune happens at start of B's helper call), but A's helper already
    //   ran setPageSourceCount(P, 2) and called recompilePage. B's helper call:
    //   getPagesBySourceId(B) returns [P]. removeProvenanceForSource(B). remaining = [C,D,E].
    //   filter siblings {A,B,C} = [D,E]. remainingCount=2 → recompile.
    //   So actually 3 recompiles can fire here, NOT 1, because each batch sibling still
    //   has its own provenance row to P at the time it runs.
    //
    // Wait — re-read the helper: remainingProvenance is read AFTER removeProvenanceForSource(self).
    // So when A runs: A's prov already removed, [B,C,D,E] remain. Filter siblings {A,B,C} = [D,E].
    //   recompile.
    // When B runs: B's prov also removed, [C,D,E] remain. Filter siblings = [D,E]. recompile.
    // When C runs: C's prov removed, [D,E] remain. Filter siblings = [D,E]. recompile.
    // 3 recompiles, all redundant (same final state). The bug is only fully fixed for the
    // remainingCount<=1 branch — survivors-on-shared-page still over-recompile in the
    // multi-survivor case. For the canonical issue #46 reproduction (delete ALL sources of
    // a shared page), this is irrelevant because remainingCount=0 deletes the page on the
    // first sibling.
    //
    // This test pins that intermediate behavior so a future fix tightening the multi-survivor
    // case is explicit.
    expect(vi.mocked(recompilePage)).toHaveBeenCalledTimes(3);
    const counts = getActivityCounts(handle.db);
    expect(counts.page_recompiled).toBe(3);
    expect(counts.page_deleted ?? 0).toBe(0);
    expect(counts.source_deleted).toBe(3);

    // Page survives.
    const pageRow = handle.db.prepare('SELECT 1 FROM pages WHERE page_id = ?').get(page_id);
    expect(pageRow).toBeDefined();
    // Only D,E provenance remains.
    const remaining = handle.db
      .prepare('SELECT source_id FROM provenance WHERE page_id = ? ORDER BY source_id')
      .all(page_id) as Array<{ source_id: string }>;
    expect(remaining.map((r) => r.source_id)).toEqual([all[3], all[4]].sort());
  });

  it('a,b,c share P; bulk-delete a,b → page deleted (1 survivor triggers <=1 rule)', async () => {
    const page_id = seedPage(handle.db, { page_id: 'p-onesurvivor' });
    const a = seedSource(handle.db, { source_id: 'pos-a', raw_markdown: LONG_MD });
    const b = seedSource(handle.db, { source_id: 'pos-b', raw_markdown: LONG_MD });
    const c = seedSource(handle.db, { source_id: 'pos-c', raw_markdown: LONG_MD });
    seedProvenance(handle.db, page_id, a);
    seedProvenance(handle.db, page_id, b);
    seedProvenance(handle.db, page_id, c);

    const res = await POST(postBulk([a, b]));
    expect(res.status).toBe(200);

    // a processed first: remaining = [b,c]. Filter {a,b} = [c]. remainingCount=1 → deletePage.
    expect(vi.mocked(recompilePage)).toHaveBeenCalledTimes(0);
    const counts = getActivityCounts(handle.db);
    expect(counts.page_deleted).toBe(1);
    expect(counts.page_recompiled ?? 0).toBe(0);

    // C survives as a source row but its page is gone.
    const cRow = handle.db.prepare('SELECT 1 FROM sources WHERE source_id = ?').get(c);
    expect(cRow).toBeDefined();
    const pageRow = handle.db.prepare('SELECT 1 FROM pages WHERE page_id = ?').get(page_id);
    expect(pageRow).toBeUndefined();
  });
});

describe('bulk-delete — short source provenance-note path', () => {
  it('3 sources share P, 1 short, bulk-delete the short one only → 1 page_provenance_updated', async () => {
    const page_id = seedPage(handle.db, { page_id: 'p-short' });
    const long1 = seedSource(handle.db, { source_id: 'l1', raw_markdown: LONG_MD });
    const long2 = seedSource(handle.db, { source_id: 'l2', raw_markdown: LONG_MD });
    const short = seedSource(handle.db, { source_id: 'sh', raw_markdown: SHORT_MD });
    seedProvenance(handle.db, page_id, long1);
    seedProvenance(handle.db, page_id, long2);
    seedProvenance(handle.db, page_id, short);

    const res = await POST(postBulk([short]));
    expect(res.status).toBe(200);

    expect(vi.mocked(recompilePage)).toHaveBeenCalledTimes(0);
    const counts = getActivityCounts(handle.db);
    expect(counts.page_provenance_updated).toBe(1);
    expect(counts.page_recompiled ?? 0).toBe(0);
    expect(counts.page_deleted ?? 0).toBe(0);
  });
});

describe('bulk-delete — recompile failure fallback', () => {
  it('mock recompilePage to throw → page_recompile_failed event + remaining sources still deleted', async () => {
    const p1 = seedPage(handle.db, { page_id: 'p-rf1' });
    const p2 = seedPage(handle.db, { page_id: 'p-rf2' });
    const a = seedSource(handle.db, { source_id: 'rf-a', raw_markdown: LONG_MD });
    const b = seedSource(handle.db, { source_id: 'rf-b', raw_markdown: LONG_MD });
    const keep1 = seedSource(handle.db, { source_id: 'rf-k1', raw_markdown: LONG_MD });
    const keep2 = seedSource(handle.db, { source_id: 'rf-k2', raw_markdown: LONG_MD });
    // p1: shared by A + keep1 + keep2 (3 sources). Delete A → recompile branch (2 remain).
    seedProvenance(handle.db, p1, a);
    seedProvenance(handle.db, p1, keep1);
    seedProvenance(handle.db, p1, keep2);
    // p2: shared by B + keep1 + keep2. Delete B → recompile branch.
    seedProvenance(handle.db, p2, b);
    seedProvenance(handle.db, p2, keep1);
    seedProvenance(handle.db, p2, keep2);

    vi.mocked(recompilePage).mockRejectedValue(new Error('draft_page_failed'));

    const res = await POST(postBulk([a, b]));
    expect(res.status).toBe(200);

    const counts = getActivityCounts(handle.db);
    expect(counts.page_recompile_failed).toBe(2);
    expect(counts.page_recompiled ?? 0).toBe(0);
    expect(counts.source_deleted).toBe(2);

    // Both source rows actually gone.
    const sources = handle.db
      .prepare('SELECT source_id FROM sources WHERE source_id IN (?, ?)')
      .all(a, b);
    expect(sources).toHaveLength(0);
  });
});

describe('bulk-delete — input validation', () => {
  it('invalid JSON → 400', async () => {
    const res = await POST(postRaw('not-json{{{'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_json');
  });

  it('non-object body (array) → 400', async () => {
    const res = await POST(postRaw([]));
    expect(res.status).toBe(400);
  });

  it('missing ids → 400', async () => {
    const res = await POST(postRaw({}));
    expect(res.status).toBe(400);
  });

  it('ids not an array → 400', async () => {
    const res = await POST(postRaw({ ids: 'A' }));
    expect(res.status).toBe(400);
  });

  it('empty ids → 400', async () => {
    const res = await POST(postRaw({ ids: [] }));
    expect(res.status).toBe(400);
  });

  it('over cap (101 ids) → 400', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `over-${i}`);
    const res = await POST(postRaw({ ids }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { cap: number };
    expect(body.cap).toBe(100);
  });

  it('non-string ids filtered out — pure-bad input becomes empty → 400', async () => {
    const res = await POST(postRaw({ ids: [123, null, true] }));
    expect(res.status).toBe(400);
  });
});

describe('bulk-delete — id handling', () => {
  it('duplicate ids deduped silently — single result row per unique id', async () => {
    const sid = seedSource(handle.db, { source_id: 'dup', raw_markdown: LONG_MD });
    const res = await POST(postBulk([sid, sid, sid]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      count: number;
      results: Array<{ source_id: string }>;
    };
    expect(body.count).toBe(1);
    expect(body.results).toHaveLength(1);

    const counts = getActivityCounts(handle.db);
    expect(counts.source_deleted).toBe(1);
  });

  it('unknown id mixed with valid → not_found for that one, others succeed, batch returns 200', async () => {
    const sid = seedSource(handle.db, { source_id: 'real', raw_markdown: LONG_MD });
    const res = await POST(postBulk([sid, 'does-not-exist']));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: { ok: number; not_found: number; error: number };
      results: Array<{ source_id: string; status: string }>;
    };
    expect(body.summary).toEqual({ ok: 1, not_found: 1, error: 0 });
    expect(body.results.find((r) => r.source_id === sid)?.status).toBe('ok');
    expect(body.results.find((r) => r.source_id === 'does-not-exist')?.status).toBe('not_found');
  });

  it('single id behaves like single-source DELETE', async () => {
    const page_id = seedPage(handle.db, { page_id: 'singleton' });
    const sid = seedSource(handle.db, { source_id: 'solo', raw_markdown: LONG_MD });
    seedProvenance(handle.db, page_id, sid);

    const res = await POST(postBulk([sid]));
    expect(res.status).toBe(200);

    const counts = getActivityCounts(handle.db);
    expect(counts.page_deleted).toBe(1);
    expect(counts.source_deleted).toBe(1);
  });
});

describe('bulk-delete — activity correlation', () => {
  it('every activity row from the batch carries the same bulk_id', async () => {
    const page_id = seedPage(handle.db, { page_id: 'corr-p' });
    const ids = [];
    for (let i = 1; i <= 3; i++) {
      const sid = seedSource(handle.db, { source_id: `c${i}`, raw_markdown: LONG_MD });
      seedProvenance(handle.db, page_id, sid);
      ids.push(sid);
    }

    const res = await POST(postBulk(ids));
    const body = (await res.json()) as { bulk_id: string };
    expect(body.bulk_id).toMatch(/^[0-9a-f-]{36}$/);

    const rows = handle.db
      .prepare(`SELECT details FROM activity_log WHERE action_type = 'source_deleted'`)
      .all() as Array<{ details: string }>;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      const d = JSON.parse(r.details) as { bulk_id?: string };
      expect(d.bulk_id).toBe(body.bulk_id);
    }
  });

  it('single-source DELETE path emits NO bulk_id field', async () => {
    // Sanity check: helper called with default empty Set + null bulkId from the
    // single-source route does not introduce bulk_id into details.
    const sid = seedSource(handle.db, { source_id: 'no-bulk', raw_markdown: LONG_MD });
    const { deleteOneSourceWithCascade } = await import('../lib/source-delete');
    await deleteOneSourceWithCascade(sid);

    const row = handle.db
      .prepare(`SELECT details FROM activity_log WHERE action_type = 'source_deleted'`)
      .get() as { details: string };
    const d = JSON.parse(row.details) as { bulk_id?: string };
    expect(d.bulk_id).toBeUndefined();
  });
});

describe('bulk-delete — issue #46 before-vs-after smoking gun', () => {
  // These tests pin BOTH the bug AND the fix on the same fixture.
  //
  // Before: parallel single-source DELETEs trigger N-1 wasted recompiles
  //         (each handler computes remainingCount after only its own provenance
  //         prune, sees stale state from siblings still in flight).
  // After:  one bulk-delete call → 0 recompiles, 1 page_deleted.
  //
  // The single-source route is intentionally left with the original semantics
  // (passes empty batchSiblingIds), so the BEFORE test continues to demonstrate
  // the original race against the un-coordinated single-source endpoint. The UI
  // no longer fans out single-source DELETEs (SourcesTable.handleBulkDelete now
  // calls the bulk endpoint), so users never trigger the BEFORE path in normal
  // usage. The BEFORE test exists to keep the bug evidence in version control.

  function seedSharedPage(N: number): { page_id: string; ids: string[] } {
    const page_id = seedPage(handle.db, { page_id: `bvsa-p-${N}` });
    const ids: string[] = [];
    for (let i = 1; i <= N; i++) {
      const sid = seedSource(handle.db, {
        source_id: `bvsa-s-${N}-${i}`,
        raw_markdown: LONG_MD,
      });
      seedProvenance(handle.db, page_id, sid);
      ids.push(sid);
    }
    return { page_id, ids };
  }

  it('BEFORE — parallel single-source DELETEs fire N-1 wasted recompiles on shared page', async () => {
    // Reproduces the issue body's "20 sources / 1 shared page" scenario by
    // calling the single-source DELETE handler in parallel — same code path
    // SourcesTable.handleBulkDelete used to take with Promise.allSettled.
    const { page_id, ids } = seedSharedPage(20);

    const { DELETE } = await import('../app/api/sources/[source_id]/route');

    await Promise.allSettled(
      ids.map((id) =>
        DELETE(new Request(`http://localhost/api/sources/${id}`, { method: 'DELETE' }), {
          params: Promise.resolve({ source_id: id }),
        }),
      ),
    );

    const recompileCallCount = vi.mocked(recompilePage).mock.calls.length;
    const counts = getActivityCounts(handle.db);

    // Pre-fix observed: 18 of 20 handlers hit the recompile branch on a 20-shared
    // fixture. We assert >0 (not exactly 18) because microtask ordering can vary
    // across Node versions; the invariant is "any wasted recompile is a bug."
    expect(recompileCallCount).toBeGreaterThan(0);
    expect(counts.page_recompiled ?? 0).toBeGreaterThan(0);

    // Page does eventually get deleted — the bug is wasted Gemini quota +
    // confusing activity feed, not data loss.
    expect(handle.db.prepare('SELECT 1 FROM pages WHERE page_id = ?').get(page_id)).toBeUndefined();
  });

  it('AFTER — single bulk-delete on the same fixture fires zero recompiles', async () => {
    const { page_id, ids } = seedSharedPage(20);

    const res = await POST(postBulk(ids));
    expect(res.status).toBe(200);

    // FIX: zero recompiles.
    expect(vi.mocked(recompilePage)).toHaveBeenCalledTimes(0);
    const counts = getActivityCounts(handle.db);
    expect(counts.page_recompiled ?? 0).toBe(0);
    expect(counts.page_deleted).toBe(1);
    expect(counts.source_deleted).toBe(20);

    // Page deleted, every source row gone.
    expect(handle.db.prepare('SELECT 1 FROM pages WHERE page_id = ?').get(page_id)).toBeUndefined();
    const remaining = handle.db
      .prepare(`SELECT COUNT(*) AS n FROM sources WHERE source_id IN (${ids.map(() => '?').join(',')})`)
      .get(...ids) as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('AFTER — same final state as BEFORE, but no Gemini quota spent', async () => {
    // Cross-check: end states must match exactly. This locks in that the fix
    // is not just "fewer recompiles" but "identical observable end state with
    // fewer recompiles."
    const { page_id: pBefore, ids: idsBefore } = seedSharedPage(5);
    const { DELETE } = await import('../app/api/sources/[source_id]/route');
    await Promise.allSettled(
      idsBefore.map((id) =>
        DELETE(new Request(`http://localhost/api/sources/${id}`, { method: 'DELETE' }), {
          params: Promise.resolve({ source_id: id }),
        }),
      ),
    );

    // Capture before-end-state, then reset.
    const beforePages = handle.db.prepare('SELECT 1 FROM pages WHERE page_id = ?').get(pBefore);
    const beforeSources = (
      handle.db
        .prepare(`SELECT COUNT(*) AS n FROM sources WHERE source_id IN (${idsBefore.map(() => '?').join(',')})`)
        .get(...idsBefore) as { n: number }
    ).n;

    handle.cleanup();
    handle = setupTestDb();
    vi.mocked(recompilePage).mockClear();

    const { page_id: pAfter, ids: idsAfter } = seedSharedPage(5);
    await POST(postBulk(idsAfter));

    const afterPages = handle.db.prepare('SELECT 1 FROM pages WHERE page_id = ?').get(pAfter);
    const afterSources = (
      handle.db
        .prepare(`SELECT COUNT(*) AS n FROM sources WHERE source_id IN (${idsAfter.map(() => '?').join(',')})`)
        .get(...idsAfter) as { n: number }
    ).n;

    expect(afterPages).toEqual(beforePages); // both undefined (page gone)
    expect(afterSources).toBe(beforeSources); // both 0 (sources gone)
  });
});

describe('bulk-delete — page_deleted reason field', () => {
  it('canonical bulk-delete-all-shared → reason = all_remaining_in_batch', async () => {
    const page_id = seedPage(handle.db, { page_id: 'reason-bulk' });
    const ids = [];
    for (let i = 1; i <= 3; i++) {
      const sid = seedSource(handle.db, { source_id: `r${i}`, raw_markdown: LONG_MD });
      seedProvenance(handle.db, page_id, sid);
      ids.push(sid);
    }

    await POST(postBulk(ids));

    const row = handle.db
      .prepare(`SELECT details FROM activity_log WHERE action_type = 'page_deleted'`)
      .get() as { details: string };
    const d = JSON.parse(row.details) as {
      reason: string;
      remaining_sources: number;
      remaining_after_batch: number;
      siblings_in_batch: number;
    };
    expect(d.reason).toBe('all_remaining_in_batch');
    expect(d.remaining_sources).toBe(2); // siblings still live in provenance
    expect(d.remaining_after_batch).toBe(0);
    expect(d.siblings_in_batch).toBe(2);
  });

  it('single-source orphan delete → reason = no_remaining_sources', async () => {
    const page_id = seedPage(handle.db, { page_id: 'reason-solo' });
    const sid = seedSource(handle.db, { source_id: 'orphan', raw_markdown: LONG_MD });
    seedProvenance(handle.db, page_id, sid);

    const { deleteOneSourceWithCascade } = await import('../lib/source-delete');
    await deleteOneSourceWithCascade(sid);

    const row = handle.db
      .prepare(`SELECT details FROM activity_log WHERE action_type = 'page_deleted'`)
      .get() as { details: string };
    const d = JSON.parse(row.details) as { reason: string };
    expect(d.reason).toBe('no_remaining_sources');
  });

  it('2-source delete-one → reason = sole_remaining_source', async () => {
    const page_id = seedPage(handle.db, { page_id: 'reason-pair' });
    const a = seedSource(handle.db, { source_id: 'pair-a', raw_markdown: LONG_MD });
    const b = seedSource(handle.db, { source_id: 'pair-b', raw_markdown: LONG_MD });
    seedProvenance(handle.db, page_id, a);
    seedProvenance(handle.db, page_id, b);

    const { deleteOneSourceWithCascade } = await import('../lib/source-delete');
    await deleteOneSourceWithCascade(a);

    const row = handle.db
      .prepare(`SELECT details FROM activity_log WHERE action_type = 'page_deleted'`)
      .get() as { details: string };
    const d = JSON.parse(row.details) as { reason: string };
    expect(d.reason).toBe('sole_remaining_source');
  });
});
