/**
 * POST /api/sources/[source_id]/recompile — same-session idempotency
 *
 * Regression: pre-fix, a same-session recompile re-ran createCompileProgress
 * (wiping the running pipeline's step state) and re-fired
 * triggerSessionCompile.
 *
 * Fix: same-session replay returns 200 { already_running: true } and skips
 * createCompileProgress + the n8n trigger.
 *
 * Note: resetSourceForRecompile + logActivity run ABOVE the concurrency
 * guard (deliberate — supports "two sources, same running session" where
 * source-B flips to pending so the running pipeline picks it up). That
 * ordering is unchanged by this fix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCompileProgress, getDb, getSource } from '../lib/db';
import { setupTestDb, seedSource, type TestDbHandle } from './helpers/test-db';

vi.mock('../lib/trigger-n8n', () => ({
  triggerSessionCompile: vi.fn(async () => ({ ok: true })),
}));

import { POST } from '../app/api/sources/[source_id]/recompile/route';
import { triggerSessionCompile } from '../lib/trigger-n8n';

describe('POST /api/sources/[source_id]/recompile — same-session idempotency', () => {
  let handle: TestDbHandle;
  const sessionId = 'session-recompile-idempotent';
  const sourceId = 'src-recompile-test';

  beforeEach(() => {
    handle = setupTestDb();
    vi.mocked(triggerSessionCompile).mockClear();
    vi.mocked(triggerSessionCompile).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    handle.cleanup();
  });

  function post(): Request {
    return new Request(
      `http://localhost/api/sources/${sourceId}/recompile`,
      { method: 'POST' }
    );
  }

  function postWithParams() {
    return POST(post(), { params: Promise.resolve({ source_id: sourceId }) });
  }

  it('double-click recompile returns 200 already_running, preserves step state, fires n8n once', async () => {
    seedSource(handle.db, {
      source_id: sourceId,
      compile_status: 'failed',
      onboarding_session_id: sessionId,
    });

    // First POST — resets source, creates compile_progress, fires n8n.
    const res1 = await postWithParams();
    const body1 = (await res1.json()) as {
      source_id: string;
      session_id: string;
      status: string;
      already_running?: boolean;
    };
    expect(res1.status).toBe(200);
    expect(body1.source_id).toBe(sourceId);
    expect(body1.session_id).toBe(sessionId);
    expect(body1.status).toBe('queued');
    expect(body1.already_running).toBeUndefined();
    expect(triggerSessionCompile).toHaveBeenCalledTimes(1);

    expect(getSource(sourceId)!.compile_status).toBe('pending');
    const cp1 = getCompileProgress(sessionId)!;
    expect(cp1.status).toBe('queued');

    // Simulate n8n picking up: status='running', started_at set, partial steps.
    const partialSteps = JSON.stringify({
      extract: { status: 'done' },
      resolve: { status: 'running' },
      match: { status: 'pending' },
      plan: { status: 'pending' },
      draft: { status: 'pending' },
      crossref: { status: 'pending' },
      commit: { status: 'pending' },
      schema: { status: 'pending' },
    });
    getDb()
      .prepare(
        `UPDATE compile_progress
            SET status='running',
                started_at=datetime('now'),
                current_step='resolve',
                steps=?
          WHERE session_id=?`
      )
      .run(partialSteps, sessionId);

    // Second POST on same source — must be idempotent.
    const res2 = await postWithParams();
    const body2 = (await res2.json()) as {
      source_id: string;
      session_id: string;
      status: string;
      already_running?: boolean;
    };
    expect(res2.status).toBe(200);
    expect(body2.source_id).toBe(sourceId);
    expect(body2.session_id).toBe(sessionId);
    expect(body2.status).toBe('queued');
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
