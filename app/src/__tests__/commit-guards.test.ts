/**
 * POST /api/compile/commit — guards around the outbox commit (CLAUDE.md rule 5).
 *
 * Regression targets:
 *   - A source deleted while the session compiled left its id in the plan; the
 *     provenance foreign key then rolled back the whole page update, new
 *     sources included.
 *   - Two commits of one session (a retry started while an aborted run's
 *     commit was still going) committed the same plan twice: provenance and
 *     activity rows doubled.
 *   - The reconcile pass flushed a snapshot of pending_content taken before
 *     its awaits, and cleared the outbox whatever it then held, so a newer
 *     text written meanwhile (restore, approve) was dropped from the outbox
 *     while the file kept the older one.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as commitPOST } from '../app/api/compile/commit/route';
import {
  setupTestDb,
  seedSource,
  seedPage,
  seedPagePlan,
  seedCompileProgress,
  getActivityCounts,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

const BODY = `---\ntitle: "Page"\n---\n${'Body text about the subject. '.repeat(40)}`;

function commitRequest(session_id: string): Request {
  return new Request('http://test/api/compile/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id }),
  });
}

interface CommitResp {
  committed: number;
  failed: number;
  flush_failures: number;
}

/**
 * Stubs nlp-service. `onWrite` runs while a write-page request is in flight
 * (before it answers), standing in for another writer acting meanwhile.
 * Returns the { page_id, markdown } bodies write-page received.
 */
function stubNlp(opts: { delayMs?: number; onWrite?: (page_id: string) => void } = {}) {
  const writes: Array<{ page_id: string; markdown: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      if (u.includes('/storage/write-page')) {
        const body = JSON.parse(String(init?.body)) as { page_id: string; markdown: string };
        writes.push(body);
        opts.onWrite?.(body.page_id);
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        return new Response(JSON.stringify({ current_path: `/data/pages/${body.page_id}.md.gz`, previous_path: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes('/vectors/upsert')) return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch in test: ${u}`);
    })
  );
  return writes;
}

function pending(page_id: string): string | null {
  return (
    handle!.db.prepare('SELECT pending_content FROM pages WHERE page_id = ?').get(page_id) as {
      pending_content: string | null;
    }
  ).pending_content;
}

describe('commit: sources deleted while the session compiled', () => {
  it('commits the page update with the sources that still exist', async () => {
    handle = setupTestDb();
    const db = handle.db;
    const session_id = 'sess-deleted-source';
    seedCompileProgress(db, session_id);
    const page_id = seedPage(db, { title: 'Ethereum', page_type: 'entity' });
    const oldSource = seedSource(db, { title: 'Old article' });
    const newSource = seedSource(db, { onboarding_session_id: session_id, compile_status: 'in_progress' });
    const plan_id = seedPagePlan(db, {
      session_id,
      title: 'Ethereum',
      page_type: 'entity',
      action: 'update',
      existing_page_id: page_id,
      source_ids: [oldSource, newSource],
      draft_status: 'crossreffed',
      draft_content: BODY,
    });
    // The user deletes the old source while drafting runs.
    db.prepare('DELETE FROM sources WHERE source_id = ?').run(oldSource);
    stubNlp();

    const body = (await (await commitPOST(commitRequest(session_id))).json()) as CommitResp;

    expect(body.failed).toBe(0);
    expect(body.committed).toBe(1);
    expect(
      db.prepare('SELECT source_id, contribution_type FROM provenance WHERE page_id = ?').all(page_id)
    ).toEqual([{ source_id: newSource, contribution_type: 'updated' }]);
    const plan = db.prepare('SELECT draft_status, source_ids FROM page_plans WHERE plan_id = ?').get(plan_id) as {
      draft_status: string;
      source_ids: string;
    };
    expect(plan.draft_status).toBe('committed');
    expect(JSON.parse(plan.source_ids)).toEqual([newSource]);
  });

  it("drops a plan whose only source was deleted instead of creating that source's page", async () => {
    handle = setupTestDb();
    const db = handle.db;
    const session_id = 'sess-deleted-only-source';
    seedCompileProgress(db, session_id);
    const gone = seedSource(db, { onboarding_session_id: session_id, compile_status: 'in_progress' });
    const plan_id = seedPagePlan(db, {
      session_id,
      title: 'Deleted Source Summary',
      page_type: 'source-summary',
      action: 'create',
      source_ids: [gone],
      draft_status: 'crossreffed',
      draft_content: BODY,
    });
    db.prepare('DELETE FROM sources WHERE source_id = ?').run(gone);
    stubNlp();

    const body = (await (await commitPOST(commitRequest(session_id))).json()) as CommitResp;

    expect(body.failed).toBe(0);
    expect(body.committed).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM pages').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM page_plans WHERE plan_id = ?').get(plan_id)).toEqual({ n: 0 });
  });
});

describe('commit: idempotency guard inside the transaction', () => {
  it('two overlapping commits of one session commit each plan once', async () => {
    handle = setupTestDb();
    const db = handle.db;
    const session_id = 'sess-double-commit';
    seedCompileProgress(db, session_id);
    const source_id = seedSource(db, { onboarding_session_id: session_id, compile_status: 'in_progress' });
    for (const title of ['Alpha Page', 'Beta Page']) {
      seedPagePlan(db, {
        session_id,
        title,
        page_type: 'entity',
        action: 'create',
        source_ids: [source_id],
        draft_status: 'crossreffed',
        draft_content: BODY,
      });
    }
    // Slow write-page so the two commits overlap.
    stubNlp({ delayMs: 20 });

    const results = (await Promise.all(
      [commitPOST(commitRequest(session_id)), commitPOST(commitRequest(session_id))].map(async (r) =>
        (await r).json()
      )
    )) as CommitResp[];

    expect(results[0].committed + results[1].committed).toBe(2);
    expect(results[0].failed + results[1].failed).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM provenance').get()).toEqual({ n: 2 });
    expect(getActivityCounts(db).page_compiled).toBe(2);
  });
});

describe('commit: outbox flush re-reads pending_content and clears it compare-and-set', () => {
  it('the reconcile pass writes the newest pending text, not a snapshot taken before its awaits', async () => {
    handle = setupTestDb();
    const db = handle.db;
    const session_id = 'sess-outbox-reread';
    seedCompileProgress(db, session_id);
    // Two stranded outbox rows from other paths.
    for (const page_id of ['stranded-one', 'stranded-two']) {
      seedPage(db, { page_id, title: page_id });
      db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run(`old ${page_id}`, page_id);
    }
    // While the first stranded page is being written, another writer (a
    // restore) replaces the second page's pending text.
    let replaced: string | null = null;
    const writes = stubNlp({
      onWrite: (page_id) => {
        if (replaced !== null || !page_id.startsWith('stranded-')) return;
        replaced = page_id === 'stranded-one' ? 'stranded-two' : 'stranded-one';
        db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run(`new ${replaced}`, replaced);
      },
    });

    await commitPOST(commitRequest(session_id));

    expect(replaced).not.toBeNull();
    const second = writes.filter((w) => w.page_id === replaced);
    expect(second.map((w) => w.markdown)).toEqual([`new ${replaced}`]);
    expect(pending(replaced!)).toBeNull();
  });

  it('text written to pending_content during a flush stays queued after that flush', async () => {
    handle = setupTestDb();
    const db = handle.db;
    const session_id = 'sess-outbox-cas';
    seedCompileProgress(db, session_id);
    seedPage(db, { page_id: 'busy-page', title: 'Busy' });
    db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run('first text', 'busy-page');
    // Mid-flush, another writer commits newer text for the same page.
    stubNlp({
      onWrite: (page_id) => {
        if (page_id === 'busy-page' && pending('busy-page') === 'first text') {
          db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run('newer text', 'busy-page');
        }
      },
    });

    await commitPOST(commitRequest(session_id));

    // The flush wrote 'first text'; the outbox must still hold 'newer text'
    // for its own writer or the next reconcile pass.
    expect(pending('busy-page')).toBe('newer text');
  });
});
