import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { setupTestDb, seedSource, type TestDbHandle } from './helpers/test-db';
import { getRunningCompileSession } from '../lib/db';

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
     VALUES (?, 'running', '[]', datetime('now', ? || ' minutes'), ?)`,
  ).run(sessionId, `-${startedMinutesAgo}`, 1);
}

function insertQueuedSession(
  db: Database.Database,
  sessionId: string,
  sourceCount: number,
): void {
  db.prepare(
    `INSERT INTO compile_progress (session_id, status, steps, started_at, source_count)
     VALUES (?, 'queued', '[]', NULL, ?)`,
  ).run(sessionId, sourceCount);
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

describe('getRunningCompileSession (adaptive running-session gate)', () => {
  it('keeps a 50-source running session active past 180 min when still under its 300-min threshold', () => {
    handle = setupTestDb();
    insertRunningSession(handle.db, 'big', 200);
    seedSourcesForSession(handle.db, 'big', 50);

    const active = getRunningCompileSession();
    expect(active?.session_id).toBe('big');
  });

  it('drops a running session once it exceeds its personal threshold', () => {
    handle = setupTestDb();
    insertRunningSession(handle.db, 'big', 350);
    seedSourcesForSession(handle.db, 'big', 50);

    const active = getRunningCompileSession();
    expect(active).toBeNull();
  });

  it('still treats queued sessions as active regardless of elapsed time', () => {
    handle = setupTestDb();
    insertQueuedSession(handle.db, 'queued', 50);

    const active = getRunningCompileSession();
    expect(active?.session_id).toBe('queued');
  });
});
