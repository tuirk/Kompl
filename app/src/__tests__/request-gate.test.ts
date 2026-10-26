/**
 * proxy.ts: the one gate every request to Kompl passes before its route.
 *
 * Regression target: only six routes refused other sites, so any web page the
 * user visited could POST onboarding/stage and onboarding/finalize (a paid
 * compile of the page's own text into the wiki), lift the daily spend cap,
 * switch the compile model, or start Update pages. Route handlers read
 * request.json() whatever the Content-Type, so a no-cors text/plain POST, a
 * "simple" request with no preflight, was enough.
 *
 * And DNS rebinding: once a hostile name points at 127.0.0.1, the hostile
 * page is same-origin with Kompl, so its GETs carry no Origin and could read
 * /api/export (the whole wiki) or any page. Only the Host header shows it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';

afterEach(() => vi.unstubAllEnvs());

function request(path: string, method: string, headers: Record<string, string>): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
  });
}

/** The proxy let the request on to its route. */
function passed(res: Response | undefined): boolean {
  return res === undefined || res.headers.get('x-middleware-next') === '1';
}

/** What a page on another site sends with fetch(url, { mode: 'no-cors', method: 'POST', body }). */
const FROM_EVIL = {
  host: 'localhost:3000',
  origin: 'https://evil.test',
  'sec-fetch-site': 'cross-site',
  'content-type': 'text/plain;charset=UTF-8',
};

const PAID_OR_SPEND_ROUTES = [
  '/api/onboarding/stage',
  '/api/onboarding/finalize',
  '/api/settings',
  '/api/wiki/page-upgrade/start',
  '/api/compile/run',
  '/api/import',
];

describe('proxy: writes from other sites', () => {
  it('refuses a cross-site POST to every route, not only the six that checked', async () => {
    for (const path of PAID_OR_SPEND_ROUTES) {
      const res = await proxy(request(path, 'POST', FROM_EVIL));
      expect(res?.status, path).toBe(403);
      expect(((await res!.json()) as { error: string }).error).toBe('cross_site');
    }
  });

  it('refuses DELETE, PUT and PATCH from another site too', async () => {
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      expect((await proxy(request('/api/onboarding/session?session_id=s', method, FROM_EVIL)))?.status, method).toBe(403);
    }
  });

  it('refuses an Origin that differs from Host when the browser sends no Sec-Fetch-Site', async () => {
    const res = await proxy(request('/api/settings', 'POST', { host: 'localhost:3000', origin: 'http://evil.test' }));
    expect(res?.status).toBe(403);
  });

  it("lets through Kompl's own pages, and callers that send no Origin (CLI, MCP server, n8n, curl)", async () => {
    const own = { host: 'localhost:3000', origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' };
    expect(passed(await proxy(request('/api/onboarding/finalize', 'POST', own)))).toBe(true);
    expect(passed(await proxy(request('/api/settings', 'POST', { host: 'localhost:3000' })))).toBe(true);
    expect(passed(await proxy(request('/api/compile/run', 'POST', { host: 'app:3000' })))).toBe(true);
  });

  it('lets reads and preflights through: another site cannot read the answer', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(passed(await proxy(request('/api/settings', method, FROM_EVIL))), method).toBe(true);
    }
  });

  it('lets through Kompl behind your own proxy that rewrites Host, when the browser says the page is its own', async () => {
    const viaProxy = { host: 'localhost:3000', origin: 'https://kompl.example.com', 'sec-fetch-site': 'same-origin' };
    expect(passed(await proxy(request('/api/settings', 'POST', viaProxy)))).toBe(true);
  });
});

describe('proxy: host names Kompl answers to', () => {
  const rebound = { host: 'evil.test:3000', 'sec-fetch-site': 'same-origin' };

  it('refuses every request to a name outside DNS could point here, reads included', async () => {
    for (const [path, method] of [
      ['/api/export', 'GET'],
      ['/api/pages/search?q=x', 'GET'],
      ['/wiki/some-page', 'GET'],
      ['/', 'GET'],
      ['/api/onboarding/stage', 'POST'],
    ]) {
      const res = await proxy(request(path, method, rebound));
      expect(res?.status, `${method} ${path}`).toBe(403);
      expect(((await res!.json()) as { error: string }).error).toBe('unknown_host');
    }
    expect((await proxy(request('/api/export', 'GET', { host: 'localhost.evil.test:3000' })))?.status).toBe(403);
  });

  it("lets through localhost, its subdomains, IP addresses and Kompl's own service names", async () => {
    for (const host of [
      'localhost:3000',
      'LOCALHOST',
      'kompl.localhost:3000',
      '127.0.0.1:3000',
      '[::1]:3000',
      '192.168.1.20:3000',
      // The app calls itself (APP_URL) and n8n calls it by its compose name.
      'app:3000',
      'nlp-service:8000',
      'n8n:5678',
    ]) {
      expect(passed(await proxy(request('/api/export', 'GET', { host }))), host).toBe(true);
    }
  });

  it('lets through the names in KOMPL_ALLOWED_HOSTS and the name APP_URL gives the app', async () => {
    vi.stubEnv('KOMPL_ALLOWED_HOSTS', 'kompl.example.com, wiki.home:8443');
    vi.stubEnv('APP_URL', 'http://kompl-app:3000');
    for (const host of ['kompl.example.com', 'wiki.home:8443', 'kompl-app:3000']) {
      expect(passed(await proxy(request('/api/export', 'GET', { host }))), host).toBe(true);
    }
    expect((await proxy(request('/api/export', 'GET', { host: 'other.example.com' })))?.status).toBe(403);
  });

  it('lets through a request with no Host header: no browser sends one', async () => {
    const res = await proxy(request('/logo.png', 'GET', {}));
    expect(passed(res)).toBe(true);
  });
});
