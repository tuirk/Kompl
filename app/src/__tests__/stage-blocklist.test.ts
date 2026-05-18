/**
 * POST /api/onboarding/stage — blocklist behaviour
 *
 * Regression: pre-fix, the route returned 422 on the first blocked-host
 * (x.com / twitter.com / t.co) URL it saw, aborting the whole batch. A user
 * importing 300 Chrome bookmarks lost all 300 because a handful linked to
 * Twitter.
 *
 * Fix: blocked URLs are skipped per-item and reported via `blocked_count` +
 * `blocked_urls` in the 200 response. The saved-link exemption is preserved
 * (Twitter export's tweet permalinks must still ingest).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../lib/db';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

import { POST } from '../app/api/onboarding/stage/route';

function post(body: unknown): Request {
  return new Request('http://localhost/api/onboarding/stage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface StageResponse {
  session_id: string;
  stage_ids: string[];
  blocked_count: number;
  blocked_urls?: string[];
}

describe('POST /api/onboarding/stage — blocklist behaviour', () => {
  let handle: TestDbHandle;

  beforeEach(() => {
    handle = setupTestDb();
  });

  afterEach(() => {
    handle.cleanup();
  });

  function countStagingRows(sessionId: string): number {
    const row = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM collect_staging WHERE session_id = ?`)
      .get(sessionId) as { n: number };
    return row.n;
  }

  function activityRows(sessionId: string, actionType: string): Array<{
    details: string | null;
  }> {
    // Stage route logs onboarding_staged / onboarding_blocked_urls_skipped
    // with details JSON containing session_id. The activity_log table's
    // session_id column is not populated by the stage route (it passes
    // source_id: null and no session_id field), so we filter via the JSON.
    return getDb()
      .prepare(
        `SELECT details FROM activity_log
         WHERE action_type = ?
           AND json_extract(details, '$.session_id') = ?`
      )
      .all(actionType, sessionId) as Array<{ details: string | null }>;
  }

  it('mixed batch: drops blocked URLs, stages the rest, reports blocked_count', async () => {
    const sessionId = 'session-mixed';
    const res = await POST(
      post({
        session_id: sessionId,
        connector: 'url',
        items: [
          { url: 'https://example.com/good1' },
          { url: 'https://x.com/user/status/1' },
          { url: 'https://example.com/good2' },
          { url: 'https://twitter.com/user/status/2' },
        ],
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as StageResponse;
    expect(body.stage_ids).toHaveLength(2);
    expect(body.blocked_count).toBe(2);
    expect(body.blocked_urls).toEqual([
      'https://x.com/user/status/1',
      'https://twitter.com/user/status/2',
    ]);
    expect(countStagingRows(sessionId)).toBe(2);

    // Both activity rows should be present
    expect(activityRows(sessionId, 'onboarding_staged')).toHaveLength(1);
    expect(activityRows(sessionId, 'onboarding_blocked_urls_skipped')).toHaveLength(1);
  });

  it('all-blocked batch: returns 200 with empty stage_ids, no onboarding_staged log', async () => {
    const sessionId = 'session-all-blocked';
    const res = await POST(
      post({
        session_id: sessionId,
        connector: 'url',
        items: [
          { url: 'https://x.com/a' },
          { url: 'https://twitter.com/b' },
          { url: 'https://t.co/c' },
        ],
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as StageResponse;
    expect(body.stage_ids).toEqual([]);
    expect(body.blocked_count).toBe(3);
    expect(body.blocked_urls).toEqual([
      'https://x.com/a',
      'https://twitter.com/b',
      'https://t.co/c',
    ]);
    expect(countStagingRows(sessionId)).toBe(0);

    // No onboarding_staged row (count would be 0 — don't emit noise)
    expect(activityRows(sessionId, 'onboarding_staged')).toHaveLength(0);
    // One onboarding_blocked_urls_skipped row
    expect(activityRows(sessionId, 'onboarding_blocked_urls_skipped')).toHaveLength(1);
  });

  it("preserves saved-link exemption: x.com URL via connector='saved-link' is staged, not blocked", async () => {
    const sessionId = 'session-saved-link';
    const res = await POST(
      post({
        session_id: sessionId,
        connector: 'saved-link',
        items: [{ url: 'https://x.com/user/status/123' }],
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as StageResponse;
    expect(body.stage_ids).toHaveLength(1);
    expect(body.blocked_count).toBe(0);
    expect(body.blocked_urls).toBeUndefined();
    expect(countStagingRows(sessionId)).toBe(1);
  });

  it('empty items array still returns 422 (malformed request, distinct from filtered-empty)', async () => {
    const res = await POST(
      post({
        session_id: 'session-empty',
        connector: 'url',
        items: [],
      })
    );
    expect(res.status).toBe(422);
  });

  it('sample_urls in activity event is capped at 3 even when 10+ URLs are blocked', async () => {
    const sessionId = 'session-cap';
    const blockedItems = Array.from({ length: 10 }, (_, i) => ({
      url: `https://x.com/user/status/${i}`,
    }));
    const res = await POST(
      post({
        session_id: sessionId,
        connector: 'url',
        items: blockedItems,
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as StageResponse;
    expect(body.blocked_count).toBe(10);
    // Response cap: 10 (so all of them in this case, but the cap is 10)
    expect(body.blocked_urls).toHaveLength(10);

    const rows = activityRows(sessionId, 'onboarding_blocked_urls_skipped');
    expect(rows).toHaveLength(1);
    const details = JSON.parse(rows[0].details ?? '{}') as {
      count: number;
      sample_urls: string[];
    };
    expect(details.count).toBe(10);
    expect(details.sample_urls).toHaveLength(3);
  });
});
