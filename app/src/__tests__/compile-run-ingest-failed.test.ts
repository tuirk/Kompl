/**
 * runCompilePipeline: a session where every staged item failed to import.
 *
 * Regression target: each ingest step ends 'done' however many items failed,
 * so with no source created the pipeline took the no-sources path and ended
 * 'completed' with no pages. A plain Retry did the same, since the failed
 * staging rows are no longer 'pending'.
 *
 * A saved-link-only session (media-only tweets: no source, but the link is
 * saved) still completes.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as runPOST } from '../app/api/compile/run/route';
import { POST as retryPOST } from '../app/api/compile/retry/route';
import { getCompileProgress, insertCollectStaging } from '../lib/db';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';
import { post, readSteps, seedQueuedProgress, stubPipeline } from './helpers/compile-run-harness';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function stubKeys(): void {
  vi.stubEnv('GEMINI_API_KEY', 'test-key');
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key');
}

async function runAndWait(session_id: string) {
  expect((await runPOST(post({ session_id }))).status).toBe(200);
  await vi.waitFor(
    () => {
      const status = getCompileProgress(session_id)?.status;
      if (status !== 'completed' && status !== 'failed') throw new Error(`still ${status}`);
    },
    { timeout: 10_000, interval: 10 }
  );
  const p = getCompileProgress(session_id)!;
  return { status: p.status, error: p.error, steps: readSteps(p.steps) };
}

/** Two notes whose payload has no markdown: ingest_texts fails both. */
function stageBrokenNotes(session_id: string): void {
  for (const n of [1, 2]) {
    insertCollectStaging({ stage_id: `${session_id}-${n}`, session_id, connector: 'text', payload: {} });
  }
}

describe('runCompilePipeline: every staged item failed to import', () => {
  it('fails the session on the ingest step instead of completing it', async () => {
    handle = setupTestDb();
    stubKeys();
    const session_id = 'sess-all-ingest-failed';
    seedQueuedProgress(handle.db, session_id);
    stageBrokenNotes(session_id);
    const stub = stubPipeline();

    const result = await runAndWait(session_id);

    expect(result.status).toBe('failed');
    expect(result.steps.ingest_texts.status).toBe('failed');
    expect(result.steps.ingest_texts.detail).toMatch(/2 failed/);
    expect(result.error).toMatch(/nothing to compile/i);
    expect(stub.calls).not.toContain('/api/compile/commit');
  });

  it('a plain Retry fails again rather than completing', async () => {
    handle = setupTestDb();
    stubKeys();
    const session_id = 'sess-all-ingest-failed-retry';
    seedQueuedProgress(handle.db, session_id);
    stageBrokenNotes(session_id);
    stubPipeline();
    expect((await runAndWait(session_id)).status).toBe('failed');

    expect((await retryPOST(post({ session_id }))).status).toBe(200);
    const second = await runAndWait(session_id);

    expect(second.status).toBe('failed');
    expect(second.error).toMatch(/nothing to compile/i);
    expect(second.steps.ingest_texts.status).toBe('failed');
  });

  it('a saved-link-only session still completes', async () => {
    handle = setupTestDb();
    stubKeys();
    const session_id = 'sess-saved-link-staged';
    seedQueuedProgress(handle.db, session_id);
    insertCollectStaging({
      stage_id: `${session_id}-1`,
      session_id,
      connector: 'saved-link',
      payload: { url: 'https://example.com/status/1', title_hint: 'A saved post' },
    });
    stubPipeline();

    const result = await runAndWait(session_id);

    expect(result.status).toBe('completed');
    expect(result.steps.ingest_texts).toEqual({ status: 'done', detail: '1/1 saved' });
  });

  it('one imported item among failures lets the session go on', async () => {
    handle = setupTestDb();
    stubKeys();
    const session_id = 'sess-some-ingested';
    seedQueuedProgress(handle.db, session_id);
    stageBrokenNotes(session_id);
    insertCollectStaging({
      stage_id: `${session_id}-link`,
      session_id,
      connector: 'saved-link',
      payload: { url: 'https://example.com/status/2' },
    });
    stubPipeline();

    const result = await runAndWait(session_id);

    expect(result.status).toBe('completed');
    expect(result.steps.ingest_texts).toEqual({ status: 'done', detail: '1/3 saved, 2 failed' });
  });
});
