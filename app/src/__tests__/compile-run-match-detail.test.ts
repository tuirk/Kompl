/**
 * runCompilePipeline: the finished match step's detail line counts the
 * candidates whose triage call failed (match stats `triage_failed`), and
 * reads the field defensively for match responses without it.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as runPOST } from '../app/api/compile/run/route';
import { getCompileProgress } from '../lib/db';
import { setupTestDb, seedSource, seedExtraction, type TestDbHandle } from './helpers/test-db';
import { json, post, readSteps, seedQueuedProgress, stubPipeline } from './helpers/compile-run-harness';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

async function matchDetail(stats: Record<string, number>): Promise<string | undefined> {
  handle = setupTestDb();
  const session_id = 'sess-match-detail';
  const source_id = seedSource(handle.db, { onboarding_session_id: session_id, compile_status: 'in_progress' });
  seedExtraction(handle.db, { source_id });
  seedQueuedProgress(handle.db, session_id);
  stubPipeline([], { '/api/compile/match': () => json({ skipped: false, matches: [], stats }) });

  expect((await runPOST(post({ session_id }))).status).toBe(200);
  await vi.waitFor(() => expect(getCompileProgress(session_id)?.status).toBe('completed'));
  return readSteps(getCompileProgress(session_id)!.steps).match.detail;
}

const STATS = { candidates_found: 3, sources_checked: 1, updates: 1, contradictions: 0, skips: 1 };

describe('match step detail', () => {
  it('adds the failed triage count when there is one', async () => {
    expect(await matchDetail({ ...STATS, triage_failed: 1 })).toBe('3 candidates from 1 sources → 1u/0c/1s · 1 failed');
  });

  it('leaves it out when no triage failed, or the field is missing', async () => {
    expect(await matchDetail({ ...STATS, triage_failed: 0 })).toBe('3 candidates from 1 sources → 1u/0c/1s');
    handle?.cleanup();
    expect(await matchDetail(STATS)).toBe('3 candidates from 1 sources → 1u/0c/1s');
  });
});
