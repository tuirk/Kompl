/**
 * Phase 4 — /api/compile/retry-failed
 *
 * Seeds a session where the pipeline completed with per-item failures
 * (mix of ingested + failed staging rows, matching ingest_failures rows
 * for the URL ones), stubs triggerSessionCompile, and asserts:
 *   - failed rows flip to 'pending' with cleared error fields
 *   - ingested rows untouched
 *   - matching ingest_failures rows deleted (ghost-row cleanup)
 *   - compile_progress reset: status='queued', all steps 'pending',
 *     started_at preserved, completed_at/error/current_step cleared
 *   - n8n trigger called exactly once
 *   - idempotent: second call returns {retried:0, status:'noop'} and
 *     does not re-trigger
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createCompileProgress,
  getCompileProgress,
  getIngestFailures,
  getStagingBySession,
  insertCollectStaging,
  insertIngestFailure,
  markStagingFailed,
  markStagingIngested,
  getDb,
} from '../lib/db';
import { COMPILE_STEP_KEYS } from '../lib/compile-steps';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

// Mock triggerSessionCompile so the test doesn't try to hit n8n.
vi.mock('../lib/trigger-n8n', () => ({
  triggerSessionCompile: vi.fn(async () => ({ ok: true })),
}));

import { POST } from '../app/api/compile/retry-failed/route';
import { triggerSessionCompile } from '../lib/trigger-n8n';

describe('POST /api/compile/retry-failed', () => {
  let handle: TestDbHandle;
  const sessionId = 'session-retry-failed';

  beforeEach(() => {
    handle = setupTestDb();
    vi.mocked(triggerSessionCompile).mockClear();
    vi.mocked(triggerSessionCompile).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    handle.cleanup();
  });

  function seedScenario(): {
    ingestedStageIds: string[];
    failedStageIds: string[];
    failedUrls: string[];
  } {
    // compile_progress starts queued; we mark it completed + freeze started_at
    createCompileProgress(sessionId, 3);
    getDb()
      .prepare(
        `UPDATE compile_progress
            SET status='completed',
                current_step='schema',
                started_at='2026-04-20 10:00:00',
                completed_at='2026-04-20 10:05:00',
                steps=?
          WHERE session_id=?`
      )
      .run(
        JSON.stringify(
          Object.fromEntries(COMPILE_STEP_KEYS.map((k) => [k, { status: 'done' }]))
        ),
        sessionId
      );

    // 2 URLs that succeeded (status='ingested')
    const ingestedIds: string[] = [];
    for (const u of ['https://ok-a.example.com', 'https://ok-b.example.com']) {
      const stageId = randomUUID();
      ingestedIds.push(stageId);
      insertCollectStaging({
        stage_id: stageId,
        session_id: sessionId,
        connector: 'url',
        payload: { url: u, display: { hostname: new URL(u).hostname } },
      });
      markStagingIngested(stageId, `src-${stageId.slice(0, 8)}`);
    }

    // 1 URL that failed + matching ingest_failures row
    const failedUrl = 'https://fail-c.example.com';
    const failedStageId = randomUUID();
    insertCollectStaging({
      stage_id: failedStageId,
      session_id: sessionId,
      connector: 'url',
      payload: { url: failedUrl, display: { hostname: 'fail-c.example.com' } },
    });
    markStagingFailed(failedStageId, 'firecrawl_timeout', 'Firecrawl hit 30s timeout');
    insertIngestFailure({
      failure_id: randomUUID(),
      source_url: failedUrl,
      title_hint: null,
      date_saved: null,
      error: 'firecrawl_timeout',
      source_type: 'url',
      metadata: null,
      session_id: sessionId,
    });

    return {
      ingestedStageIds: ingestedIds,
      failedStageIds: [failedStageId],
      failedUrls: [failedUrl],
    };
  }

  function post(body: unknown): Request {
    return new Request('http://localhost/api/compile/retry-failed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('flips failed rows, cleans ingest_failures ghosts, resets compile_progress, triggers n8n', async () => {
    const seeded = seedScenario();

    const res = await POST(post({ session_id: sessionId }));
    const body = (await res.json()) as { retried: number; status: string };

    expect(res.status).toBe(200);
    expect(body).toEqual({ retried: 1, status: 'retrying' });

    // Failed row flipped, error cleared
    const rows = getStagingBySession(sessionId);
    const flipped = rows.find((r) => r.stage_id === seeded.failedStageIds[0])!;
    expect(flipped.status).toBe('pending');
    expect(flipped.error_code).toBeNull();
    expect(flipped.error_message).toBeNull();

    // Ingested rows untouched
    for (const sid of seeded.ingestedStageIds) {
      const ingested = rows.find((r) => r.stage_id === sid)!;
      expect(ingested.status).toBe('ingested');
    }

    // Ghost row deleted
    const remainingFailures = getIngestFailures().filter(
      (f) => f.source_url === seeded.failedUrls[0]
    );
    expect(remainingFailures).toHaveLength(0);

    // compile_progress reset
    const cp = getCompileProgress(sessionId)!;
    expect(cp.status).toBe('queued');
    expect(cp.current_step).toBeNull();
    expect(cp.error).toBeNull();
    expect(cp.completed_at).toBeNull();
    expect(cp.started_at).toBe('2026-04-20 10:00:00'); // preserved
    const steps = JSON.parse(cp.steps) as Record<string, { status: string }>;
    for (const key of COMPILE_STEP_KEYS) {
      expect(steps[key].status).toBe('pending');
    }

    // n8n triggered exactly once
    expect(triggerSessionCompile).toHaveBeenCalledTimes(1);
    expect(triggerSessionCompile).toHaveBeenCalledWith(sessionId);
  });

  it('is idempotent — second call after retry completes is a no-op', async () => {
    seedScenario();

    // First call: flips the failed row, triggers n8n (compile_progress → queued)
    const res1 = await POST(post({ session_id: sessionId }));
    expect((await res1.json()).retried).toBe(1);
    expect(triggerSessionCompile).toHaveBeenCalledTimes(1);

    // Simulate the pipeline running and completing the retry: n8n would
    // flip status from queued → running → completed. The failed row got
    // re-ingested (flip to 'ingested'). User clicks Retry-failed again
    // on the now-completed session.
    getDb()
      .prepare(`UPDATE compile_progress SET status='completed' WHERE session_id=?`)
      .run(sessionId);
    getDb()
      .prepare(`UPDATE collect_staging SET status='ingested' WHERE session_id=? AND status='pending'`)
      .run(sessionId);

    // Second call finds zero 'failed' rows → noop, no n8n trigger
    const res2 = await POST(post({ session_id: sessionId }));
    const body2 = (await res2.json()) as { retried: number; status: string };
    expect(res2.status).toBe(200);
    expect(body2).toEqual({ retried: 0, status: 'noop' });
    expect(triggerSessionCompile).toHaveBeenCalledTimes(1); // not called again
  });

  it('returns 404 when session_id has no compile_progress row', async () => {
    const res = await POST(post({ session_id: 'no-such-session' }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('no_progress_record');
    expect(triggerSessionCompile).not.toHaveBeenCalled();
  });

  it('returns 409 when a pipeline is already queued or running', async () => {
    seedScenario();
    getDb()
      .prepare(`UPDATE compile_progress SET status='running' WHERE session_id=?`)
      .run(sessionId);

    const res = await POST(post({ session_id: sessionId }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; status: string };
    expect(body.error).toBe('pipeline_active');
    expect(body.status).toBe('running');
    expect(triggerSessionCompile).not.toHaveBeenCalled();
  });

  it('returns 400 on missing session_id', async () => {
    const res = await POST(post({}));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('session_id required');
    expect(triggerSessionCompile).not.toHaveBeenCalled();
  });

  it('maps n8n trigger failure to 502/504', async () => {
    seedScenario();
    vi.mocked(triggerSessionCompile).mockResolvedValueOnce({
      ok: false,
      reason: 'n8n_timeout',
    });

    const res = await POST(post({ session_id: sessionId }));
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('n8n_timeout');
  });
});
