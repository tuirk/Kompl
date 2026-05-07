/**
 * Unit tests for markStaleSessionsFailed — per-session adaptive cleanup.
 *
 * Threshold formula: max(60, source_count * 6) minutes.
 *
 * Covers:
 *   1. Single-source session at 70 min elapsed → failed (60-min floor).
 *   2. 50-source session at 70 min elapsed → still running
 *      (50 * 6 = 300-min threshold).
 *   3. 50-source session at 350 min elapsed → failed (exceeds threshold).
 *   4. 200-source session at 600 min elapsed → still running
 *      (200 * 6 = 1200-min threshold).
 *   5. Queued session (started_at IS NULL) → never touched
 *      (handled by reconcileStuckCompileSessions).
 *   6. Already-failed/completed/cancelled sessions → never touched.
 *   7. Failure message includes both the source count and the personal
 *      threshold that was crossed (regression guard for the prior flat
 *      "30 minutes" message).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { setupTestDb, seedSource, type TestDbHandle } from './helpers/test-db';
import { markStaleSessionsFailed } from '../lib/db';
import Database from 'better-sqlite3';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function insertRunningSession(
  db: Database.Database,
  sessionId: string,
  startedMinutesAgo: number,
): void {
  db.prepare(
    `INSERT INTO compile_progress (session_id, status, steps, started_at, source_count)
     VALUES (?, 'running', '[]', datetime('now', ? || ' minutes'), 1)`,
  ).run(sessionId, `-${startedMinutesAgo}`);
}

function seedSourcesForSession(
  db: Database.Database,
  sessionId: string,
  count: number,
): void {
  for (let i = 0; i < count; i++) {
    seedSource(db, {
      source_id: `${sessionId}-src-${i}`,
      title: `Src ${i}`,
      onboarding_session_id: sessionId,
    });
  }
}

describe('markStaleSessionsFailed (per-session adaptive)', () => {
  it('marks a 1-source session failed at 70 min (exceeds 60-min floor)', () => {
    handle = setupTestDb();
    insertRunningSession(handle.db, 's1', 70);
    seedSourcesForSession(handle.db, 's1', 1);

    expect(markStaleSessionsFailed()).toBe(1);

    const row = handle.db
      .prepare(`SELECT status, error FROM compile_progress WHERE session_id = ?`)
      .get('s1') as { status: string; error: string | null };
    expect(row.status).toBe('failed');
    expect(row.error).toContain('1 sources');
    expect(row.error).toContain('60 min');
  });

  it('leaves a 1-source session running at 50 min (under 60-min floor)', () => {
    handle = setupTestDb();
    insertRunningSession(handle.db, 's1', 50);
    seedSourcesForSession(handle.db, 's1', 1);

    expect(markStaleSessionsFailed()).toBe(0);
    const row = handle.db
      .prepare(`SELECT status FROM compile_progress WHERE session_id = ?`)
      .get('s1') as { status: string };
    expect(row.status).toBe('running');
  });

  it('leaves a 50-source session running at 70 min (50*6=300-min threshold)', () => {
    handle = setupTestDb();
    insertRunningSession(handle.db, 'big', 70);
    seedSourcesForSession(handle.db, 'big', 50);

    expect(markStaleSessionsFailed()).toBe(0);
    const row = handle.db
      .prepare(`SELECT status FROM compile_progress WHERE session_id = ?`)
      .get('big') as { status: string };
    expect(row.status).toBe('running');
  });

  it('marks a 50-source session failed at 350 min (exceeds 300-min threshold)', () => {
    handle = setupTestDb();
    insertRunningSession(handle.db, 'big', 350);
    seedSourcesForSession(handle.db, 'big', 50);

    expect(markStaleSessionsFailed()).toBe(1);
    const row = handle.db
      .prepare(`SELECT status, error FROM compile_progress WHERE session_id = ?`)
      .get('big') as { status: string; error: string | null };
    expect(row.status).toBe('failed');
    expect(row.error).toContain('50 sources');
    expect(row.error).toContain('300 min');
  });

  it('leaves a 200-source session running at 600 min (200*6=1200-min threshold)', () => {
    handle = setupTestDb();
    insertRunningSession(handle.db, 'huge', 600);
    seedSourcesForSession(handle.db, 'huge', 200);

    expect(markStaleSessionsFailed()).toBe(0);
    const row = handle.db
      .prepare(`SELECT status FROM compile_progress WHERE session_id = ?`)
      .get('huge') as { status: string };
    expect(row.status).toBe('running');
  });

  it('handles mixed-size sessions correctly in one sweep', () => {
    handle = setupTestDb();
    // Tiny session, expired
    insertRunningSession(handle.db, 'tiny-stale', 70);
    seedSourcesForSession(handle.db, 'tiny-stale', 1);
    // Tiny session, fresh
    insertRunningSession(handle.db, 'tiny-fresh', 30);
    seedSourcesForSession(handle.db, 'tiny-fresh', 1);
    // Big session, fresh (under personal threshold)
    insertRunningSession(handle.db, 'big-fresh', 200);
    seedSourcesForSession(handle.db, 'big-fresh', 50);

    expect(markStaleSessionsFailed()).toBe(1);
    const statuses = handle.db
      .prepare(
        `SELECT session_id, status FROM compile_progress
         WHERE session_id IN ('tiny-stale', 'tiny-fresh', 'big-fresh')`,
      )
      .all() as Array<{ session_id: string; status: string }>;
    const byId = Object.fromEntries(statuses.map((r) => [r.session_id, r.status]));
    expect(byId['tiny-stale']).toBe('failed');
    expect(byId['tiny-fresh']).toBe('running');
    expect(byId['big-fresh']).toBe('running');
  });

  it('never touches queued sessions (started_at IS NULL)', () => {
    handle = setupTestDb();
    handle.db
      .prepare(
        `INSERT INTO compile_progress (session_id, status, steps, started_at, source_count)
         VALUES ('q1', 'queued', '[]', NULL, 1)`,
      )
      .run();

    expect(markStaleSessionsFailed()).toBe(0);
    const row = handle.db
      .prepare(`SELECT status FROM compile_progress WHERE session_id = ?`)
      .get('q1') as { status: string };
    expect(row.status).toBe('queued');
  });

  it('never touches already-failed/completed/cancelled sessions', () => {
    handle = setupTestDb();
    for (const status of ['failed', 'completed', 'cancelled']) {
      handle.db
        .prepare(
          `INSERT INTO compile_progress (session_id, status, steps, started_at, source_count)
           VALUES (?, ?, '[]', datetime('now', '-500 minutes'), 1)`,
        )
        .run(`s-${status}`, status);
    }
    expect(markStaleSessionsFailed()).toBe(0);
  });

  it('returns 0 when there are no candidates at all', () => {
    handle = setupTestDb();
    expect(markStaleSessionsFailed()).toBe(0);
  });
});
