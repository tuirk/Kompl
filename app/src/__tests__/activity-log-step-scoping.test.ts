/**
 * Migration v23 + getEventsForStep — verify activity_log scoping.
 *
 * Phase B of the progress-visibility plan: every activity_log row written
 * from a compile pipeline route gets tagged with session_id + step_key, so
 * /api/compile/progress/events (Phase B.4) can return per-(session, step)
 * audit trails for the expand-to-reveal progress UI (Phase C).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';
import { logActivity, getEventsForStep } from '../lib/db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe('logActivity session/step scoping (v23)', () => {
  it('persists session_id and step_key when supplied', () => {
    handle = setupTestDb();
    logActivity('extraction_complete', {
      source_id: null,
      session_id: 'sess-A',
      step_key: 'extract',
      details: { entity_count: 12 },
    });
    const row = handle.db
      .prepare(`SELECT session_id, step_key FROM activity_log ORDER BY id DESC LIMIT 1`)
      .get() as { session_id: string | null; step_key: string | null };
    expect(row.session_id).toBe('sess-A');
    expect(row.step_key).toBe('extract');
  });

  it('omits both fields cleanly when not supplied (back-compat for non-pipeline callers)', () => {
    handle = setupTestDb();
    logActivity('compile_cancelled', {
      source_id: null,
      details: { reason: 'never_started' },
    });
    const row = handle.db
      .prepare(`SELECT session_id, step_key FROM activity_log ORDER BY id DESC LIMIT 1`)
      .get() as { session_id: string | null; step_key: string | null };
    expect(row.session_id).toBeNull();
    expect(row.step_key).toBeNull();
  });
});

describe('getEventsForStep', () => {
  it('returns rows scoped to (session_id, step_key) ordered most-recent-first', () => {
    handle = setupTestDb();
    logActivity('extraction_complete', { source_id: null, session_id: 'A', step_key: 'extract', details: { x: 1 } });
    logActivity('extraction_complete', { source_id: null, session_id: 'A', step_key: 'extract', details: { x: 2 } });
    logActivity('resolution_complete', { source_id: null, session_id: 'A', step_key: 'resolve', details: { merged: 0 } });
    logActivity('extraction_complete', { source_id: null, session_id: 'B', step_key: 'extract', details: { x: 3 } });

    const rows = getEventsForStep('A', 'extract', 10);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.action_type === 'extraction_complete')).toBe(true);
    // ORDER BY id DESC — second insert returns first
    expect(rows[0].id).toBeGreaterThan(rows[1].id);
  });

  it('returns [] for unknown session', () => {
    handle = setupTestDb();
    logActivity('extraction_complete', { source_id: null, session_id: 'real', step_key: 'extract' });
    expect(getEventsForStep('nope', 'extract', 10)).toEqual([]);
  });

  it('returns [] for known session, wrong step', () => {
    handle = setupTestDb();
    logActivity('extraction_complete', { source_id: null, session_id: 'A', step_key: 'extract' });
    expect(getEventsForStep('A', 'resolve', 10)).toEqual([]);
  });

  it('clamps limit to [1, 200]', () => {
    handle = setupTestDb();
    for (let i = 0; i < 5; i++) {
      logActivity('extraction_complete', { source_id: null, session_id: 'A', step_key: 'extract' });
    }
    expect(getEventsForStep('A', 'extract', 3)).toHaveLength(3);
    // 0 → falsy → falls back to 50; 5 rows seeded → all 5 returned
    expect(getEventsForStep('A', 'extract', 0)).toHaveLength(5);
    // negative → clamped to 1
    expect(getEventsForStep('A', 'extract', -10)).toHaveLength(1);
  });

  it('skips pre-v23 rows that have NULL session_id (legacy data)', () => {
    handle = setupTestDb();
    // Direct INSERT bypassing logActivity to simulate pre-v23 row shape.
    handle.db
      .prepare(
        `INSERT INTO activity_log (action_type, source_id, details, session_id, step_key)
         VALUES (?, NULL, NULL, NULL, NULL)`
      )
      .run('extraction_complete');
    logActivity('extraction_complete', { source_id: null, session_id: 'A', step_key: 'extract' });
    const rows = getEventsForStep('A', 'extract', 10);
    expect(rows).toHaveLength(1); // only the scoped row, not the legacy NULL row
  });
});
