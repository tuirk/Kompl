/**
 * auto_approve='0' OFF mode — compile/commit must queue every content plan as
 * pending_approval instead of writing pages, and the bulk approve-all endpoint
 * must commit them via the shared commitSinglePlan path.
 *
 * Covers:
 *   1. OFF: commit returns pending_approval=N, committed=0; no rows inserted in `pages`.
 *   2. OFF: provenance-only plans still auto-commit (no content to review).
 *   3. ON  (control): commit goes the normal path (committed=N).
 *   4. Bulk: /api/drafts/approve-all walks every pending plan and commits them.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as commitPOST } from '../app/api/compile/commit/route';
import { POST as approveAllPOST } from '../app/api/drafts/approve-all/route';
import {
  setupTestDb,
  seedSource,
  seedPage,
  seedPagePlan,
  seedCompileProgress,
  type TestDbHandle,
} from './helpers/test-db';
import { setSetting } from '../lib/db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

function commitRequest(session_id: string): Request {
  return new Request('http://test/api/compile/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id }),
  });
}

function approveAllRequest(body: object = {}): Request {
  return new Request('http://test/api/drafts/approve-all', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockNlpServiceFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/storage/write-page')) {
        return new Response(
          JSON.stringify({ current_path: '/data/pages/x.md.gz', previous_path: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (u.includes('/vectors/upsert')) return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch in test: ${u}`);
    })
  );
}

interface CommitResp {
  committed: number;
  pending_approval: number;
  thin_drafts_skipped: number;
  failed: number;
  auto_approve: boolean;
}

interface ApproveAllResp {
  approved: number;
  failed: number;
  total: number;
}

describe('auto_approve OFF mode (commit branch)', () => {
  it('queues every content plan as pending_approval and writes no pages', async () => {
    handle = setupTestDb();
    setSetting('auto_approve', '0');
    const session_id = 'sess-off-1';
    const source_id = seedSource(handle.db, {
      onboarding_session_id: session_id,
      compile_status: 'in_progress',
    });
    seedCompileProgress(handle.db, session_id);
    seedPagePlan(handle.db, {
      plan_id: 'plan-off-1',
      session_id,
      page_type: 'entity',
      action: 'create',
      source_ids: [source_id],
      draft_status: 'crossreffed',
      draft_content: `---\ntitle: "Big"\n---\n${'b'.repeat(900)}`,
    });

    const res = await commitPOST(commitRequest(session_id));
    const body = (await res.json()) as CommitResp;

    expect(body.auto_approve).toBe(false);
    expect(body.committed).toBe(0);
    expect(body.pending_approval).toBe(1);
    expect(body.thin_drafts_skipped).toBe(0);

    const plan = handle.db
      .prepare('SELECT draft_status FROM page_plans WHERE plan_id = ?')
      .get('plan-off-1') as { draft_status: string };
    expect(plan.draft_status).toBe('pending_approval');

    // No page rows should exist for the queued plan — approve route writes them later.
    const pageCount = (handle.db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n;
    expect(pageCount).toBe(0);
  });

  it('provenance-only plans still auto-commit even in OFF mode (no content to review)', async () => {
    handle = setupTestDb();
    setSetting('auto_approve', '0');
    const session_id = 'sess-off-prov';
    const source_id = seedSource(handle.db, {
      onboarding_session_id: session_id,
      compile_status: 'in_progress',
    });
    const existing_page_id = seedPage(handle.db, { page_id: 'page-existing', title: 'Existing' });
    seedCompileProgress(handle.db, session_id);
    seedPagePlan(handle.db, {
      plan_id: 'plan-prov',
      session_id,
      page_type: 'source-summary',
      action: 'provenance-only',
      source_ids: [source_id],
      existing_page_id,
      draft_status: 'crossreffed',
    });

    const res = await commitPOST(commitRequest(session_id));
    const body = (await res.json()) as CommitResp;

    expect(body.auto_approve).toBe(false);
    expect(body.committed).toBe(1); // provenance-only counted as committed
    expect(body.pending_approval).toBe(0);

    const plan = handle.db
      .prepare('SELECT draft_status FROM page_plans WHERE plan_id = ?')
      .get('plan-prov') as { draft_status: string };
    expect(plan.draft_status).toBe('committed');
  });
});

describe('auto_approve ON mode (control)', () => {
  it("default behaviour: writes pages and marks committed when setting is unset", async () => {
    handle = setupTestDb();
    mockNlpServiceFetch();
    // Do NOT set auto_approve — default getAutoApprove() returns true.
    const session_id = 'sess-on-1';
    const source_id = seedSource(handle.db, {
      onboarding_session_id: session_id,
      compile_status: 'in_progress',
    });
    seedCompileProgress(handle.db, session_id);
    seedPagePlan(handle.db, {
      plan_id: 'plan-on-1',
      session_id,
      page_type: 'entity',
      action: 'create',
      source_ids: [source_id],
      draft_status: 'crossreffed',
      draft_content: `---\ntitle: "Big"\n---\n${'b'.repeat(900)}`,
    });

    const res = await commitPOST(commitRequest(session_id));
    const body = (await res.json()) as CommitResp;

    expect(body.auto_approve).toBe(true);
    expect(body.committed).toBe(1);
    expect(body.pending_approval).toBe(0);
  });
});

describe('POST /api/drafts/approve-all', () => {
  it('walks every pending_approval plan and commits them via the shared helper', async () => {
    handle = setupTestDb();
    mockNlpServiceFetch();
    setSetting('auto_approve', '0');
    const session_id = 'sess-bulk';
    const sourceA = seedSource(handle.db, {
      onboarding_session_id: session_id,
      compile_status: 'in_progress',
    });
    const sourceB = seedSource(handle.db, {
      onboarding_session_id: session_id,
      compile_status: 'in_progress',
    });
    seedCompileProgress(handle.db, session_id, 2);
    seedPagePlan(handle.db, {
      plan_id: 'bulk-a',
      session_id,
      page_type: 'entity',
      action: 'create',
      source_ids: [sourceA],
      draft_status: 'crossreffed',
      draft_content: `---\ntitle: "Alpha"\n---\n${'a'.repeat(900)}`,
    });
    seedPagePlan(handle.db, {
      plan_id: 'bulk-b',
      session_id,
      page_type: 'entity',
      action: 'create',
      source_ids: [sourceB],
      draft_status: 'crossreffed',
      draft_content: `---\ntitle: "Beta"\n---\n${'b'.repeat(900)}`,
    });

    // Compile in OFF mode → both plans queued.
    await commitPOST(commitRequest(session_id));

    const pendingBefore = (handle.db
      .prepare("SELECT COUNT(*) AS n FROM page_plans WHERE draft_status = 'pending_approval'")
      .get() as { n: number }).n;
    expect(pendingBefore).toBe(2);

    // Bulk approve.
    const res = await approveAllPOST(approveAllRequest({ session_id }));
    const body = (await res.json()) as ApproveAllResp;
    expect(body.approved).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.total).toBe(2);

    // Plans should now be committed.
    const pendingAfter = (handle.db
      .prepare("SELECT COUNT(*) AS n FROM page_plans WHERE draft_status = 'pending_approval'")
      .get() as { n: number }).n;
    expect(pendingAfter).toBe(0);
    const committed = (handle.db
      .prepare("SELECT COUNT(*) AS n FROM page_plans WHERE draft_status = 'committed'")
      .get() as { n: number }).n;
    expect(committed).toBe(2);

    // Pages must exist now (approve runs Phase 2 from scratch).
    const pageCount = (handle.db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n;
    expect(pageCount).toBe(2);
  });
});
