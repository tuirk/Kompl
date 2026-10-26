/**
 * POST /api/onboarding/stage takes web links only: http and https.
 *
 * Regression target: the URL connector checked only that item.url was a
 * non-empty string, although lib/url-lines.ts relies on "the staging route"
 * taking http(s) links only, so javascript:, file: or data: URLs were staged.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST } from '../app/api/onboarding/stage/route';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle;
beforeEach(() => {
  handle = setupTestDb();
});
afterEach(() => handle.cleanup());

function stage(connector: string, url: string): Promise<Response> {
  return POST(
    new Request('http://localhost/api/onboarding/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'sess-scheme', connector, items: [{ url }] }),
    })
  );
}

describe('POST /api/onboarding/stage link schemes', () => {
  it('refuses a link that is not http or https', async () => {
    for (const connector of ['url', 'saved-link']) {
      for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'ftp://example.com/a', 'example.com/page']) {
        expect((await stage(connector, url)).status, `${connector} ${url}`).toBe(422);
      }
    }
  });

  it('stages http and https links', async () => {
    expect((await stage('url', 'https://example.com/a')).status).toBe(200);
    expect((await stage('saved-link', 'http://example.com/b')).status).toBe(200);
  });
});
