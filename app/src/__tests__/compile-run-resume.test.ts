/**
 * runCompilePipeline (POST /api/compile/run): resuming a session, and the
 * commit gate.
 *
 * Regression targets:
 *   - Commit marks the session's sources 'active' before its flush pass. A
 *     retry after a flush failure then found "no sources", marked every step
 *     skipped and completed the session without running commit, so the page
 *     file was never written.
 *   - /retry-failed after some drafts failed: the sources had gone 'active'
 *     through their committed summary plan, so the failed plan was never
 *     re-drafted.
 *   - Commit's `failed` count was ignored, so a session whose page update
 *     rolled back still ended 'completed'.
 *
 * crossref and commit are the real route handlers, reached through a fetch
 * stub; resolve, match, draft, schema, n8n and nlp-service are stubbed.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as runPOST } from '../app/api/compile/run/route';
import { POST as retryPOST } from '../app/api/compile/retry/route';
import { POST as retryFailedPOST } from '../app/api/compile/retry-failed/route';
import { POST as crossrefPOST } from '../app/api/compile/crossref/route';
import { POST as commitPOST } from '../app/api/compile/commit/route';
import { COMPILE_STEP_KEYS } from '../lib/compile-steps';
import { getCompileProgress, updatePlanDraft } from '../lib/db';
import {
  setupTestDb,
  seedSource,
  seedExtraction,
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

const BODY = `---\ntitle: "Page"\n---\n${'Body text about the subject. '.repeat(40)}`;

interface Services {
  writePageOk: boolean;
  /** Stands in for the draft route: returns its { drafted, failed } counts. */
  draft?: () => { drafted: number; failed: number };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Stubs fetch for the orchestrator; returns the list of paths it called. */
function stubServices(services: Services): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url.toString()).pathname;
      calls.push(path);
      const forward = (handler: (r: Request) => Promise<Response>) =>
        handler(
          new Request(url.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: String(init?.body ?? '{}'),
          })
        );
      switch (path) {
        case '/api/compile/crossref':
          return forward(crossrefPOST);
        case '/api/compile/commit':
          return forward(commitPOST);
        case '/api/compile/resolve':
          return json({ canonical_entities: [], canonical_concepts: [] });
        case '/api/compile/match':
          return json({ skipped: true, matches: [], stats: {} });
        case '/api/compile/draft':
          return json(services.draft ? services.draft() : { drafted: 0, failed: 0 });
        case '/api/compile/schema':
          return json({ status: 'already_exists' });
        case '/webhook/session-compile':
          return json({ ok: true });
        case '/storage/write-page':
          return services.writePageOk
            ? json({ current_path: '/data/pages/x.md.gz', previous_path: null })
            : json({ detail: 'disk full' }, 500);
        case '/vectors/upsert':
          return json({});
      }
      throw new Error(`unexpected fetch in test: ${url.toString()}`);
    })
  );
  return calls;
}

function post(body: unknown): Request {
  return new Request('http://test/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Starts the orchestrator and waits until it completes or fails. */
async function runAndWait(session_id: string) {
  const res = await runPOST(post({ session_id }));
  expect(res.status).toBe(200);
  await vi.waitFor(
    () => {
      const status = getCompileProgress(session_id)?.status;
      if (status !== 'completed' && status !== 'failed') throw new Error(`still ${status}`);
    },
    { timeout: 10_000, interval: 10 }
  );
  const p = getCompileProgress(session_id)!;
  return {
    status: p.status,
    error: p.error,
    steps: JSON.parse(p.steps) as Record<string, { status: string; detail?: string }>,
  };
}

function pendingFlushCount(): number {
  return (
    handle!.db.prepare('SELECT COUNT(*) AS n FROM pages WHERE pending_content IS NOT NULL').get() as { n: number }
  ).n;
}

function planStatus(plan_id: string): string {
  return (
    handle!.db.prepare('SELECT draft_status FROM page_plans WHERE plan_id = ?').get(plan_id) as {
      draft_status: string;
    }
  ).draft_status;
}

/** compile_progress as /api/onboarding/finalize leaves it: queued, every step pending. */
function seedQueuedProgress(session_id: string): void {
  seedCompileProgress(handle!.db, session_id);
  const steps = Object.fromEntries(COMPILE_STEP_KEYS.map((k) => [k, { status: 'pending' }]));
  handle!.db
    .prepare(`UPDATE compile_progress SET status = 'queued', steps = ? WHERE session_id = ?`)
    .run(JSON.stringify(steps), session_id);
}

/** A session with one extracted source and one plan ready to commit. */
function seedReadySession(session_id: string, title = 'Ready Page'): { source_id: string; plan_id: string } {
  const db = handle!.db;
  const source_id = seedSource(db, { onboarding_session_id: session_id, compile_status: 'in_progress' });
  seedExtraction(db, { source_id });
  seedQueuedProgress(session_id);
  const plan_id = seedPagePlan(db, {
    session_id,
    title,
    page_type: 'entity',
    action: 'create',
    source_ids: [source_id],
    draft_status: 'crossreffed',
    draft_content: BODY,
  });
  return { source_id, plan_id };
}

describe('runCompilePipeline: retry after a page file failed to flush', () => {
  it('re-runs commit, writes the file, and only then completes', async () => {
    handle = setupTestDb();
    const session_id = 'sess-resume-flush';
    seedReadySession(session_id);

    // First run: write-page is down. The DB rows commit, the file does not.
    stubServices({ writePageOk: false });
    const first = await runAndWait(session_id);
    expect(first.status).toBe('failed');
    expect(first.steps.commit.status).toBe('failed');
    expect(pendingFlushCount()).toBe(1);

    // Retry with nlp-service healthy. The session's source is already
    // 'active' (commit marked it before its flush pass).
    const calls = stubServices({ writePageOk: true });
    expect((await retryPOST(post({ session_id }))).status).toBe(200);
    const second = await runAndWait(session_id);

    expect(second.status).toBe('completed');
    expect(calls).toContain('/api/compile/commit');
    expect(calls).toContain('/storage/write-page');
    expect(pendingFlushCount()).toBe(0);
  });

  it('fails again (never completes) while the file still cannot be written', async () => {
    handle = setupTestDb();
    const session_id = 'sess-resume-still-down';
    seedReadySession(session_id);

    stubServices({ writePageOk: false });
    expect((await runAndWait(session_id)).status).toBe('failed');

    expect((await retryPOST(post({ session_id }))).status).toBe(200);
    const second = await runAndWait(session_id);

    expect(second.status).toBe('failed');
    expect(second.steps.commit.status).toBe('failed');
    expect(pendingFlushCount()).toBe(1);
  });
});

describe('runCompilePipeline: a session with no sources and no plans', () => {
  it('saved-link-only session still completes with every step skipped', async () => {
    handle = setupTestDb();
    const db = handle.db;
    const session_id = 'sess-saved-links-only';
    seedQueuedProgress(session_id);

    const calls = stubServices({ writePageOk: true });
    const result = await runAndWait(session_id);

    expect(result.status).toBe('completed');
    for (const step of ['extract', 'plan', 'draft', 'crossref', 'commit', 'schema']) {
      expect(result.steps[step]).toEqual({ status: 'done', detail: 'skipped (no sources)' });
    }
    expect(calls).not.toContain('/api/compile/draft');
    expect(calls).not.toContain('/api/compile/schema');
  });
});

describe('runCompilePipeline: /retry-failed after some drafts failed', () => {
  it('re-drafts and commits the failed plan even though every source is active', async () => {
    handle = setupTestDb();
    const db = handle.db;
    const session_id = 'sess-retry-failed-drafts';
    const { source_id } = seedReadySession(session_id, 'Source Summary');
    const entityPlan = seedPagePlan(db, {
      session_id,
      title: 'Failed Entity',
      page_type: 'entity',
      action: 'create',
      source_ids: [source_id],
      draft_status: 'failed',
    });

    // First run: the entity draft fails again (e.g. a 429); the summary
    // commits and the source goes 'active'.
    stubServices({ writePageOk: true, draft: () => ({ drafted: 0, failed: 1 }) });
    expect((await runAndWait(session_id)).status).toBe('completed');
    expect(planStatus(entityPlan)).toBe('failed');

    // /retry-failed: this time the draft succeeds.
    const calls = stubServices({
      writePageOk: true,
      draft: () => {
        updatePlanDraft(entityPlan, BODY, null);
        return { drafted: 1, failed: 0 };
      },
    });
    const retry = await retryFailedPOST(post({ session_id }));
    expect(((await retry.json()) as { status: string }).status).toBe('retrying');
    const second = await runAndWait(session_id);

    expect(second.status).toBe('completed');
    expect(calls).toContain('/api/compile/draft');
    expect(planStatus(entityPlan)).toBe('committed');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM pages WHERE title = 'Failed Entity'`).get()).toEqual({ n: 1 });
  });
});

describe('runCompilePipeline: commit failures fail the session', () => {
  it('a page whose commit transaction rolls back fails the session, and a retry recovers it', async () => {
    handle = setupTestDb();
    const db = handle.db;
    const session_id = 'sess-commit-tx-fail';
    const { plan_id } = seedReadySession(session_id, 'Boom Page');
    // Forces the page's provenance insert (inside the commit transaction) to fail.
    db.exec(`CREATE TRIGGER fail_boom BEFORE INSERT ON provenance
             WHEN NEW.page_id LIKE 'boom-page-%'
             BEGIN SELECT RAISE(ABORT, 'forced provenance failure'); END;`);

    stubServices({ writePageOk: true });
    const first = await runAndWait(session_id);
    expect(first.status).toBe('failed');
    expect(first.steps.commit.status).toBe('failed');
    expect(first.error).toMatch(/commit/);
    expect(planStatus(plan_id)).toBe('failed');

    // The cause is gone; a retry re-drafts and commits the page.
    db.exec('DROP TRIGGER fail_boom');
    stubServices({
      writePageOk: true,
      draft: () => {
        updatePlanDraft(plan_id, BODY, null);
        return { drafted: 1, failed: 0 };
      },
    });
    expect((await retryPOST(post({ session_id }))).status).toBe(200);
    const second = await runAndWait(session_id);
    expect(second.status).toBe('completed');
    expect(planStatus(plan_id)).toBe('committed');
  });
});
