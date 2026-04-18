/**
 * Zombie wiki pages — regression coverage for the delete-cascade gap that left
 * pending_approval plans orphaned, then later resurrected the deleted pages
 * when those plans were approved (commitSinglePlan UPSERTs on a deterministic
 * page_id derived from title + plan_id).
 *
 * Coverage:
 *   1. deletePage drops orphaned pending_approval plans tied to it (Fix #1).
 *   2. Source delete strips deleted source_id from multi-source pending plans (Fix #2 UPDATE).
 *   3. Source delete drops single-source pending plans (Fix #2 DELETE branch).
 *   4. Source delete leaves chat-save-draft plans alone (page_ids in source_ids).
 *   5. End-to-end: leave plan → delete source → approve-all → no zombie page.
 *   6. findZombiePages identifies pages whose backing sources are gone.
 *   7. saved-links system page is exempt from zombie cleanup.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  seedSource,
  seedPage,
  seedPagePlan,
  seedCompileProgress,
  type TestDbHandle,
} from './helpers/test-db';
import {
  deletePage,
  cleanupPendingPlansForDeletedSource,
  cleanupChatDraftsForDeletedPage,
  findZombiePages,
  insertProvenance,
  removeProvenanceForSource,
  deleteSource,
  setSetting,
} from '../lib/db';
import { POST as approveAllPOST } from '../app/api/drafts/approve-all/route';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

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
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/storage/write-page')) {
        return new Response(JSON.stringify({ current_path: '/data/pages/x.md.gz', previous_path: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    }),
  );
}

describe('deletePage — orphan plan cascade', () => {
  it('drops pending_approval plans whose existing_page_id targets the deleted page', () => {
    handle = setupTestDb();
    const page_id = seedPage(handle.db, { title: 'Doomed Page' });
    const plan_id = seedPagePlan(handle.db, {
      session_id: 'sess-old',
      existing_page_id: page_id,
      action: 'update',
      draft_status: 'pending_approval',
      draft_content: '---\nfrontmatter: yes\n---\nstale body',
    });

    deletePage(page_id);

    const remaining = handle.db
      .prepare('SELECT plan_id FROM page_plans WHERE plan_id = ?')
      .get(plan_id);
    expect(remaining).toBeUndefined();
  });

  it('leaves committed plans intact (audit trail)', () => {
    handle = setupTestDb();
    const page_id = seedPage(handle.db);
    const plan_id = seedPagePlan(handle.db, {
      session_id: 'sess-old',
      existing_page_id: page_id,
      draft_status: 'committed',
    });

    deletePage(page_id);

    const row = handle.db
      .prepare('SELECT plan_id FROM page_plans WHERE plan_id = ?')
      .get(plan_id);
    expect(row).toBeDefined();
  });
});

describe('cleanupChatDraftsForDeletedPage — chat-draft cascade on page delete', () => {
  it('strips deleted page_id from a multi-cite chat draft instead of dropping it', () => {
    handle = setupTestDb();
    const cited_a = seedPage(handle.db, { title: 'Cited A' });
    const cited_b = seedPage(handle.db, { title: 'Cited B' });
    const cited_c = seedPage(handle.db, { title: 'Cited C' });
    const chat_plan = seedPagePlan(handle.db, {
      session_id: 'chat-manual-sess-1',
      page_type: 'query-generated',
      source_ids: [cited_a, cited_b, cited_c],
      draft_status: 'pending_approval',
      draft_content: '---\n---\nchat draft body',
    });

    const result = cleanupChatDraftsForDeletedPage(cited_b);

    expect(result.rewritten).toBe(1);
    expect(result.deleted).toBe(0);
    const row = handle.db
      .prepare('SELECT source_ids FROM page_plans WHERE plan_id = ?')
      .get(chat_plan) as { source_ids: string };
    const ids = JSON.parse(row.source_ids) as string[];
    expect(ids.sort()).toEqual([cited_a, cited_c].sort());
  });

  it('drops a single-cite chat draft when its only cited page is deleted', () => {
    handle = setupTestDb();
    const cited = seedPage(handle.db, { title: 'Sole Cite' });
    const chat_plan = seedPagePlan(handle.db, {
      session_id: 'chat-manual-sess-2',
      source_ids: [cited],
      draft_status: 'pending_approval',
      draft_content: '---\n---\nchat draft body',
    });

    const result = cleanupChatDraftsForDeletedPage(cited);

    expect(result.rewritten).toBe(1);
    expect(result.deleted).toBe(1);
    const row = handle.db.prepare('SELECT plan_id FROM page_plans WHERE plan_id = ?').get(chat_plan);
    expect(row).toBeUndefined();
  });

  it('leaves compile-stage drafts alone (session_id without chat- prefix)', () => {
    handle = setupTestDb();
    const compile_source = seedSource(handle.db);
    const compile_plan = seedPagePlan(handle.db, {
      session_id: 'sess-compile',
      source_ids: [compile_source],
      draft_status: 'pending_approval',
    });

    cleanupChatDraftsForDeletedPage(compile_source);

    const row = handle.db.prepare('SELECT plan_id FROM page_plans WHERE plan_id = ?').get(compile_plan);
    expect(row).toBeDefined();
  });

  it('runs as part of deletePage transaction — return value reflects cleanup counts', () => {
    handle = setupTestDb();
    const target_page = seedPage(handle.db, { title: 'Will Be Deleted' });
    const survivor_page = seedPage(handle.db, { title: 'Other Cited Page' });

    const single_cite_plan = seedPagePlan(handle.db, {
      session_id: 'chat-manual-x',
      source_ids: [target_page],
      draft_status: 'pending_approval',
    });
    const multi_cite_plan = seedPagePlan(handle.db, {
      session_id: 'chat-y',
      source_ids: [target_page, survivor_page],
      draft_status: 'pending_approval',
    });

    const result = deletePage(target_page);

    expect(result.chatDraftsRewritten).toBe(2);
    expect(result.chatDraftsDeleted).toBe(1);
    expect(handle.db.prepare('SELECT plan_id FROM page_plans WHERE plan_id = ?').get(single_cite_plan)).toBeUndefined();
    const multiRow = handle.db
      .prepare('SELECT source_ids FROM page_plans WHERE plan_id = ?')
      .get(multi_cite_plan) as { source_ids: string };
    expect(JSON.parse(multiRow.source_ids)).toEqual([survivor_page]);
  });
});

describe('cleanupPendingPlansForDeletedSource', () => {
  it('strips the deleted source from a multi-source pending plan instead of dropping it', () => {
    handle = setupTestDb();
    const sourceA = seedSource(handle.db);
    const sourceB = seedSource(handle.db);
    const sourceC = seedSource(handle.db);
    const plan_id = seedPagePlan(handle.db, {
      session_id: 'sess-multi',
      source_ids: [sourceA, sourceB, sourceC],
      draft_status: 'pending_approval',
      draft_content: '---\n---\nbody',
    });

    const result = cleanupPendingPlansForDeletedSource(sourceB);

    expect(result.rewritten).toBe(1);
    expect(result.deleted).toBe(0);
    const row = handle.db
      .prepare('SELECT source_ids FROM page_plans WHERE plan_id = ?')
      .get(plan_id) as { source_ids: string };
    const ids = JSON.parse(row.source_ids) as string[];
    expect(ids.sort()).toEqual([sourceA, sourceC].sort());
  });

  it('drops a single-source pending plan when its only source is deleted', () => {
    handle = setupTestDb();
    const sourceA = seedSource(handle.db);
    const plan_id = seedPagePlan(handle.db, {
      session_id: 'sess-single',
      source_ids: [sourceA],
      draft_status: 'pending_approval',
      draft_content: '---\n---\nbody',
    });

    const result = cleanupPendingPlansForDeletedSource(sourceA);

    expect(result.rewritten).toBe(1);
    expect(result.deleted).toBe(1);
    const row = handle.db.prepare('SELECT plan_id FROM page_plans WHERE plan_id = ?').get(plan_id);
    expect(row).toBeUndefined();
  });

  it('leaves chat-save-draft plans alone (their source_ids column holds page_ids, not source_ids)', () => {
    handle = setupTestDb();
    const sourceA = seedSource(handle.db);
    const cited_page_id = seedPage(handle.db, { title: 'Cited Page' });
    const chat_plan_id = seedPagePlan(handle.db, {
      plan_id: 'chat-manual-abc-123',
      session_id: 'chat-manual-sess-1',
      source_ids: [cited_page_id],
      draft_status: 'pending_approval',
      draft_content: '---\n---\nchat draft body',
    });

    cleanupPendingPlansForDeletedSource(sourceA);

    const row = handle.db.prepare('SELECT plan_id FROM page_plans WHERE plan_id = ?').get(chat_plan_id);
    expect(row).toBeDefined();
  });

  it('leaves committed plans alone', () => {
    handle = setupTestDb();
    const sourceA = seedSource(handle.db);
    const plan_id = seedPagePlan(handle.db, {
      session_id: 'sess-committed',
      source_ids: [sourceA],
      draft_status: 'committed',
    });

    const result = cleanupPendingPlansForDeletedSource(sourceA);

    expect(result.rewritten).toBe(0);
    expect(result.deleted).toBe(0);
    const row = handle.db.prepare('SELECT plan_id FROM page_plans WHERE plan_id = ?').get(plan_id);
    expect(row).toBeDefined();
  });
});

describe('end-to-end: source delete + approve-all cannot resurrect a zombie', () => {
  it('approve-all after source-delete cleanup commits 0 plans (no zombie page created)', async () => {
    handle = setupTestDb();
    mockNlpServiceFetch();
    setSetting('auto_approve', '0');

    // Old compile session: pending_approval plan tied to a source we will delete.
    const old_source = seedSource(handle.db);
    const old_session = 'sess-old';
    seedCompileProgress(handle.db, old_session);
    seedPagePlan(handle.db, {
      session_id: old_session,
      title: 'Zombie Candidate',
      source_ids: [old_source],
      draft_status: 'pending_approval',
      draft_content: '---\ncategory: Test\nsummary: stale\n---\nstale body content',
    });

    // Source deletion path runs the cleanup helper.
    cleanupPendingPlansForDeletedSource(old_source);

    // Bulk approve sweeps every remaining pending_approval plan — should find none.
    const res = await approveAllPOST(approveAllRequest({}));
    const body = (await res.json()) as { approved: number; total: number };
    expect(body.approved).toBe(0);
    expect(body.total).toBe(0);

    const pageCount = handle.db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number };
    expect(pageCount.n).toBe(0);
  });
});

describe('findZombiePages', () => {
  it('returns pages whose backing sources have all been deleted from the sources table', () => {
    handle = setupTestDb();

    // Live page — source is still present.
    const sourceA = seedSource(handle.db);
    const live_page = seedPage(handle.db, { title: 'Live Page' });
    insertProvenance({
      source_id: sourceA,
      page_id: live_page,
      content_hash: 'sha256-live',
      contribution_type: 'created',
    });

    // Zombie path — page survived after its only source was deleted via the
    // normal cascade order (provenance first, then source row).
    const sourceB = seedSource(handle.db);
    const zombie_page = seedPage(handle.db, { title: 'Zombie Page' });
    insertProvenance({
      source_id: sourceB,
      page_id: zombie_page,
      content_hash: 'sha256-zombie',
      contribution_type: 'created',
    });
    removeProvenanceForSource(sourceB);
    deleteSource(sourceB);

    // Orphan — page was created without any provenance ever attached.
    const orphan_page = seedPage(handle.db, { title: 'Orphan Page' });

    const zombies = findZombiePages();
    const ids = zombies.map((z) => z.page_id).sort();
    expect(ids).toEqual([orphan_page, zombie_page].sort());
  });

  it('exempts the saved-links system page even with no provenance', () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'saved-links', title: 'Saved Links' });

    const zombies = findZombiePages();
    expect(zombies.find((z) => z.page_id === 'saved-links')).toBeUndefined();
  });
});
