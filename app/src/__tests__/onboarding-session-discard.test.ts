/**
 * DELETE /api/onboarding/session: discarding a session that is compiling.
 *
 * Regression target: the route set status 'cancelled' before it looked at the
 * commit step, so its own poll always saw 'cancelled' first and the
 * commit_in_progress refusal could never fire. A discard during commit
 * deleted compile_progress and the staging rows while commit was still
 * writing pages, and a discard earlier on left the pipeline running on with
 * no progress row.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { DELETE } from '../app/api/onboarding/session/route';
import { POST as runPOST } from '../app/api/compile/run/route';
import { getCompileProgress, getStagingBySession, insertCollectStaging, markStagingIngested } from '../lib/db';
import { setupTestDb, seedSource, seedExtraction, type TestDbHandle } from './helpers/test-db';
import {
  COMMIT_OK,
  heldCall,
  json,
  post,
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

function discard(session_id: string): Promise<Response> {
  return DELETE(new Request(`http://test/api/onboarding/session?session_id=${session_id}`, { method: 'DELETE' }));
}

/** A staged note that was already imported, so the run skips the ingest steps. */
function seedIngestedStaging(session_id: string, source_id: string): void {
  insertCollectStaging({ stage_id: `${session_id}-stage`, session_id, connector: 'text', payload: { markdown: 'x' } });
  markStagingIngested(`${session_id}-stage`, source_id);
}

describe('DELETE /api/onboarding/session while a compile runs', () => {
  it('refuses with 409 during commit, keeps the session, and commit finishes', async () => {
    handle = setupTestDb();
    const session_id = 'sess-discard-commit';
    seedQueuedProgress(handle.db, session_id);
    seedIngestedStaging(session_id, 'some-existing-source');
    const stub = stubPipeline(['/api/compile/commit']);

    expect((await runPOST(post({ session_id }))).status).toBe(200);
    const commit = await heldCall(stub, '/api/compile/commit');

    const res = await discard(session_id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('commit_in_progress');
    expect(getCompileProgress(session_id)?.status).toBe('running');
    expect(getStagingBySession(session_id)).toHaveLength(1);

    commit.release(json(COMMIT_OK));
    await vi.waitFor(() => expect(getCompileProgress(session_id)?.status).toBe('completed'));
  });

  it('before commit: cancels, waits for the pipeline to stop, then clears the session', async () => {
    handle = setupTestDb();
    const db = handle.db;
    const session_id = 'sess-discard-resolve';
    const source_id = seedSource(db, { onboarding_session_id: session_id, compile_status: 'in_progress' });
    seedExtraction(db, { source_id });
    seedQueuedProgress(db, session_id);
    seedIngestedStaging(session_id, source_id);
    const stub = stubPipeline(['/api/compile/resolve']);

    expect((await runPOST(post({ session_id }))).status).toBe(200);
    const resolve = await heldCall(stub, '/api/compile/resolve');

    // The pipeline's resolve call returns while the discard is under way.
    const pending = discard(session_id);
    await settle(20);
    resolve.release(json({ canonical_entities: [], canonical_concepts: [] }));
    const res = await pending;
    await settle();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      session_id,
      removed: { staging_rows: 1, files_unlinked: 0, progress_cleared: true },
    });
    expect(getCompileProgress(session_id)).toBeNull();
    expect(stub.calls).not.toContain('/api/compile/match');
    expect(stub.calls).not.toContain('/api/compile/commit');
  });

  it('a queued session with no pipeline is cleared at once', async () => {
    handle = setupTestDb();
    const session_id = 'sess-discard-queued';
    seedQueuedProgress(handle.db, session_id);
    seedIngestedStaging(session_id, 'some-existing-source');

    const res = await discard(session_id);
    expect(res.status).toBe(200);
    expect(getCompileProgress(session_id)).toBeNull();
    expect(getStagingBySession(session_id)).toHaveLength(0);
  });
});
