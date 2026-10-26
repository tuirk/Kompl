/**
 * POST /api/compile/commit — the "skip pages changed since" guard on every
 * compile save (owner decision 2026-10-25, PRD #140 OQ-4).
 *
 * Regression target: a compile's update draft read a page, then something
 * else (Repair wiki, Update pages, an approval, a restore) rewrote it before
 * commit; commit overwrote that change. Now the page keeps its text and the
 * feed says why. A draft whose page did not change, or a new page, saves as
 * before.
 *
 * The update is not dropped: its plan is marked failed, so the session
 * offers Retry, which writes the update again on the page as it is now.
 * Before, the plan was left 'page_changed' and the new source's update was
 * lost while the source counted as compiled.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { POST as commitPOST } from '../app/api/compile/commit/route';
import { commitSinglePlan } from '../lib/approve-plan';
import { countFailedDraftPlansBySession } from '../lib/db';
import { pageTextVersionToken } from '../lib/page-rewrite';
import { getActivityCounts, seedCompileProgress, seedPage, seedPagePlan, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

const BODY = `---\ntitle: "Page"\n---\n${'Body text about the subject. '.repeat(40)}`;

function stubNlp(): string[] {
  const writes: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes('/storage/write-page')) {
        writes.push((JSON.parse(String(init?.body)) as { page_id: string }).page_id);
        return new Response(JSON.stringify({ current_path: '/x', previous_path: null }), { status: 200 });
      }
      if (u.includes('/vectors/upsert')) return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch in test: ${u}`);
    }),
  );
  return writes;
}

async function commit(session_id: string): Promise<{ committed: number; changed_pages_skipped: number }> {
  const res = await commitPOST(
    new Request('http://test/api/compile/commit', { method: 'POST', body: JSON.stringify({ session_id }) }),
  );
  return res.json() as Promise<{ committed: number; changed_pages_skipped: number }>;
}

describe('commit staleness guard', () => {
  it('skips an update whose page changed after the draft read it', async () => {
    handle = setupTestDb();
    const db = handle.db;
    seedCompileProgress(db, 's1');
    const src = seedSource(db, { onboarding_session_id: 's1', compile_status: 'extracted' });
    const page = seedPage(db, { title: 'Topic' });
    const base = pageTextVersionToken(page);
    db.prepare(`UPDATE pages SET last_updated = datetime('now', '+1 minutes') WHERE page_id = ?`).run(page);
    const plan = seedPagePlan(db, {
      session_id: 's1', title: 'Topic', action: 'update', source_ids: [src], existing_page_id: page,
      draft_content: BODY, draft_status: 'crossreffed', base_version: base,
    });
    const writes = stubNlp();
    const r = await commit('s1');
    expect(r).toMatchObject({ committed: 0, changed_pages_skipped: 1 });
    expect(writes).toEqual([]);
    expect(db.prepare('SELECT draft_status, draft_error FROM page_plans WHERE plan_id = ?').get(plan)).toEqual({
      draft_status: 'failed',
      draft_error: expect.stringMatching(/Retry writes the update again on the page as it is now/),
    });
    // The progress page offers "Retry 1 failed", which drafts it again.
    expect(countFailedDraftPlansBySession('s1')).toBe(1);
    expect(getActivityCounts(db).compile_page_skipped).toBe(1);
  });

  it('leaves a create rewriting its own page alone when that page changed', async () => {
    handle = setupTestDb();
    const db = handle.db;
    seedCompileProgress(db, 's1');
    const src = seedSource(db, { onboarding_session_id: 's1', compile_status: 'extracted' });
    const own = seedPage(db, { title: 'Own' });
    const base = pageTextVersionToken(own);
    db.prepare(`UPDATE pages SET last_updated = datetime('now', '+1 minutes') WHERE page_id = ?`).run(own);
    const plan = seedPagePlan(db, {
      session_id: 's1', title: 'Own', action: 'create', source_ids: [src], existing_page_id: own,
      draft_content: BODY, draft_status: 'crossreffed', base_version: base,
    });
    stubNlp();
    expect(await commit('s1')).toMatchObject({ committed: 0, changed_pages_skipped: 1 });
    expect((db.prepare('SELECT draft_status FROM page_plans WHERE plan_id = ?').get(plan) as { draft_status: string }).draft_status).toBe('page_changed');
    expect(countFailedDraftPlansBySession('s1')).toBe(0);
  });

  it('saves an unchanged update and a create rewriting its own page in place', async () => {
    handle = setupTestDb();
    const db = handle.db;
    seedCompileProgress(db, 's1');
    const src = seedSource(db, { onboarding_session_id: 's1', compile_status: 'extracted' });
    const page = seedPage(db, { title: 'Topic' });
    const own = seedPage(db, { title: 'Own' });
    seedPagePlan(db, {
      session_id: 's1', title: 'Topic', action: 'update', source_ids: [src], existing_page_id: page,
      draft_content: BODY, draft_status: 'crossreffed', base_version: pageTextVersionToken(page),
    });
    seedPagePlan(db, {
      session_id: 's1', title: 'Own', action: 'create', source_ids: [src], existing_page_id: own,
      draft_content: BODY, draft_status: 'crossreffed', base_version: pageTextVersionToken(own),
    });
    const writes = stubNlp();
    const r = await commit('s1');
    expect(r).toMatchObject({ committed: 2, changed_pages_skipped: 0 });
    expect(writes.sort()).toEqual([own, page].sort());
    expect((db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n).toBe(2);
  });

  it('approval of a rewrite of its own page saves in place, and refuses once the page changed', async () => {
    handle = setupTestDb();
    const db = handle.db;
    const src = seedSource(db, { compile_status: 'active' });
    const own = seedPage(db, { title: 'Own' });
    const plan = (title: string, page: string) =>
      seedPagePlan(db, {
        session_id: 's1', title, action: 'create', source_ids: [src], existing_page_id: page,
        draft_content: BODY, draft_status: 'pending_approval', base_version: pageTextVersionToken(page),
      });
    const first = plan('Own', own);
    stubNlp();
    expect(await commitSinglePlan(first)).toMatchObject({ ok: true, page_id: own });

    const other = seedPage(db, { title: 'Other' });
    const second = plan('Other', other);
    db.prepare(`UPDATE pages SET last_updated = datetime('now', '+1 minutes') WHERE page_id = ?`).run(other);
    expect(await commitSinglePlan(second)).toMatchObject({ ok: false, status: 409 });
  });
});
