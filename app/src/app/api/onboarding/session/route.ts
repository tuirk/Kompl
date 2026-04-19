/**
 * DELETE /api/onboarding/session?session_id=X
 *
 * Discards an in-progress onboarding session: cancels any running compile,
 * unlinks staged upload files, deletes staging rows and compile_progress.
 *
 * Order of operations is deliberate:
 *   1. If compile is queued/running, flip compile_progress.status='cancelled'
 *      and wait briefly (5s) for the orchestrator to acknowledge at the
 *      next assertNotCancelled boundary. If the orchestrator is mid-commit
 *      (the only step that cannot be cancelled per the existing cancel
 *      route's contract), return 409 — user must wait for commit to finish
 *      before discarding.
 *   2. Inside a transaction: delete staging rows (collecting file_paths),
 *      delete compile_progress, DO NOT touch sources rows (legacy flows
 *      may have real sources with onboarding_session_id pointing here —
 *      dropping them would orphan extracted pages).
 *   3. Post-transaction: fs.unlink staged upload files (best-effort,
 *      Promise.allSettled, ignore ENOENT).
 *
 * Idempotent — calling twice on the same session returns a second response
 * with zero counts in all fields.
 *
 * Response:
 *   {
 *     session_id: string;
 *     removed: {
 *       staging_rows: number;
 *       files_unlinked: number;
 *       progress_cleared: boolean;
 *     };
 *   }
 */

import { promises as fsPromises } from 'node:fs';
import { NextResponse } from 'next/server';

import {
  cancelCompileProgress,
  deleteStagingBySession,
  getCompileProgress,
  getDb,
} from '../../../../lib/db';

const CANCEL_WAIT_MS = 5_000;
const CANCEL_POLL_MS = 250;

async function waitForCancellation(session_id: string): Promise<'cancelled' | 'commit_lock' | 'timeout'> {
  const deadline = Date.now() + CANCEL_WAIT_MS;
  while (Date.now() < deadline) {
    const p = getCompileProgress(session_id);
    if (!p) return 'cancelled';
    if (p.status === 'cancelled' || p.status === 'completed' || p.status === 'failed') {
      return 'cancelled';
    }
    if (p.current_step === 'commit') {
      // Match the existing /api/compile/cancel rule: commit is a sync txn,
      // can't abort mid-flight. Signal the caller.
      return 'commit_lock';
    }
    await new Promise((r) => setTimeout(r, CANCEL_POLL_MS));
  }
  return 'timeout';
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const session_id = url.searchParams.get('session_id');

  if (!session_id) {
    return NextResponse.json({ error: 'missing query param: session_id' }, { status: 422 });
  }

  // Step 1: coordinate with any running compile.
  const progress = getCompileProgress(session_id);
  const needsCancel =
    progress !== null && (progress.status === 'queued' || progress.status === 'running');
  if (needsCancel) {
    cancelCompileProgress(session_id, 'Discarded by user');
    const waitResult = await waitForCancellation(session_id);
    if (waitResult === 'commit_lock') {
      return NextResponse.json(
        {
          error: 'commit_in_progress',
          message:
            'Compile is mid-commit and cannot be cancelled. Wait for it to finish, then retry discard.',
        },
        { status: 409 }
      );
    }
    // 'timeout' is non-fatal — the orchestrator will see the cancel flag
    // at its next boundary and exit cleanly. We proceed to cleanup below.
  }

  // Step 2: transactional cleanup.
  const db = getDb();
  type CleanupResult = { staging_rows: number; file_paths: string[]; progress_cleared: boolean };

  const txn = db.transaction((): CleanupResult => {
    const staging = deleteStagingBySession(session_id);
    const progressDelResult = db
      .prepare('DELETE FROM compile_progress WHERE session_id = ?')
      .run(session_id);
    return {
      staging_rows: staging.deleted,
      file_paths: staging.file_paths,
      progress_cleared: (progressDelResult.changes as number) > 0,
    };
  });

  let result: CleanupResult;
  try {
    result = txn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    return NextResponse.json({ error: `cleanup_failed: ${msg}` }, { status: 500 });
  }

  // Step 3: best-effort file unlinks post-commit. Ignore ENOENT since the
  // file may have already been unlinked (orphan cleanup, partial prior delete).
  const unlinkResults = await Promise.allSettled(
    result.file_paths.map((p) => fsPromises.unlink(p))
  );
  const files_unlinked = unlinkResults.filter((r) => r.status === 'fulfilled').length;

  return NextResponse.json(
    {
      session_id,
      removed: {
        staging_rows: result.staging_rows,
        files_unlinked,
        progress_cleared: result.progress_cleared,
      },
    },
    { status: 200 }
  );
}
