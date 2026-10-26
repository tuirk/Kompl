/**
 * POST /api/settings: a bad request changes nothing.
 *
 * Regression target: a body that wasn't JSON, or was null, threw (500:
 * `'auto_approve' in null`), and fields were saved one by one as they were
 * checked, so {auto_approve: true, stale_threshold_days: -1} turned on
 * auto-approve and then answered 422 as if nothing had happened.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET, POST } from '../app/api/settings/route';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle;
beforeEach(() => {
  handle = setupTestDb();
});
afterEach(() => handle.cleanup());

function post(body: string): Promise<Response> {
  return POST(new Request('http://test/api/settings', { method: 'POST', body }));
}

async function settings(): Promise<Record<string, unknown>> {
  return (await (await GET()).json()) as Record<string, unknown>;
}

describe('POST /api/settings', () => {
  it('answers 400 to a body that is not a JSON object', async () => {
    for (const body of ['not json', 'null', '[]', '"auto_approve"', '']) {
      expect((await post(body)).status, body).toBe(400);
    }
  });

  it('saves nothing when any field is invalid', async () => {
    const before = await settings();
    const cases = [
      { auto_approve: !before.auto_approve, stale_threshold_days: -1 },
      { agent_add_sources_enabled: true, daily_cap_usd: -5 },
      { daily_cap_usd: 0, compile_model: 'gpt-nonexistent' },
      { lint_enabled: !before.lint_enabled, min_source_chars: 1.5 },
    ];
    for (const body of cases) {
      expect((await post(JSON.stringify(body))).status, JSON.stringify(body)).toBe(422);
    }
    expect(await settings()).toEqual(before);
  });

  it('saves every field of a valid request', async () => {
    const before = await settings();
    const res = await post(JSON.stringify({ auto_approve: !before.auto_approve, stale_threshold_days: 30, daily_cap_usd: 2.5 }));
    expect(res.status).toBe(200);
    expect(await settings()).toMatchObject({ auto_approve: !before.auto_approve, stale_threshold_days: 30, daily_cap_usd: 2.5 });
  });
});
