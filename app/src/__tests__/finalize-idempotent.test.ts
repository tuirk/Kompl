/**
 * POST /api/onboarding/finalize — same-session idempotency
 *
 * Regression: pre-fix, a same-session double-submit re-ran
 * createCompileProgress (ON CONFLICT DO UPDATE SET steps = excluded.steps
 * wipes the running pipeline's step state) and re-fired triggerSessionCompile
 * (n8n has no webhook dedupe — starts a second workflow execution).
 *
 * Fix: same-session replay returns 200 { already_running: true } and skips
 * all side effects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  getCompileProgress,
  getDb,
  insertCollectStaging,
} from '../lib/db';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

vi.mock('../lib/trigger-n8n', () => ({
  triggerSessionCompile: vi.fn(async () => ({ ok: true })),
}));

import { POST } from '../app/api/onboarding/finalize/route';
import { triggerSessionCompile } from '../lib/trigger-n8n';

describe('POST /api/onboarding/finalize — same-session idempotency', () => {
  let handle: TestDbHandle;
  const sessionId = 'session-finalize-idempotent';

  beforeEach(() => {
    handle = setupTestDb();
    vi.mocked(triggerSessionCompile).mockClear();
    vi.mocked(triggerSessionCompile).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    handle.cleanup();
  });

  function post(body: unknown): Request {
    return new Request('http://localhost/api/onboarding/finalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  function seedThreeStagingRows(): void {
    for (let i = 0; i < 3; i++) {
      insertCollectStaging({
        stage_id: randomUUID(),
        session_id: sessionId,
        connector: 'text',
        payload: { markdown: `sample ${i}`, display: { kind: 'text' } },
      });
    }
  }

  it('double-submit returns 200 already_running, preserves step state, fires n8n exactly once', async () => {
    seedThreeStagingRows();

    // First POST — creates compile_progress (queued), fires n8n.
    const res1 = await POST(post({ session_id: sessionId }));
    const body1 = (await res1.json()) as {
      session_id: string;
      queued: number;
      already_running?: boolean;
    };
    expect(res1.status).toBe(200);
    expect(body1.session_id).toBe(sessionId);
    expect(body1.queued).toBe(3);
    expect(body1.already_running).toBeUndefined();
    expect(triggerSessionCompile).toHaveBeenCalledTimes(1);

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

    // Second POST — same session — must be idempotent.
    const res2 = await POST(post({ session_id: sessionId }));
    const body2 = (await res2.json()) as {
      session_id: string;
      queued: number;
      already_running?: boolean;
    };
    expect(res2.status).toBe(200);
    expect(body2.session_id).toBe(sessionId);
    expect(body2.queued).toBe(3);
    expect(body2.already_running).toBe(true);

    // Step state preserved — THE regression guard.
    const cp = getCompileProgress(sessionId)!;
    expect(cp.status).toBe('running');
    expect(cp.started_at).not.toBeNull();
    expect(cp.current_step).toBe('resolve');
    const steps = JSON.parse(cp.steps) as Record<string, { status: string }>;
    expect(steps.extract.status).toBe('done');
    expect(steps.resolve.status).toBe('running');
    expect(steps.match.status).toBe('pending');

    // n8n not fired again.
    expect(triggerSessionCompile).toHaveBeenCalledTimes(1);
  });
});
