/**
 * runCompilePipeline: how long the orchestrator waits for the draft step
 * (audit H3). The draft route drafts its layers one after another, and a
 * wiki's first compile drafts one summary alone first; the wait was sized
 * by plan count alone, so a 7-plan first compile got 900 s for 5 rounds of
 * drafts and the session failed while the drafts went on.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as runPOST } from '../app/api/compile/run/route';
import { getCompileProgress } from '../lib/db';
import { setupTestDb, seedSource, seedPagePlan, type TestDbHandle } from './helpers/test-db';
import { json, post, seedQueuedProgress, stubPipeline } from './helpers/compile-run-harness';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('draft step timeout', () => {
  it('allows a round per layer and the summary drafted alone', async () => {
    handle = setupTestDb();
    const session_id = 'sess-draft-wait';
    // Sources already active: the run goes straight to the plans left to draft.
    const source_id = seedSource(handle.db, { onboarding_session_id: session_id, compile_status: 'active' });
    seedQueuedProgress(handle.db, session_id);
    const layers = ['source-summary', 'source-summary', 'source-summary', 'entity', 'entity', 'concept', 'overview'];
    for (const page_type of layers) {
      seedPagePlan(handle.db, { session_id, page_type, action: 'create', source_ids: [source_id], draft_status: 'planned' });
    }

    const timeouts: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      timeouts.push(ms);
      return timeout(ms);
    });
    let draftWaitMs: number | undefined;
    stubPipeline([], {
      '/api/compile/draft': () => {
        draftWaitMs = timeouts.at(-1);
        return json({ drafted: 7, failed: 0 });
      },
    });

    expect((await runPOST(post({ session_id }))).status).toBe(200);
    await vi.waitFor(() => expect(getCompileProgress(session_id)?.status).toBe('completed'));

    // Summaries alone then together, entities, concepts, overviews: five
    // rounds of up to 600 s each.
    expect(draftWaitMs).toBeGreaterThan(5 * 600_000);
  });
});
