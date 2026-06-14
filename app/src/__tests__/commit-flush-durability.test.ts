/**
 * Durability gate on Phase 3a flush failures (CLAUDE.md rule #5).
 *
 * Regression target: pre-fix, a /storage/write-page failure during commit was
 * logged and swallowed — `committed` still incremented and run/route.ts called
 * completeCompileProgress(), so the session read 'completed' while .md.gz
 * files were missing from disk.
 *
 * Covers:
 *   1. write-page down → commit responds flush_failures=1; the page row is
 *      committed in DB with pending_content still populated (outbox intact).
 *   2. Retry recovery: a second commit call (plans already 'committed' → the
 *      empty-plans path) with NLP healthy re-flushes via the reconcile pass,
 *      clears pending_content, and reports flush_failures=0.
 *   3. Control: healthy write-page → flush_failures=0, pending_content NULL.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as commitPOST } from '../app/api/compile/commit/route';
import {
  setupTestDb,
  seedSource,
  seedPage,
  seedPagePlan,
  seedCompileProgress,
  type TestDbHandle,
} from './helpers/test-db';

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

function mockNlpFetch(opts: { writePageOk: boolean; failForPageId?: string }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes('/storage/write-page')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { page_id?: string };
        const shouldFail =
          !opts.writePageOk ||
          (opts.failForPageId !== undefined && body.page_id === opts.failForPageId);
        if (shouldFail) {
          return new Response('{"detail":"disk full"}', { status: 500 });
        }
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
  failed: number;
  flush_failures: number;
}

function seedCommittablePlan(session_id: string): void {
  const source_id = seedSource(handle!.db, {
    onboarding_session_id: session_id,
    compile_status: 'in_progress',
  });
  seedCompileProgress(handle!.db, session_id);
  seedPagePlan(handle!.db, {
    plan_id: `plan-${session_id}`,
    session_id,
    page_type: 'entity',
    action: 'create',
    source_ids: [source_id],
    draft_status: 'crossreffed',
    draft_content: `---\ntitle: "Durable"\n---\n${'d'.repeat(900)}`,
  });
}

describe('commit durability gate (flush_failures)', () => {
  it('reports flush_failures when write-page is down; DB row stays in outbox', async () => {
    handle = setupTestDb();
    const session_id = 'sess-flush-fail';
    seedCommittablePlan(session_id);
    mockNlpFetch({ writePageOk: false });

    const res = await commitPOST(commitRequest(session_id));
    const body = (await res.json()) as CommitResp;

    // DB commit succeeded — the page row is durable in SQLite...
    expect(body.committed).toBe(1);
    expect(body.failed).toBe(0);
    // ...but the file never reached disk, even after the reconcile pass.
    expect(body.flush_failures).toBe(1);

    const page = handle.db
      .prepare('SELECT pending_content FROM pages LIMIT 1')
      .get() as { pending_content: string | null };
    expect(page.pending_content).not.toBeNull();
  });

  it('retry commit (empty-plans path) re-flushes stranded pages once NLP recovers', async () => {
    handle = setupTestDb();
    const session_id = 'sess-flush-retry';
    seedCommittablePlan(session_id);

    // First commit: write-page down → stranded pending_content.
    mockNlpFetch({ writePageOk: false });
    const res1 = await commitPOST(commitRequest(session_id));
    expect(((await res1.json()) as CommitResp).flush_failures).toBe(1);

    // Second commit: all plans 'committed' → early-return path. The
    // reconcile pass is the only thing that can recover the file.
    mockNlpFetch({ writePageOk: true });
    const res2 = await commitPOST(commitRequest(session_id));
    const body2 = (await res2.json()) as CommitResp;
    expect(body2.committed).toBe(0); // no crossreffed plans left
    expect(body2.flush_failures).toBe(0);

    const page = handle.db
      .prepare('SELECT pending_content FROM pages LIMIT 1')
      .get() as { pending_content: string | null };
    expect(page.pending_content).toBeNull();
  });

  it('session scoping: a stranded pending page from ANOTHER session never false-fails this one', async () => {
    handle = setupTestDb();
    const session_id = 'sess-flush-scoped';
    seedCommittablePlan(session_id);

    // Foreign stranded outbox row — e.g. a flush failure from a different
    // session or an approve/recompile path. Its write-page keeps failing.
    seedPage(handle.db, { page_id: 'foreign-stranded-page', title: 'Foreign' });
    handle.db
      .prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?')
      .run('# stranded elsewhere', 'foreign-stranded-page');

    mockNlpFetch({ writePageOk: true, failForPageId: 'foreign-stranded-page' });

    const res = await commitPOST(commitRequest(session_id));
    const body = (await res.json()) as CommitResp;

    // This session's own page flushed fine — the foreign failure must not
    // gate it (flush_failures is session-scoped), though the sweep DID
    // attempt the foreign page (and left its outbox row intact for its
    // own session/boot reconciler to recover).
    expect(body.committed).toBe(1);
    expect(body.flush_failures).toBe(0);

    const foreign = handle.db
      .prepare('SELECT pending_content FROM pages WHERE page_id = ?')
      .get('foreign-stranded-page') as { pending_content: string | null };
    expect(foreign.pending_content).not.toBeNull();
  });

  it('control: healthy write-page → flush_failures=0 and outbox cleared', async () => {
    handle = setupTestDb();
    const session_id = 'sess-flush-ok';
    seedCommittablePlan(session_id);
    mockNlpFetch({ writePageOk: true });

    const res = await commitPOST(commitRequest(session_id));
    const body = (await res.json()) as CommitResp;

    expect(body.committed).toBe(1);
    expect(body.flush_failures).toBe(0);

    const page = handle.db
      .prepare('SELECT pending_content FROM pages LIMIT 1')
      .get() as { pending_content: string | null };
    expect(page.pending_content).toBeNull();
  });
});
