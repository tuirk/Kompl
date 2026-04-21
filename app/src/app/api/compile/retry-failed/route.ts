/**
 * POST /api/compile/retry-failed
 *
 * Phase 4 — per-item retry. Different shape from `/api/compile/retry`:
 *   - /retry resumes a session-level failure from the first non-done step.
 *     It's a no-op when compile_progress.status='completed'.
 *   - /retry-failed targets a session that LOOKS completed but has
 *     collect_staging.status='failed' rows (individual items that were
 *     skipped inside ingest_urls/files/texts). Flips those rows back to
 *     'pending', resets compile_progress so the orchestrator runs again,
 *     and re-fires n8n. The prelude gate in runCompilePipeline naturally
 *     picks up only the flipped rows; already-ingested items stay
 *     status='ingested' and are ignored.
 *
 * Ghost-row fix: for URL-connector retryable rows, matching
 *   ingest_failures rows (session_id + source_url) are deleted in the
 *   same transaction as the staging flip. If the retry fails again,
 *   ingest-urls re-inserts them. Without this delete, successful retry
 *   leaves stale /api/sources/failures + saved-links wiki rows.
 *
 * Body: { session_id: string }
 * Response:
 *   200 { retried: N, status: 'retrying' }    — n8n triggered
 *   200 { retried: 0, status: 'noop' }         — nothing to retry
 *   400 { error: 'invalid_json' | 'session_id required' }
 *   404 { error: 'no_progress_record' }
 *   409 { error: 'pipeline_active', status }   — session is queued/running
 *   502/504 { error, upstream_status }         — n8n trigger failure
 */
import { NextResponse } from 'next/server';
import {
  COMPILE_STEP_KEYS,
} from '@/lib/compile-steps';
import {
  deleteIngestFailuresBySourceUrls,
  getCompileProgress,
  getDb,
  getRunningCompileSession,
} from '@/lib/db';
import { triggerSessionCompile } from '@/lib/trigger-n8n';

interface StagingMini {
  stage_id: string;
  connector: string;
  payload: string;
}

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const { session_id } = rawBody as { session_id?: string };
  if (!session_id?.trim()) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }

  const progress = getCompileProgress(session_id);
  if (!progress) {
    return NextResponse.json({ error: 'no_progress_record' }, { status: 404 });
  }
  if (progress.status === 'queued' || progress.status === 'running') {
    return NextResponse.json(
      { error: 'pipeline_active', status: progress.status },
      { status: 409 }
    );
  }

  // Global concurrency gate: block retry if a DIFFERENT session is active.
  const active = getRunningCompileSession();
  if (active && active.session_id !== session_id) {
    return NextResponse.json(
      {
        error_code: 'session_in_progress',
        error: 'Another compile session is already running.',
        active_session_id: active.session_id,
      },
      { status: 409 }
    );
  }

  const db = getDb();
  const failedRows = db
    .prepare(
      `SELECT stage_id, connector, payload
         FROM collect_staging
        WHERE session_id = ?
          AND status     = 'failed'
          AND included   = 1`
    )
    .all(session_id) as StagingMini[];

  if (failedRows.length === 0) {
    return NextResponse.json({ retried: 0, status: 'noop' });
  }

  // Extract source URLs from URL-connector payloads so we can delete the
  // stale ingest_failures rows. File/text retries don't have ingest_failures
  // rows to clean (those steps only write activity_log on failure).
  const urlsToClean: string[] = [];
  for (const row of failedRows) {
    if (row.connector !== 'url') continue;
    try {
      const payload = JSON.parse(row.payload) as { url?: string };
      if (typeof payload.url === 'string' && payload.url) {
        urlsToClean.push(payload.url);
      }
    } catch {
      // Malformed payload — skip ghost-row cleanup for this one but still
      // proceed with the staging flip; the row will be re-processed.
    }
  }

  const resetSteps = JSON.stringify(
    Object.fromEntries(COMPILE_STEP_KEYS.map((k) => [k, { status: 'pending' }]))
  );

  db.transaction(() => {
    deleteIngestFailuresBySourceUrls(session_id, urlsToClean);

    db.prepare(
      `UPDATE collect_staging
          SET status        = 'pending',
              error_code    = NULL,
              error_message = NULL
        WHERE session_id = ?
          AND status     = 'failed'
          AND included   = 1`
    ).run(session_id);

    // Reset compile_progress. Intentionally DOES NOT use resetForRetry()
    // — that helper returns early when status='completed' (no non-done
    // step to reset-from). We need an unconditional full reset here so
    // the orchestrator re-enters the pipeline on the next n8n trigger.
    // Preserves started_at so the overall session timer stays anchored.
    db.prepare(
      `UPDATE compile_progress
          SET status       = 'queued',
              current_step = NULL,
              error        = NULL,
              completed_at = NULL,
              steps        = ?
        WHERE session_id   = ?`
    ).run(resetSteps, session_id);
  })();

  const trigger = await triggerSessionCompile(session_id);
  if (!trigger.ok) {
    const httpStatus = trigger.reason === 'n8n_timeout' ? 504 : 502;
    return NextResponse.json(
      { error: trigger.reason, upstream_status: trigger.upstreamStatus },
      { status: httpStatus }
    );
  }

  return NextResponse.json({ retried: failedRows.length, status: 'retrying' });
}
