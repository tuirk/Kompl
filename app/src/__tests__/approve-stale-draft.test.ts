/**
 * Approving a draft (auto-approve off) checks that the page has not changed
 * since the draft was written (plan 1.8, audit 3 B10).
 *
 * An update draft records the page's version when it read the page
 * (page_plans.base_version); approving it after another compile, approval
 * or restore rewrote the page would overwrite that newer text. A new-page
 * draft is refused when a page for the same thing appeared meanwhile, or
 * approving it would make a duplicate. A refused draft stays pending,
 * unchanged, and nothing is written.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { commitSinglePlan } from '../lib/approve-plan';
import { pageTextVersionToken } from '../lib/page-rewrite';
import { POST as approvePOST } from '../app/api/drafts/[plan_id]/approve/route';
import { POST as approveAllPOST } from '../app/api/drafts/approve-all/route';
import {
  setupTestDb,
  seedSource,
  seedPage,
  seedPagePlan,
  seedProvenance,
  getActivityCounts,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle | null = null;
let writes = 0;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

function mockNlp(): void {
  writes = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/storage/write-page')) {
        writes++;
        return Response.json({ current_path: '/data/pages/x.md.gz', previous_path: null });
      }
      if (u.includes('/vectors/upsert')) return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch in test: ${u}`);
    }),
  );
}

const DRAFT = `---\ntitle: "APCA"\ncategory: "Standards"\n---\n${'New text. '.repeat(60)}`;

/** An entity page with one source and a pending update draft that read it. */
function pendingUpdate(opts: { baseVersion?: 'now' | null } = {}) {
  const { db } = handle!;
  const page_id = seedPage(db, { page_id: 'apca', title: 'APCA', page_type: 'entity' });
  const oldSource = seedSource(db, { compile_status: 'active' });
  seedProvenance(db, page_id, oldSource);
  const newSource = seedSource(db, { compile_status: 'active' });
  const plan_id = seedPagePlan(db, {
    session_id: 'sess-a',
    title: 'APCA',
    page_type: 'entity',
    action: 'update',
    source_ids: [oldSource, newSource],
    existing_page_id: page_id,
    draft_status: 'pending_approval',
    draft_content: DRAFT,
    base_version: opts.baseVersion === null ? null : pageTextVersionToken(page_id),
  });
  return { page_id, plan_id, newSource };
}

function planRow(plan_id: string) {
  return handle!.db
    .prepare('SELECT draft_status, draft_content FROM page_plans WHERE plan_id = ?')
    .get(plan_id) as { draft_status: string; draft_content: string };
}

function provenanceCount(page_id: string): number {
  return (handle!.db.prepare('SELECT COUNT(*) AS n FROM provenance WHERE page_id = ?').get(page_id) as { n: number }).n;
}

describe('approve: update drafts', () => {
  it('commits when the page is as the draft read it', async () => {
    handle = setupTestDb();
    mockNlp();
    const { page_id, plan_id } = pendingUpdate();

    const result = await commitSinglePlan(plan_id);
    expect(result).toMatchObject({ ok: true, page_id });
    expect(planRow(plan_id).draft_status).toBe('committed');
    expect(writes).toBe(1);
  });

  it('refuses when the page was rewritten after the draft, and changes nothing', async () => {
    handle = setupTestDb();
    mockNlp();
    const { page_id, plan_id } = pendingUpdate();
    handle.db.prepare("UPDATE pages SET last_updated = datetime('now', '+1 minute') WHERE page_id = ?").run(page_id);
    const before = provenanceCount(page_id);

    const result = await commitSinglePlan(plan_id);
    expect(result).toMatchObject({ ok: false, error: 'page_changed', status: 409 });
    expect(result.ok === false && result.message).toMatch(/changed after the draft/);
    expect(planRow(plan_id)).toEqual({ draft_status: 'pending_approval', draft_content: DRAFT });
    expect(provenanceCount(page_id)).toBe(before);
    expect(getActivityCounts(handle.db).draft_approved ?? 0).toBe(0);
    expect(writes).toBe(0);
  });

  it('refuses when another draft for the page was committed after this one', async () => {
    handle = setupTestDb();
    mockNlp();
    const { page_id, plan_id } = pendingUpdate();
    seedProvenance(handle.db, page_id, seedSource(handle.db, { compile_status: 'active' }), 'updated');

    const result = await commitSinglePlan(plan_id);
    expect(result).toMatchObject({ ok: false, error: 'page_changed' });
  });

  it('a source linked to the page without rewriting it does not block the draft', async () => {
    handle = setupTestDb();
    mockNlp();
    const { page_id, plan_id } = pendingUpdate();
    seedProvenance(handle.db, page_id, seedSource(handle.db, { compile_status: 'active' }), 'mentioned');

    expect(await commitSinglePlan(plan_id)).toMatchObject({ ok: true });
  });

  it('the page file being written out after the draft does not block it', async () => {
    handle = setupTestDb();
    mockNlp();
    const { db } = handle;
    db.prepare("INSERT INTO pages (page_id, title, page_type, content_path, pending_content) VALUES ('apca', 'APCA', 'entity', '/data/pages/apca.md.gz', 'waiting')").run();
    const plan_id = seedPagePlan(db, {
      session_id: 'sess-a',
      title: 'APCA',
      action: 'update',
      source_ids: [seedSource(db, { compile_status: 'active' })],
      existing_page_id: 'apca',
      draft_status: 'pending_approval',
      draft_content: DRAFT,
      base_version: pageTextVersionToken('apca'),
    });
    db.prepare("UPDATE pages SET pending_content = NULL WHERE page_id = 'apca'").run(); // the boot reconciler flushed it

    expect(await commitSinglePlan(plan_id)).toMatchObject({ ok: true });
  });

  it('a draft made before v30 is checked against when the plan was made', async () => {
    handle = setupTestDb();
    mockNlp();
    const { page_id, plan_id } = pendingUpdate({ baseVersion: null });
    handle.db.prepare("UPDATE pages SET last_updated = '2026-01-01 00:00:00' WHERE page_id = ?").run(page_id);
    handle.db.prepare("UPDATE page_plans SET created_at = '2026-02-01 00:00:00' WHERE plan_id = ?").run(plan_id);
    expect(await commitSinglePlan(plan_id)).toMatchObject({ ok: true });

    const later = pendingUpdate2(page_id);
    handle.db.prepare("UPDATE page_plans SET created_at = '2026-01-01 00:00:00' WHERE plan_id = ?").run(later);
    expect(await commitSinglePlan(later)).toMatchObject({ ok: false, error: 'page_changed' });
  });
});

/** A second pre-v30 pending update of the same page. */
function pendingUpdate2(page_id: string): string {
  return seedPagePlan(handle!.db, {
    session_id: 'sess-b',
    title: 'APCA',
    action: 'update',
    source_ids: [seedSource(handle!.db, { compile_status: 'active' })],
    existing_page_id: page_id,
    draft_status: 'pending_approval',
    draft_content: DRAFT,
  });
}

describe('approve: new-page drafts', () => {
  it('refuses a new page when a page for it appeared after the draft', async () => {
    handle = setupTestDb();
    mockNlp();
    const plan_id = seedPagePlan(handle.db, {
      session_id: 'sess-b',
      title: 'apca',
      page_type: 'concept',
      action: 'create',
      source_ids: [seedSource(handle.db, { compile_status: 'active' })],
      draft_status: 'pending_approval',
      draft_content: DRAFT,
    });
    seedPage(handle.db, { page_id: 'apca', title: 'APCA', page_type: 'entity' });

    const result = await commitSinglePlan(plan_id);
    expect(result).toMatchObject({ ok: false, error: 'page_exists', status: 409 });
    expect(result.ok === false && result.message).toMatch(/duplicate/);
    expect((handle.db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n).toBe(1);
    expect(planRow(plan_id).draft_status).toBe('pending_approval');
  });

  it("refuses a source's page when the source got its page after the draft", async () => {
    handle = setupTestDb();
    mockNlp();
    const sid = seedSource(handle.db, { title: 'An article', compile_status: 'active' });
    const plan_id = seedPagePlan(handle.db, {
      session_id: 'sess-b',
      title: 'An article',
      page_type: 'source-summary',
      action: 'create',
      source_ids: [sid],
      draft_status: 'pending_approval',
      draft_content: DRAFT,
    });
    const own = seedPage(handle.db, { page_id: 'article', title: 'An article (2)', page_type: 'source-summary' });
    seedProvenance(handle.db, own, sid);

    expect(await commitSinglePlan(plan_id)).toMatchObject({ ok: false, error: 'page_exists' });
  });

  it('a source page with the same title as a new entity page does not block it', async () => {
    handle = setupTestDb();
    mockNlp();
    seedPage(handle.db, { page_id: 'eth-article', title: 'Ethereum', page_type: 'source-summary' });
    const plan_id = seedPagePlan(handle.db, {
      session_id: 'sess-b',
      title: 'Ethereum',
      page_type: 'entity',
      action: 'create',
      source_ids: [seedSource(handle.db, { compile_status: 'active' })],
      draft_status: 'pending_approval',
      draft_content: DRAFT,
    });

    expect(await commitSinglePlan(plan_id)).toMatchObject({ ok: true });
  });
});

describe('approve routes pass the refusal on', () => {
  it('single approve answers 409 with the message', async () => {
    handle = setupTestDb();
    mockNlp();
    const { page_id, plan_id } = pendingUpdate();
    handle.db.prepare("UPDATE pages SET last_updated = datetime('now', '+1 minute') WHERE page_id = ?").run(page_id);

    const res = await approvePOST(new Request(`http://test/api/drafts/${plan_id}/approve`, { method: 'POST' }), {
      params: Promise.resolve({ plan_id }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('page_changed');
    expect(body.message).toMatch(/changed after the draft/);
  });

  it('approve-all applies the rest and lists the refused draft with its message', async () => {
    handle = setupTestDb();
    mockNlp();
    const { page_id, plan_id } = pendingUpdate();
    handle.db.prepare("UPDATE pages SET last_updated = datetime('now', '+1 minute') WHERE page_id = ?").run(page_id);
    seedPagePlan(handle.db, {
      session_id: 'sess-a',
      title: 'Fresh',
      action: 'create',
      source_ids: [seedSource(handle.db, { compile_status: 'active' })],
      draft_status: 'pending_approval',
      draft_content: DRAFT,
    });

    const res = await approveAllPOST(
      new Request('http://test/api/drafts/approve-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'sess-a' }),
      }),
    );
    const body = (await res.json()) as { approved: number; failed: number; errors: Array<{ plan_id: string; error: string; message?: string }> };
    expect(body.approved).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.errors[0]).toMatchObject({ plan_id, error: 'page_changed' });
    expect(body.errors[0].message).toMatch(/changed after the draft/);
  });
});
