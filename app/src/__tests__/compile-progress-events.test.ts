/**
 * GET /api/compile/progress/events?session_id&step&limit
 *
 * Activity-log tail filtered by (session_id, step_key). Backed by
 * getEventsForStep helper (covered separately in
 * activity-log-step-scoping.test.ts).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { GET } from '../app/api/compile/progress/events/route';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';
import { logActivity } from '../lib/db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function makeReq(qs: string): Request {
  return new Request(`http://test/api/compile/progress/events?${qs}`);
}

describe('GET /api/compile/progress/events', () => {
  it('rejects missing session_id', async () => {
    handle = setupTestDb();
    const res = await GET(makeReq('step=extract'));
    expect(res.status).toBe(400);
  });

  it('rejects missing step', async () => {
    handle = setupTestDb();
    const res = await GET(makeReq('session_id=A'));
    expect(res.status).toBe(400);
  });

  it('returns events scoped by session_id + step_key', async () => {
    handle = setupTestDb();
    logActivity('extraction_complete', {
      source_id: null,
      session_id: 'A',
      step_key: 'extract',
      details: { entity_count: 12 },
    });
    logActivity('extraction_complete', {
      source_id: null,
      session_id: 'B',
      step_key: 'extract',
    });
    logActivity('resolution_complete', {
      source_id: null,
      session_id: 'A',
      step_key: 'resolve',
    });
    const res = await GET(makeReq('session_id=A&step=extract'));
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].action_type).toBe('extraction_complete');
    expect(body.events[0].details).toEqual({ entity_count: 12 });
  });

  it('parses details JSON on read', async () => {
    handle = setupTestDb();
    logActivity('extraction_failed', {
      source_id: null,
      session_id: 'A',
      step_key: 'extract',
      details: { title: 'Doc', error: 'extract_timeout' },
    });
    const res = await GET(makeReq('session_id=A&step=extract'));
    const body = await res.json();
    expect(body.events[0].details).toEqual({
      title: 'Doc',
      error: 'extract_timeout',
    });
  });

  it('honors limit cap', async () => {
    handle = setupTestDb();
    for (let i = 0; i < 250; i++) {
      logActivity('extraction_complete', {
        source_id: null,
        session_id: 'A',
        step_key: 'extract',
      });
    }
    const res = await GET(makeReq('session_id=A&step=extract&limit=999'));
    const body = await res.json();
    expect(body.events.length).toBeLessThanOrEqual(200);
  });

  it('defaults limit to 50 when not supplied', async () => {
    handle = setupTestDb();
    for (let i = 0; i < 75; i++) {
      logActivity('extraction_complete', {
        source_id: null,
        session_id: 'A',
        step_key: 'extract',
      });
    }
    const res = await GET(makeReq('session_id=A&step=extract'));
    const body = await res.json();
    expect(body.events).toHaveLength(50);
  });
});
