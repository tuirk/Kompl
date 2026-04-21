import { describe, expect, it } from 'vitest';
import { isBlockedHost, BLOCKED_URL_HOSTS } from '../lib/url-blocklist';

describe('isBlockedHost', () => {
  it('matches x.com exactly', () => {
    expect(isBlockedHost('https://x.com')).toBe(true);
    expect(isBlockedHost('https://x.com/')).toBe(true);
    expect(isBlockedHost('https://x.com/user/status/123')).toBe(true);
  });

  it('matches twitter.com exactly', () => {
    expect(isBlockedHost('https://twitter.com/user')).toBe(true);
  });

  it('matches t.co shortlinks', () => {
    expect(isBlockedHost('https://t.co/abc')).toBe(true);
  });

  it('matches subdomains (www, mobile, m, pic)', () => {
    expect(isBlockedHost('https://www.x.com/user')).toBe(true);
    expect(isBlockedHost('https://mobile.twitter.com/user')).toBe(true);
    expect(isBlockedHost('https://m.twitter.com/user')).toBe(true);
    expect(isBlockedHost('https://pic.twitter.com/abc')).toBe(true);
  });

  it('is case-insensitive on host', () => {
    expect(isBlockedHost('https://X.COM/user')).toBe(true);
    expect(isBlockedHost('https://Twitter.Com/user')).toBe(true);
  });

  it('allows unrelated hosts', () => {
    expect(isBlockedHost('https://example.com')).toBe(false);
    expect(isBlockedHost('https://paulgraham.com/read.html')).toBe(false);
    expect(isBlockedHost('https://www.youtube.com/watch?v=abc')).toBe(false);
  });

  it('does not substring-match — "twitter" in a different tld or path must not trip', () => {
    // Different TLD entirely
    expect(isBlockedHost('https://twitter.io/user')).toBe(false);
    // Host contains the blocked name in a path segment, not the host
    expect(isBlockedHost('https://github.com/x.com')).toBe(false);
    // Host ends with blocked name but is NOT a subdomain of it
    expect(isBlockedHost('https://notx.com/')).toBe(false);
    expect(isBlockedHost('https://fakettwitter.com/')).toBe(false);
  });

  it('returns false for malformed URLs (keeps existing invalid-URL path intact)', () => {
    expect(isBlockedHost('not a url')).toBe(false);
    expect(isBlockedHost('')).toBe(false);
    expect(isBlockedHost('ftp://x.com/foo')).toBe(true); // host check only; protocol gate lives elsewhere
  });

  it('BLOCKED_URL_HOSTS is non-empty and contains the three known hosts', () => {
    expect(BLOCKED_URL_HOSTS).toContain('x.com');
    expect(BLOCKED_URL_HOSTS).toContain('twitter.com');
    expect(BLOCKED_URL_HOSTS).toContain('t.co');
  });
});
