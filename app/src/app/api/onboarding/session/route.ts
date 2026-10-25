/**
 * DELETE /api/onboarding/session?session_id=X
 *
 * Discards an in-progress onboarding session: cancels any running compile,
 * unlinks staged upload files, deletes staging rows and compile_progress.
 *
 * Order of operations is deliberate:
 *   1. If compile is queued/running and its commit step has started (running
 *      or done), return 409 BEFORE touching anything: the same rule as
 *      /api/compile/cancel (commit writes pages and cannot be aborted). The
 *      user waits for commit to finish, then discards.
 *   2. Otherwise flip compile_progress.status='cancelled' and wait briefly
 *      (5s) for the pipeline to stop at its next step boundary. It cannot
 *      reach commit any more: the boundary before commit sees the cancel.
 *   3. Inside a transaction: re-check step 1 (a Retry may have restarted the
 *      session during the wait), delete staging rows (collecting file_paths),
 *      delete compile_progress, DO NOT touch sources rows (legacy flows
 *      may have real sources with onboarding_session_id pointing here —
 *      dropping them would orphan extracted pages). Pages and the outbox
 *      are never touched.
 *   4. Post-transaction: fs.unlink staged upload files (best-effort,
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
  type CompileProgressRow,
} from '../../../../lib/db';
import { isCompileRunLive } from '../../../../lib/compile/compile-run';

const CANCEL_WAIT_MS = 5_000;
const CANCEL_POLL_MS = 250;

function isActive(p: CompileProgressRow | null): p is CompileProgressRow {
  return p !== null && (p.status === 'queued' || p.status === 'running');
}

/** An active session whose commit step is running or done (see step 1). */
function commitLocked(p: CompileProgressRow | null): boolean {
  if (!isActive(p)) return false;
  let commit: string | undefined;
  try {
    commit = (JSON.parse(p.steps) as Record<string, { status?: string }>).commit?.status;
  } catch {
    // Unreadable steps: no pipeline could have written commit 'running'.
    return false;
  }
  return commit === 'running' || commit === 'done';
}

function commitInProgress(): NextResponse {
  return NextResponse.json(
    {
      error: 'commit_in_progress',
      message:
        'Compile is mid-commit and cannot be cancelled. Wait for it to finish, then retry discard.',
    },
    { status: 409 }
  );
}

/**
 * Waits for the cancelled pipeline to exit. On timeout we go on anyway: the
 * pipeline stops at its next boundary (cancelled, or its row gone) and never
 * starts commit.
 */
async function waitForPipelineExit(session_id: string): Promise<void> {
  const deadline = Date.now() + CANCEL_WAIT_MS;
  while (isCompileRunLive(session_id) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, CANCEL_POLL_MS));
  }
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const session_id = url.searchParams.get('session_id');

  if (!session_id) {
    return NextResponse.json({ error: 'missing query param: session_id' }, { status: 422 });
  }

  // Steps 1-2: coordinate with any running compile. No await between the
  // check and the cancel, so the pipeline cannot start commit in between.
  const progress = getCompileProgress(session_id);
  if (commitLocked(progress)) return commitInProgress();
  if (isActive(progress)) {
    cancelCompileProgress(session_id, 'Discarded by user');
    await waitForPipelineExit(session_id);
  }

  // Step 3: transactional cleanup.
  const db = getDb();
  type CleanupResult = { staging_rows: number; file_paths: string[]; progress_cleared: boolean };

  const txn = db.transaction((): CleanupResult | null => {
    if (commitLocked(getCompileProgress(session_id))) return null;
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

  let result: CleanupResult | null;
  try {
    result = txn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    return NextResponse.json({ error: `cleanup_failed: ${msg}` }, { status: 500 });
  }
  if (result === null) return commitInProgress();

  // Step 4: best-effort file unlinks post-commit. Ignore ENOENT since the
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
