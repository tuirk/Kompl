import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';
import {
  getRunningCompileSession,
  supersedeOrphanQueuedSessions,
  updateCompileStep,
} from '../lib/db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function insertQueued(db: Database.Database, sessionId: string): void {
  db.prepare(
    `INSERT INTO compile_progress (session_id, status, steps, started_at, source_count)
     VALUES (?, 'queued', '{}', NULL, 1)`,
  ).run(sessionId);
}

describe('supersedeOrphanQueuedSessions', () => {
  it('cancels other never-started queued sessions but not the requested one', () => {
    handle = setupTestDb();
    insertQueued(handle.db, 'orphan-a');
    insertQueued(handle.db, 'orphan-b');
    insertQueued(handle.db, 'keep-me');

    const n = supersedeOrphanQueuedSessions('keep-me');
    expect(n).toBe(2);

    const orphanA = handle.db
      .prepare('SELECT status FROM compile_progress WHERE session_id = ?')
      .get('orphan-a') as { status: string };
    const keep = handle.db
      .prepare('SELECT status FROM compile_progress WHERE session_id = ?')
      .get('keep-me') as { status: string };
    expect(orphanA.status).toBe('cancelled');
    expect(keep.status).toBe('queued');
    expect(getRunningCompileSession()?.session_id).toBe('keep-me');
  });

  it('does not cancel running sessions for other ids', () => {
    handle = setupTestDb();
    insertQueued(handle.db, 'other-queued');
    handle.db
      .prepare(
        `INSERT INTO compile_progress (session_id, status, steps, started_at, source_count)
         VALUES ('other-running', 'running', '{}', datetime('now'), 1)`,
      )
      .run();

    supersedeOrphanQueuedSessions('new-session');

    const running = handle.db
      .prepare('SELECT status FROM compile_progress WHERE session_id = ?')
      .get('other-running') as { status: string };
    expect(running.status).toBe('running');
    expect(getRunningCompileSession()?.session_id).toBe('other-running');
  });
});

describe('updateCompileStep on cancelled sessions', () => {
  it('does not resurrect cancelled to running when a worker reports running', () => {
    handle = setupTestDb();
    handle.db
      .prepare(
        `INSERT INTO compile_progress (session_id, status, steps, started_at, source_count)
         VALUES ('s1', 'cancelled', '{}', datetime('now'), 1)`,
      )
      .run();

    updateCompileStep('s1', 'extract', 'running', '1/1 sources extracted');

    const row = handle.db
      .prepare('SELECT status FROM compile_progress WHERE session_id = ?')
      .get('s1') as { status: string };
    expect(row.status).toBe('cancelled');
    expect(getRunningCompileSession()).toBeNull();
  });
});
