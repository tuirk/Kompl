/**
 * isCrossSiteRequest: the guard on the routes that start paid compiles
 * (POST /api/agent/sources) or switch that on (POST /api/settings). Besides
 * refusing other sites, it refuses DNS rebinding: a page whose own name was
 * re-pointed at this machine sends matching Origin and Host headers, so the
 * host name itself must be one no outside DNS controls.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isCrossSiteRequest } from '../lib/same-origin';

afterEach(() => vi.unstubAllEnvs());

function req(headers: Record<string, string>): Request {
  return new Request('http://test/api/agent/sources', { method: 'POST', headers });
}

/** A browser request from the page served at `origin`, sent to that same address. */
function sameSite(origin: string): Request {
  return req({ origin, host: new URL(origin).host, 'sec-fetch-site': 'same-origin' });
}

describe('isCrossSiteRequest', () => {
  it('lets through requests without an Origin (MCP server, CLI, curl), whatever the host', () => {
    for (const host of ['localhost:3000', 'app:3000', 'host.docker.internal:3000', 'kompl.example.com']) {
      expect(isCrossSiteRequest(req({ host }))).toBe(false);
    }
  });

  it('lets through Kompl open on localhost or an IP address', () => {
    for (const origin of [
      'http://localhost:3000',
      'http://kompl.localhost:3000',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
      'http://192.168.1.20:3000',
    ]) {
      expect(isCrossSiteRequest(sameSite(origin)), origin).toBe(false);
    }
  });

  it('refuses another site', () => {
    expect(isCrossSiteRequest(req({ origin: 'http://evil.test', host: 'localhost:3000' }))).toBe(true);
    expect(isCrossSiteRequest(req({ 'sec-fetch-site': 'cross-site', host: 'localhost:3000' }))).toBe(true);
    expect(isCrossSiteRequest(req({ origin: 'null', host: 'localhost:3000' }))).toBe(true);
  });

  it('refuses a rebound host name even though Origin and Host match', () => {
    expect(isCrossSiteRequest(sameSite('http://evil.test:3000'))).toBe(true);
    expect(isCrossSiteRequest(sameSite('http://localhost.evil.test:3000'))).toBe(true);
    expect(isCrossSiteRequest(req({ origin: 'http://evil.test:3000' }))).toBe(true);
  });

  it('accepts the host names listed in KOMPL_ALLOWED_HOSTS (e.g. behind your own proxy)', () => {
    vi.stubEnv('KOMPL_ALLOWED_HOSTS', ' Kompl.Example.com , wiki.home:8443');
    expect(isCrossSiteRequest(sameSite('https://kompl.example.com'))).toBe(false);
    expect(isCrossSiteRequest(sameSite('https://wiki.home:8443'))).toBe(false);
    expect(isCrossSiteRequest(sameSite('https://other.example.com'))).toBe(true);
  });
});
