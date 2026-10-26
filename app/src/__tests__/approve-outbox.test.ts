/**
 * Approving a draft: Phase 3a of the outbox commit (CLAUDE.md rule 5).
 *
 * After the file write, approval cleared pending_content whatever it then
 * held. Another writer on the same page (a compile commit, a restore, a
 * second approval) can replace pending_content while the write is in
 * flight; clearing it anyway dropped that newer text from the outbox while
 * the file held the older one. Approval now clears the outbox only while it
 * still holds the text written, the way compile commit does
 * (lib/outbox-flush.ts).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { commitSinglePlan } from '../lib/approve-plan';
import { POST as approvePOST } from '../app/api/drafts/[plan_id]/approve/route';
import { POST as approveAllPOST } from '../app/api/drafts/approve-all/route';
import { setupTestDb, seedSource, seedPagePlan, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

const DRAFT = `---\ntitle: "Contrast"\ncategory: "Standards"\n---\n${'Draft text. '.repeat(60)}`;

/**
 * Stubs nlp-service. `onWrite` runs while a write-page request is in flight,
 * standing in for another writer acting meanwhile. Returns the bodies
 * write-page received.
 */
function stubNlp(onWrite?: (page_id: string) => void) {
  const writes: Array<{ page_id: string; markdown: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes('/storage/write-page')) {
        const body = JSON.parse(String(init?.body)) as { page_id: string; markdown: string };
        writes.push(body);
        onWrite?.(body.page_id);
        return Response.json({
          current_path: `/data/pages/${body.page_id}.md.gz`,
          previous_path: `/data/pages/${body.page_id}.20261024T000000.md.gz`,
        });
      }
      if (u.includes('/vectors/upsert')) return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch in test: ${u}`);
    }),
  );
  return writes;
}

function pendingDraft(session_id = 'sess-approve', title = 'Contrast'): string {
  return seedPagePlan(handle!.db, {
    session_id,
    title,
    page_type: 'concept',
    action: 'create',
    source_ids: [seedSource(handle!.db, { compile_status: 'active' })],
    draft_status: 'pending_approval',
    draft_content: DRAFT,
  });
}

function outbox(page_id: string) {
  return handle!.db
    .prepare('SELECT pending_content, previous_content_path FROM pages WHERE page_id = ?')
    .get(page_id) as { pending_content: string | null; previous_content_path: string | null };
}

describe('approve: outbox flush clears pending_content compare-and-set', () => {
  it('writes the draft to disk and clears the outbox', async () => {
    handle = setupTestDb();
    const writes = stubNlp();
    const plan_id = pendingDraft();

    const result = await commitSinglePlan(plan_id);
    expect(result.ok).toBe(true);
    const page_id = result.ok ? result.page_id : '';
    expect(writes).toEqual([{ page_id, markdown: DRAFT }]);
    expect(outbox(page_id)).toEqual({
      pending_content: null,
      previous_content_path: `/data/pages/${page_id}.20261024T000000.md.gz`,
    });
  });

  it('text another writer queues during the write stays in the outbox', async () => {
    handle = setupTestDb();
    const db = handle.db;
    stubNlp((page_id) => {
      db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run('newer text', page_id);
    });
    const plan_id = pendingDraft();

    const result = await commitSinglePlan(plan_id);
    expect(result.ok).toBe(true);
    // The write put the draft on disk; the newer text must stay queued for
    // its own writer, the next reconcile pass or the boot reconciler.
    expect(outbox(result.ok ? result.page_id : '').pending_content).toBe('newer text');
  });

  it('single approve route keeps newer text queued', async () => {
    handle = setupTestDb();
    const db = handle.db;
    stubNlp((page_id) => {
      db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run('newer text', page_id);
    });
    const plan_id = pendingDraft();

    const res = await approvePOST(new Request(`http://test/api/drafts/${plan_id}/approve`, { method: 'POST' }), {
      params: Promise.resolve({ plan_id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { page_id: string };
    expect(outbox(body.page_id).pending_content).toBe('newer text');
  });

  it('approve-all keeps newer text queued and still clears the pages left alone', async () => {
    handle = setupTestDb();
    const db = handle.db;
    pendingDraft('sess-all', 'Busy');
    pendingDraft('sess-all', 'Quiet');
    const busyPrefix = 'busy-';
    stubNlp((page_id) => {
      if (page_id.startsWith(busyPrefix)) {
        db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run('newer text', page_id);
      }
    });

    const res = await approveAllPOST(
      new Request('http://test/api/drafts/approve-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'sess-all' }),
      }),
    );
    expect(((await res.json()) as { approved: number }).approved).toBe(2);
    const rows = db
      .prepare(`SELECT page_id, pending_content FROM pages ORDER BY page_id`)
      .all() as Array<{ page_id: string; pending_content: string | null }>;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.page_id.startsWith(busyPrefix))?.pending_content).toBe('newer text');
    expect(rows.find((r) => r.page_id.startsWith('quiet-'))?.pending_content).toBeNull();
  });

  it('a failed write leaves the draft text in the outbox for the reconciler', async () => {
    handle = setupTestDb();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = url.toString();
        if (u.includes('/storage/write-page')) return new Response('boom', { status: 500 });
        if (u.includes('/vectors/upsert')) return new Response('{}', { status: 200 });
        throw new Error(`unexpected fetch in test: ${u}`);
      }),
    );
    const plan_id = pendingDraft();

    const result = await commitSinglePlan(plan_id);
    expect(result.ok).toBe(true);
    expect(outbox(result.ok ? result.page_id : '').pending_content).toBe(DRAFT);
  });
});
