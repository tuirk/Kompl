/**
 * POST /api/compile/retry — same-session idempotency
 *
 * Regression: pre-fix, a same-session retry double-click re-ran
 * resetForRetry (clobbering mid-progress step state of a pipeline that
 * had already picked up from the first retry) and re-fired
 * triggerSessionCompile.
 *
 * Fix: same-session replay returns 200 { already_running: true } and skips
 * resetForRetry + the n8n trigger.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCompileProgress, getCompileProgress, getDb } from '../lib/db';
import { COMPILE_STEP_KEYS } from '../lib/compile-steps';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

vi.mock('../lib/trigger-n8n', () => ({
  triggerSessionCompile: vi.fn(async () => ({ ok: true })),
}));

import { POST } from '../app/api/compile/retry/route';
import { triggerSessionCompile } from '../lib/trigger-n8n';

describe('POST /api/compile/retry — same-session idempotency', () => {
  let handle: TestDbHandle;
  const sessionId = 'session-retry-idempotent';

  beforeEach(() => {
    handle = setupTestDb();
    vi.mocked(triggerSessionCompile).mockClear();
    vi.mocked(triggerSessionCompile).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    handle.cleanup();
  });

  function post(body: unknown): Request {
    return new Request('http://localhost/api/compile/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function seedFailedSession(): void {
    createCompileProgress(sessionId, 3);
    // Typical mid-pipeline failure after a recompile/legacy-confirm session:
    // prelude steps marked 'done-but-skipped' (per v18 backfill) so
    // resetForRetry doesn't wipe already-done compile steps. Then extract
    // done, resolve failed, rest pending.
    const PRELUDE = new Set(['health_check', 'ingest_files', 'ingest_urls', 'ingest_texts']);
    const steps: Record<string, { status: string; detail?: string }> = {};
    for (const key of COMPILE_STEP_KEYS) {
      steps[key] = { status: PRELUDE.has(key) ? 'done' : 'pending' };
    }
    steps.extract = { status: 'done' };
    steps.resolve = { status: 'failed', detail: 'mock failure' };
    getDb()
      .prepare(
        `UPDATE compile_progress
            SET status='failed',
                current_step='resolve',
                error='mock failure',
                started_at=datetime('now', '-1 minutes'),
                steps=?
          WHERE session_id=?`
      )
      .run(JSON.stringify(steps), sessionId);
  }

  it('double-click retry returns 200 already_running, does not re-reset progress, fires n8n once', async () => {
    seedFailedSession();

    // First retry — resets failed+pending steps, fires n8n.
    const res1 = await POST(post({ session_id: sessionId }));
    const body1 = (await res1.json()) as {
      session_id: string;
      status: string;
      already_running?: boolean;
    };
    expect(res1.status).toBe(200);
    expect(body1.session_id).toBe(sessionId);
    expect(body1.status).toBe('retrying');
    expect(body1.already_running).toBeUndefined();
    expect(triggerSessionCompile).toHaveBeenCalledTimes(1);

    const cp1 = getCompileProgress(sessionId)!;
    expect(cp1.status).toBe('queued');
    const steps1 = JSON.parse(cp1.steps) as Record<string, { status: string }>;
    expect(steps1.extract.status).toBe('done'); // preserved
    expect(steps1.resolve.status).toBe('pending'); // reset

    // Simulate n8n picking up the retry: status=running, started_at updated,
    // resolve now mid-progress. Prelude stays 'done' (per v18 pattern).
    const PRELUDE = new Set(['health_check', 'ingest_files', 'ingest_urls', 'ingest_texts']);
    const midSteps: Record<string, { status: string }> = {};
    for (const key of COMPILE_STEP_KEYS) {
      midSteps[key] = { status: PRELUDE.has(key) ? 'done' : 'pending' };
    }
    midSteps.extract = { status: 'done' };
    midSteps.resolve = { status: 'running' };
    getDb()
      .prepare(
        `UPDATE compile_progress
            SET status='running',
                started_at=datetime('now'),
                current_step='resolve',
                steps=?
          WHERE session_id=?`
      )
      .run(JSON.stringify(midSteps), sessionId);

    // Second retry — same session — must be idempotent.
    const res2 = await POST(post({ session_id: sessionId }));
    const body2 = (await res2.json()) as {
      session_id: string;
      status: string;
      already_running?: boolean;
    };
    expect(res2.status).toBe(200);
    expect(body2.session_id).toBe(sessionId);
    expect(body2.status).toBe('retrying');
    expect(body2.already_running).toBe(true);

    // Step state preserved — THE regression guard.
    const cp2 = getCompileProgress(sessionId)!;
    expect(cp2.status).toBe('running');
    expect(cp2.started_at).not.toBeNull();
    expect(cp2.current_step).toBe('resolve');
    const steps2 = JSON.parse(cp2.steps) as Record<string, { status: string }>;
    expect(steps2.extract.status).toBe('done');
    expect(steps2.resolve.status).toBe('running');

    // n8n not fired again.
    expect(triggerSessionCompile).toHaveBeenCalledTimes(1);
  });
});
