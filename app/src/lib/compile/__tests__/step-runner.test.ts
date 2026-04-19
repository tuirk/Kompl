import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCompileProgress, getCompileProgress } from '../../db';
import { setupTestDb, type TestDbHandle } from '../../../__tests__/helpers/test-db';
import { runPerItemStep } from '../step-runner';

const NOOP_CANCEL = (_: string) => {};

describe('runPerItemStep', () => {
  let handle: TestDbHandle;
  const sessionId = 'test-runner-session';

  beforeEach(() => {
    handle = setupTestDb();
    // step-runner writes to compile_progress.steps — seed a row first.
    createCompileProgress(sessionId, 0);
  });

  afterEach(() => {
    handle.cleanup();
  });

  function readStep(key: string): { status: string; detail?: string } | null {
    const progress = getCompileProgress(sessionId);
    if (!progress) return null;
    const steps = JSON.parse(progress.steps) as Record<string, { status: string; detail?: string }>;
    return steps[key] ?? null;
  }

  it('zero items → writes done + "skipped" detail and returns empty result', async () => {
    const result = await runPerItemStep<string>({
      sessionId,
      stepKey: 'ingest_urls',
      items: [],
      run: async () => { throw new Error('should not run'); },
      progressMessage: () => 'n/a',
      assertNotCancelled: NOOP_CANCEL,
    });

    expect(result.succeeded).toHaveLength(0);
    expect(result.failed).toHaveLength(0);

    const step = readStep('ingest_urls');
    expect(step?.status).toBe('done');
    expect(step?.detail).toMatch(/^skipped/);
  });

  it('all succeed → done with "N/N" message, progress streams', async () => {
    const items = ['a', 'b', 'c'];
    const run = vi.fn(async () => {});

    const result = await runPerItemStep<string>({
      sessionId,
      stepKey: 'ingest_urls',
      items,
      run,
      progressMessage: (done, failed, total) =>
        `${done}/${total} fetched${failed > 0 ? `, ${failed} failed` : ''}`,
      assertNotCancelled: NOOP_CANCEL,
    });

    expect(result.succeeded).toEqual(items);
    expect(result.failed).toHaveLength(0);
    expect(run).toHaveBeenCalledTimes(3);

    const step = readStep('ingest_urls');
    expect(step?.status).toBe('done');
    expect(step?.detail).toBe('3/3 fetched');
  });

  it('mixed outcomes → done with success/failure tally, onFailure fires per failed item', async () => {
    const items = ['ok-1', 'bad', 'ok-2'];
    const onFailure = vi.fn(async () => {});

    const result = await runPerItemStep<string>({
      sessionId,
      stepKey: 'ingest_urls',
      items,
      run: async (item) => {
        if (item === 'bad') throw new Error('scrape_failed');
      },
      onFailure,
      progressMessage: (done, failed, total) =>
        `${done}/${total} fetched, ${failed} failed`,
      assertNotCancelled: NOOP_CANCEL,
    });

    expect(result.succeeded).toEqual(['ok-1', 'ok-2']);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].item).toBe('bad');
    expect(result.failed[0].error.message).toBe('scrape_failed');

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith('bad', expect.any(Error));

    const step = readStep('ingest_urls');
    expect(step?.status).toBe('done');
    expect(step?.detail).toBe('2/3 fetched, 1 failed');
  });

  it('cancellation throw propagates — step stays in running, re-thrown once', async () => {
    const items = [1, 2, 3];
    let callCount = 0;

    const runPromise = runPerItemStep<number>({
      sessionId,
      stepKey: 'ingest_urls',
      items,
      run: async () => {},
      progressMessage: (done, failed, total) => `${done}/${total}`,
      assertNotCancelled: () => {
        // Cancel on the second item's pre-run check. First item succeeds.
        callCount++;
        if (callCount > 2) throw new Error('CompileCancelledError');
      },
    });

    await expect(runPromise).rejects.toThrow('CompileCancelledError');
    // Step should not have been marked 'done' — left in 'running' for the
    // orchestrator to flip to 'cancelled' via cancelCompileProgress.
    const step = readStep('ingest_urls');
    expect(step?.status).toBe('running');
  });

  it('onFailure throw does NOT derail the batch — logged + counted', async () => {
    const items = ['a', 'b'];
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runPerItemStep<string>({
      sessionId,
      stepKey: 'ingest_urls',
      items,
      run: async () => { throw new Error('boom'); },
      onFailure: async () => { throw new Error('side-effect broken'); },
      progressMessage: (done, failed, total) => `${done}/${total}, ${failed} failed`,
      assertNotCancelled: NOOP_CANCEL,
    });

    expect(result.failed).toHaveLength(2);
    expect(readStep('ingest_urls')?.status).toBe('done');
    expect(consoleErrSpy).toHaveBeenCalledTimes(2);

    consoleErrSpy.mockRestore();
  });

  it('respects concurrency cap', async () => {
    const items = Array.from({ length: 6 }, (_, i) => i);
    let active = 0;
    let peak = 0;
    const concurrency = 2;

    await runPerItemStep<number>({
      sessionId,
      stepKey: 'ingest_urls',
      items,
      concurrency,
      run: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      },
      progressMessage: (done, failed, total) => `${done}/${total}`,
      assertNotCancelled: NOOP_CANCEL,
    });

    expect(peak).toBeLessThanOrEqual(concurrency);
  });

  it('progressMessage called with updated counters after each item', async () => {
    const items = ['a', 'b', 'c'];
    const messages: string[] = [];

    await runPerItemStep<string>({
      sessionId,
      stepKey: 'ingest_urls',
      items,
      run: async (item) => {
        if (item === 'b') throw new Error('x');
      },
      progressMessage: (done, failed, total) => {
        const msg = `${done}/${total}, ${failed}`;
        messages.push(msg);
        return msg;
      },
      assertNotCancelled: NOOP_CANCEL,
    });

    // Sequential (default concurrency=1) — 3 per-item 'running' updates
    // + 1 final 'done' update = 4 total calls.
    expect(messages).toHaveLength(4);
    // Final message reflects 2 succeeded, 1 failed, 3 total.
    expect(messages[messages.length - 1]).toBe('2/3, 1');
    // The last running update (before done) should also hold the final counts.
    expect(messages[messages.length - 2]).toBe('2/3, 1');
  });
});
