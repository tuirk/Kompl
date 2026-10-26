/**
 * runCompilePipeline on an empty provider account (DeepSeek 402, audit M7).
 *
 * nlp-service answers it as a 503 named provider_out_of_credit. Each
 * source's extract failed on its own (one call each), the session went on,
 * and the message told the owner to raise the daily limit. Now the compile
 * stops at the first one and says to top up the account.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as runPOST } from '../app/api/compile/run/route';
import { getCompileProgress } from '../lib/db';
import { OUT_OF_CREDIT_MESSAGE } from '../lib/out-of-credit';
import { setupTestDb, seedSource, seedExtraction, seedPagePlan, type TestDbHandle } from './helpers/test-db';
import { json, post, readSteps, seedQueuedProgress, stubPipeline } from './helpers/compile-run-harness';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const outOfCredit = () => json({ error: 'provider_out_of_credit', message: OUT_OF_CREDIT_MESSAGE }, 503);

async function runToEnd(session_id: string) {
  expect((await runPOST(post({ session_id }))).status).toBe(200);
  await vi.waitFor(() => expect(getCompileProgress(session_id)?.status).toBe('failed'));
  return getCompileProgress(session_id)!;
}

describe('compile on an empty provider account', () => {
  it('stops extracting at the first source and says to top up the account', async () => {
    handle = setupTestDb();
    const session_id = 'sess-extract-no-credit';
    for (let i = 0; i < 3; i++) seedSource(handle.db, { onboarding_session_id: session_id, compile_status: 'in_progress' });
    seedQueuedProgress(handle.db, session_id);
    vi.stubEnv('EXTRACT_CONCURRENCY', '1');
    const stub = stubPipeline([], { '/api/compile/extract': outOfCredit });

    const progress = await runToEnd(session_id);

    expect(stub.calls.filter((p) => p === '/api/compile/extract')).toHaveLength(1);
    expect(progress.error).toBe(OUT_OF_CREDIT_MESSAGE);
    expect(readSteps(progress.steps).extract.status).toBe('failed');
    expect(stub.calls).not.toContain('/api/compile/resolve');
  });

  it('fails the session with the same message when the draft step stops on it', async () => {
    handle = setupTestDb();
    const session_id = 'sess-draft-no-credit';
    const source_id = seedSource(handle.db, { onboarding_session_id: session_id, compile_status: 'in_progress' });
    seedExtraction(handle.db, { source_id });
    seedPagePlan(handle.db, { session_id, page_type: 'entity', action: 'create', source_ids: [source_id], draft_status: 'planned' });
    seedQueuedProgress(handle.db, session_id);
    const stub = stubPipeline([], { '/api/compile/draft': outOfCredit });

    const progress = await runToEnd(session_id);

    expect(progress.error).toBe(OUT_OF_CREDIT_MESSAGE);
    expect(stub.calls).not.toContain('/api/compile/commit');
  });
});
