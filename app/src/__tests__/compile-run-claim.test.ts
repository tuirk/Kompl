/**
 * POST /api/compile/run: the run gate claims the session's row, and a
 * restarted session's old pipeline cannot write over the new run.
 *
 * Regression targets:
 *   - A 'running' session past its time limit was marked failed and a new
 *     pipeline started, but the status stayed 'failed' (only queued → running
 *     was ever flipped), so the one-compile gate ignored the new run.
 *   - The old pipeline, still waiting on a call, later wrote its step results
 *     and completed (or failed) the session under the new run.
 *   - A pipeline whose progress row was deleted (discarded session) carried
 *     on, because a missing row never read as cancelled.
 *
 * The pipeline runs the no-sources path (no staging rows, no sources, no
 * plans), whose only call is commit; the stub holds commit open.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as runPOST } from '../app/api/compile/run/route';
import { getCompileProgress, getRunningCompileSession } from '../lib/db';
import { setupTestDb, seedSource, seedExtraction, type TestDbHandle } from './helpers/test-db';
import {
  COMMIT_OK,
  heldCall,
  json,
  post,
  readSteps,
  seedQueuedProgress,
  settle,
  stubPipeline,
} from './helpers/compile-run-harness';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

function makeStale(session_id: string): void {
  handle!.db
    .prepare(`UPDATE compile_progress SET started_at = datetime('now', '-70 minutes') WHERE session_id = ?`)
    .run(session_id);
}

function elapsedMinutes(session_id: string): number {
  return (
    handle!.db
      .prepare(
        `SELECT CAST((julianday('now') - julianday(started_at)) * 24 * 60 AS INTEGER) AS m
           FROM compile_progress WHERE session_id = ?`
      )
      .get(session_id) as { m: number }
  ).m;
}

describe('run gate', () => {
  it('a running session within its time limit is refused', async () => {
    handle = setupTestDb();
    const session_id = 'sess-fresh-running';
    seedQueuedProgress(handle.db, session_id);
    handle.db
      .prepare(`UPDATE compile_progress SET status = 'running', started_at = datetime('now') WHERE session_id = ?`)
      .run(session_id);
    const stub = stubPipeline();

    const res = await runPOST(post({ session_id }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_running' });
    expect(stub.calls).toEqual([]);
  });

  it('a stale running session restarts as running, with a new time limit, and holds the one-compile gate', async () => {
    handle = setupTestDb();
    const session_id = 'sess-stale';
    seedQueuedProgress(handle.db, session_id);
    handle.db.prepare(`UPDATE compile_progress SET status = 'running' WHERE session_id = ?`).run(session_id);
    makeStale(session_id);
    const stub = stubPipeline(['/api/compile/commit']);

    const res = await runPOST(post({ session_id }));
    expect(res.status).toBe(200);
    const commit = await heldCall(stub, '/api/compile/commit');

    const during = getCompileProgress(session_id)!;
    expect(during.status).toBe('running');
    expect(during.error).toBeNull();
    expect(elapsedMinutes(session_id)).toBeLessThan(2);
    expect(getRunningCompileSession()?.session_id).toBe(session_id);

    commit.release(json(COMMIT_OK));
    await vi.waitFor(() => expect(getCompileProgress(session_id)?.status).toBe('completed'));
  });

  it('a failed session started directly runs as running, not failed', async () => {
    handle = setupTestDb();
    const session_id = 'sess-failed-direct';
    seedQueuedProgress(handle.db, session_id);
    handle.db
      .prepare(`UPDATE compile_progress SET status = 'failed', error = 'old error' WHERE session_id = ?`)
      .run(session_id);
    const stub = stubPipeline(['/api/compile/commit']);

    expect((await runPOST(post({ session_id }))).status).toBe(200);
    const commit = await heldCall(stub, '/api/compile/commit');
    expect(getCompileProgress(session_id)).toMatchObject({ status: 'running', error: null });
    expect(getRunningCompileSession()?.session_id).toBe(session_id);

    commit.release(json(COMMIT_OK));
    await vi.waitFor(() => expect(getCompileProgress(session_id)?.status).toBe('completed'));
  });
});

describe('old pipeline of a restarted session', () => {
  async function startThenRestart(session_id: string) {
    seedQueuedProgress(handle!.db, session_id);
    const stub = stubPipeline(['/api/compile/commit']);
    expect((await runPOST(post({ session_id }))).status).toBe(200);
    const oldCommit = await heldCall(stub, '/api/compile/commit', 1);

    // The first pipeline hangs past its time limit; the gate restarts it.
    makeStale(session_id);
    expect((await runPOST(post({ session_id }))).status).toBe(200);
    const newCommit = await heldCall(stub, '/api/compile/commit', 2);
    return { oldCommit, newCommit };
  }

  it('does not complete the session when its call finally returns', async () => {
    handle = setupTestDb();
    const session_id = 'sess-old-completes';
    const { oldCommit, newCommit } = await startThenRestart(session_id);

    oldCommit.release(json(COMMIT_OK));
    await settle();
    const during = getCompileProgress(session_id)!;
    expect(during.status).toBe('running');
    expect(readSteps(during.steps).commit.status).toBe('running');

    newCommit.release(json(COMMIT_OK));
    await vi.waitFor(() => expect(getCompileProgress(session_id)?.status).toBe('completed'));
  });

  it('does not fail the new run when its call fails', async () => {
    handle = setupTestDb();
    const session_id = 'sess-old-fails';
    const { oldCommit, newCommit } = await startThenRestart(session_id);

    oldCommit.release(json({ error: 'boom' }, 500));
    await settle();
    expect(getCompileProgress(session_id)).toMatchObject({ status: 'running', error: null });

    newCommit.release(json(COMMIT_OK));
    await vi.waitFor(() => expect(getCompileProgress(session_id)?.status).toBe('completed'));
  });
});

describe('pipeline of a discarded session', () => {
  it('stops at its next step boundary once its progress row is gone', async () => {
    handle = setupTestDb();
    const db = handle.db;
    const session_id = 'sess-row-deleted';
    const source_id = seedSource(db, { onboarding_session_id: session_id, compile_status: 'in_progress' });
    seedExtraction(db, { source_id });
    seedQueuedProgress(db, session_id);
    const stub = stubPipeline(['/api/compile/resolve']);

    expect((await runPOST(post({ session_id }))).status).toBe(200);
    const resolve = await heldCall(stub, '/api/compile/resolve');

    db.prepare('DELETE FROM compile_progress WHERE session_id = ?').run(session_id);
    resolve.release(json({ canonical_entities: [], canonical_concepts: [] }));
    await settle();

    expect(stub.calls).not.toContain('/api/compile/match');
    expect(stub.calls).not.toContain('/api/compile/commit');
    expect(getCompileProgress(session_id)).toBeNull();
  });
});
