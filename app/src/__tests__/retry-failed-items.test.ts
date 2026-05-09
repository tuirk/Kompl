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
  countFailedDraftPlansBySession,
  countUnextractedSourcesBySession,
  createCompileProgress,
  getCompileProgress,
  getIngestFailures,
  getStagingBySession,
  insertCollectStaging,
  insertExtraction,
  insertIngestFailure,
  insertPagePlan,
  insertSource,
  markStagingFailed,
  markStagingIngested,
  updatePlanStatus,
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

  it('retries failed page_plans on a completed session with no failed staging rows', async () => {
    // Seed scenario: completed session, all staging ingested, but
    // page_plans contains a mix of drafted + failed rows. This is the
    // "Writing pages — 0 drafts generated, 10 failed" path: draft step
    // wrote step.status='done' regardless of per-item failures so commit
    // could run on what succeeded, leaving the session at status=completed
    // with no session-level retry path. The button must surface here.
    createCompileProgress(sessionId, 1);
    getDb()
      .prepare(
        `UPDATE compile_progress
            SET status='completed',
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
    // 1 ingested staging row (no failed staging — draft retry should still proceed)
    const okStageId = randomUUID();
    insertCollectStaging({
      stage_id: okStageId,
      session_id: sessionId,
      connector: 'url',
      payload: { url: 'https://ok.example.com', display: { hostname: 'ok.example.com' } },
    });
    markStagingIngested(okStageId, `src-${okStageId.slice(0, 8)}`);
    // 1 drafted plan (success, must stay untouched) + 2 failed plans
    const draftedPlanId = randomUUID();
    insertPagePlan({
      plan_id: draftedPlanId,
      session_id: sessionId,
      title: 'Drafted Page',
      page_type: 'concept',
      action: 'create',
      source_ids: [`src-${okStageId.slice(0, 8)}`],
    });
    updatePlanStatus(draftedPlanId, 'drafted');

    const failedPlanA = randomUUID();
    insertPagePlan({
      plan_id: failedPlanA,
      session_id: sessionId,
      title: 'Failed Page A',
      page_type: 'concept',
      action: 'create',
      source_ids: [`src-${okStageId.slice(0, 8)}`],
    });
    updatePlanStatus(failedPlanA, 'failed');

    const failedPlanB = randomUUID();
    insertPagePlan({
      plan_id: failedPlanB,
      session_id: sessionId,
      title: 'Failed Page B',
      page_type: 'concept',
      action: 'create',
      source_ids: [`src-${okStageId.slice(0, 8)}`],
    });
    updatePlanStatus(failedPlanB, 'failed');

    expect(countFailedDraftPlansBySession(sessionId)).toBe(2);

    const res = await POST(post({ session_id: sessionId }));
    const body = (await res.json()) as { retried: number; status: string };

    expect(res.status).toBe(200);
    expect(body).toEqual({ retried: 2, status: 'retrying' });

    // Failed plans stay 'failed' — orchestrator's draft step re-attempts
    // them (pendingDraftCount > 0 branch in run/route.ts). retry-failed
    // doesn't flip plan rows because the draft step itself reads them.
    const stillFailed = getDb()
      .prepare(`SELECT plan_id FROM page_plans WHERE session_id=? AND draft_status='failed'`)
      .all(sessionId) as { plan_id: string }[];
    expect(stillFailed).toHaveLength(2);

    // Drafted plan untouched
    const stillDrafted = getDb()
      .prepare(`SELECT plan_id FROM page_plans WHERE session_id=? AND draft_status='drafted'`)
      .all(sessionId) as { plan_id: string }[];
    expect(stillDrafted).toHaveLength(1);

    // compile_progress reset so orchestrator re-enters
    const cp = getCompileProgress(sessionId)!;
    expect(cp.status).toBe('queued');
    expect(cp.completed_at).toBeNull();
    expect(cp.started_at).toBe('2026-04-20 10:00:00');

    // n8n triggered exactly once
    expect(triggerSessionCompile).toHaveBeenCalledTimes(1);
    expect(triggerSessionCompile).toHaveBeenCalledWith(sessionId);
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

  it('unextracted source on completed session triggers retry', async () => {
    // Seed scenario: completed session, all step statuses 'done', 2 source
    // rows where only 1 has a matching `extractions` row, 1 committed
    // page_plan referencing the extracted source. The unextracted source
    // mirrors the per-source extract-failure shape (orchestrator tolerates
    // partial failures, only fails the session if EVERY source fails).
    // The committed plan must survive the retry (regression guard — earlier
    // draft of the plan wanted to clear plans here, which would clobber
    // the failed-draft retry path).
    createCompileProgress(sessionId, 1);
    getDb()
      .prepare(
        `UPDATE compile_progress
            SET status='completed',
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

    const extractedSrcId = `src-extracted-${randomUUID().slice(0, 8)}`;
    const unextractedSrcId = `src-unextracted-${randomUUID().slice(0, 8)}`;

    insertSource({
      source_id: extractedSrcId,
      title: 'Extracted source',
      source_type: 'url',
      source_url: 'https://ok.example.com',
      content_hash: 'hash-ok',
      file_path: `data/sources/${extractedSrcId}.md`,
      metadata: null,
      onboarding_session_id: sessionId,
    });
    insertSource({
      source_id: unextractedSrcId,
      title: 'Unextracted source',
      source_type: 'url',
      source_url: 'https://fail.example.com',
      content_hash: 'hash-fail',
      file_path: `data/sources/${unextractedSrcId}.md`,
      metadata: null,
      onboarding_session_id: sessionId,
    });
    // Only the first source gets an extractions row.
    insertExtraction({
      source_id: extractedSrcId,
      ner_output: { entities: [] },
      profile: 'plain',
      keyphrase_output: null,
      tfidf_output: null,
      llm_output: { summary: '' },
    });

    // 1 committed page_plan referencing the extracted source.
    const committedPlanId = randomUUID();
    insertPagePlan({
      plan_id: committedPlanId,
      session_id: sessionId,
      title: 'Committed Page',
      page_type: 'concept',
      action: 'create',
      source_ids: [extractedSrcId],
    });
    updatePlanStatus(committedPlanId, 'committed');

    expect(countUnextractedSourcesBySession(sessionId)).toBe(1);

    const res = await POST(post({ session_id: sessionId }));
    const body = (await res.json()) as { retried: number; status: string };

    expect(res.status).toBe(200);
    expect(body).toEqual({ retried: 1, status: 'retrying' });

    // Committed plan survives — endpoint MUST NOT touch page_plans (the
    // orchestrator's hasNewSources check decides re-plan, not this route).
    const survivingPlans = getDb()
      .prepare(`SELECT plan_id, draft_status FROM page_plans WHERE session_id=?`)
      .all(sessionId) as { plan_id: string; draft_status: string }[];
    expect(survivingPlans).toHaveLength(1);
    expect(survivingPlans[0].plan_id).toBe(committedPlanId);
    expect(survivingPlans[0].draft_status).toBe('committed');

    // compile_progress reset so orchestrator re-enters
    const cp = getCompileProgress(sessionId)!;
    expect(cp.status).toBe('queued');
    expect(cp.completed_at).toBeNull();
    expect(cp.started_at).toBe('2026-04-20 10:00:00');

    // n8n triggered exactly once
    expect(triggerSessionCompile).toHaveBeenCalledTimes(1);
    expect(triggerSessionCompile).toHaveBeenCalledWith(sessionId);
  });

  it('unextracted + failed-draft mix retries both without clobbering failed plans', async () => {
    // Same shape as above plus 2 page_plans with draft_status='failed'.
    // Total retried = 1 unextracted + 2 failed-drafts = 3. All three plan
    // rows (committed + 2 failed) must survive — clearing plans here would
    // break the failed-draft retry path (the orchestrator's draft step
    // re-attempts those failed plans on the next run).
    createCompileProgress(sessionId, 1);
    getDb()
      .prepare(
        `UPDATE compile_progress
            SET status='completed',
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

    const extractedSrcId = `src-extracted-${randomUUID().slice(0, 8)}`;
    const unextractedSrcId = `src-unextracted-${randomUUID().slice(0, 8)}`;

    insertSource({
      source_id: extractedSrcId,
      title: 'Extracted source',
      source_type: 'url',
      source_url: 'https://ok.example.com',
      content_hash: 'hash-ok',
      file_path: `data/sources/${extractedSrcId}.md`,
      metadata: null,
      onboarding_session_id: sessionId,
    });
    insertSource({
      source_id: unextractedSrcId,
      title: 'Unextracted source',
      source_type: 'url',
      source_url: 'https://fail.example.com',
      content_hash: 'hash-fail',
      file_path: `data/sources/${unextractedSrcId}.md`,
      metadata: null,
      onboarding_session_id: sessionId,
    });
    insertExtraction({
      source_id: extractedSrcId,
      ner_output: { entities: [] },
      profile: 'plain',
      keyphrase_output: null,
      tfidf_output: null,
      llm_output: { summary: '' },
    });

    const committedPlanId = randomUUID();
    insertPagePlan({
      plan_id: committedPlanId,
      session_id: sessionId,
      title: 'Committed Page',
      page_type: 'concept',
      action: 'create',
      source_ids: [extractedSrcId],
    });
    updatePlanStatus(committedPlanId, 'committed');

    const failedPlanA = randomUUID();
    insertPagePlan({
      plan_id: failedPlanA,
      session_id: sessionId,
      title: 'Failed Page A',
      page_type: 'concept',
      action: 'create',
      source_ids: [extractedSrcId],
    });
    updatePlanStatus(failedPlanA, 'failed');

    const failedPlanB = randomUUID();
    insertPagePlan({
      plan_id: failedPlanB,
      session_id: sessionId,
      title: 'Failed Page B',
      page_type: 'concept',
      action: 'create',
      source_ids: [extractedSrcId],
    });
    updatePlanStatus(failedPlanB, 'failed');

    expect(countUnextractedSourcesBySession(sessionId)).toBe(1);
    expect(countFailedDraftPlansBySession(sessionId)).toBe(2);

    const res = await POST(post({ session_id: sessionId }));
    const body = (await res.json()) as { retried: number; status: string };

    expect(res.status).toBe(200);
    expect(body).toEqual({ retried: 3, status: 'retrying' });

    // All three plans survive — committed + 2 failed.
    const survivingPlans = getDb()
      .prepare(`SELECT plan_id, draft_status FROM page_plans WHERE session_id=? ORDER BY plan_id`)
      .all(sessionId) as { plan_id: string; draft_status: string }[];
    expect(survivingPlans).toHaveLength(3);
    const byStatus = survivingPlans.reduce<Record<string, number>>((acc, p) => {
      acc[p.draft_status] = (acc[p.draft_status] ?? 0) + 1;
      return acc;
    }, {});
    expect(byStatus.committed).toBe(1);
    expect(byStatus.failed).toBe(2);

    // compile_progress reset
    const cp = getCompileProgress(sessionId)!;
    expect(cp.status).toBe('queued');
    expect(cp.completed_at).toBeNull();
    expect(cp.started_at).toBe('2026-04-20 10:00:00');

    expect(triggerSessionCompile).toHaveBeenCalledTimes(1);
    expect(triggerSessionCompile).toHaveBeenCalledWith(sessionId);
  });
});
