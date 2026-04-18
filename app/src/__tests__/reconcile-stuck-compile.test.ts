/**
 * Unit tests for reconcileStuckCompileSessions — the /api/health sweep that
 * rescues 'queued' compile_progress rows orphaned by a dropped n8n webhook.
 *
 * Covers:
 *   1. Sweeps only rows older than olderThanMinutes — fresh queued rows untouched.
 *   2. Flips swept row to status='failed' with a HUMAN-READABLE error message
 *      (regression guard — was writing raw code 'never_started' which the
 *      progress page rendered verbatim to the user).
 *   3. Writes a compile_failed activity_log entry per swept row.
 *   4. Returns the correct count of swept rows.
 *   5. No-op when there are zero stuck rows (doesn't touch other statuses).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';
import { reconcileStuckCompileSessions } from '../lib/db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function insertProgress(
  db: TestDbHandle['db'],
  sessionId: string,
  status: string,
  createdAt: string
): void {
  db.prepare(
    `INSERT INTO compile_progress (session_id, status, steps, created_at, source_count)
     VALUES (?, ?, '[]', ?, 1)`
  ).run(sessionId, status, createdAt);
}

describe('reconcileStuckCompileSessions', () => {
  it('leaves fresh queued rows alone', () => {
    handle = setupTestDb();
    // A row created just now — well under the 5-minute threshold.
    insertProgress(handle.db, 'fresh-1', 'queued', "datetime('now', '-1 minute')");
    // Use SQL directly so the datetime expression evaluates.
    handle.db.exec(
      `UPDATE compile_progress SET created_at = datetime('now','-1 minutes') WHERE session_id = 'fresh-1'`
    );

    const swept = reconcileStuckCompileSessions(5);
    expect(swept).toBe(0);

    const row = handle.db
      .prepare(`SELECT status, error FROM compile_progress WHERE session_id = ?`)
      .get('fresh-1') as { status: string; error: string | null };
    expect(row.status).toBe('queued');
    expect(row.error).toBeNull();
  });

  it('flips stale queued rows to failed with a human-readable error', () => {
    handle = setupTestDb();
    insertProgress(handle.db, 'stale-1', 'queued', 'placeholder');
    handle.db.exec(
      `UPDATE compile_progress SET created_at = datetime('now','-10 minutes') WHERE session_id = 'stale-1'`
    );

    const swept = reconcileStuckCompileSessions(5);
    expect(swept).toBe(1);

    const row = handle.db
      .prepare(`SELECT status, error FROM compile_progress WHERE session_id = ?`)
      .get('stale-1') as { status: string; error: string };
    expect(row.status).toBe('failed');
    // Regression guard: error must be a human sentence, NOT the raw code.
    expect(row.error).not.toBe('never_started');
    expect(row.error.length).toBeGreaterThan(20);
    expect(/retry/i.test(row.error)).toBe(true);
  });

  it('writes a compile_failed activity entry for each swept row', () => {
    handle = setupTestDb();
    insertProgress(handle.db, 'stale-2', 'queued', 'placeholder');
    insertProgress(handle.db, 'stale-3', 'queued', 'placeholder');
    handle.db.exec(
      `UPDATE compile_progress SET created_at = datetime('now','-10 minutes') WHERE session_id IN ('stale-2','stale-3')`
    );

    const swept = reconcileStuckCompileSessions(5);
    expect(swept).toBe(2);

    const activity = handle.db
      .prepare(
        `SELECT action_type, details FROM activity_log
          WHERE action_type = 'compile_failed'
          ORDER BY id ASC`
      )
      .all() as Array<{ action_type: string; details: string }>;
    expect(activity).toHaveLength(2);
    const sessionIds = activity.map((a) => JSON.parse(a.details).session_id).sort();
    expect(sessionIds).toEqual(['stale-2', 'stale-3']);
  });

  it('does not touch rows with status other than queued', () => {
    handle = setupTestDb();
    insertProgress(handle.db, 'running-1', 'running', 'placeholder');
    insertProgress(handle.db, 'completed-1', 'completed', 'placeholder');
    handle.db.exec(
      `UPDATE compile_progress SET created_at = datetime('now','-10 minutes') WHERE session_id IN ('running-1','completed-1')`
    );

    const swept = reconcileStuckCompileSessions(5);
    expect(swept).toBe(0);

    const running = handle.db
      .prepare(`SELECT status FROM compile_progress WHERE session_id = 'running-1'`)
      .get() as { status: string };
    const completed = handle.db
      .prepare(`SELECT status FROM compile_progress WHERE session_id = 'completed-1'`)
      .get() as { status: string };
    expect(running.status).toBe('running');
    expect(completed.status).toBe('completed');
  });

  it('is a no-op when there are zero rows', () => {
    handle = setupTestDb();
    const swept = reconcileStuckCompileSessions(5);
    expect(swept).toBe(0);
  });
});
