/**
 * The onboarding URL box (lib/url-lines.ts): each page counted once, and
 * every line that won't be read is listed with its reason.
 */

import { describe, expect, it } from 'vitest';
import { parseUrlLines } from '../lib/url-lines';

describe('parseUrlLines', () => {
  it('counts the same page once', () => {
    const r = parseUrlLines('https://example.com/one\nhttps://example.com/one\nhttps://EXAMPLE.com/one/\nhttps://example.com/two');
    expect(r.urls).toEqual(['https://example.com/one', 'https://example.com/two']);
    expect(r.duplicates).toBe(2);
    expect(r.skipped).toEqual([]);
  });

  it('lists lines it will not read, with the reason', () => {
    const r = parseUrlLines(
      ['https://example.com/one', 'not a url', 'example.net', 'example.org:8080/x', 'ftp://files.example.com/a', 'https://x.com/someone/status/1', '  '].join('\n'),
    );
    expect(r.urls).toEqual(['https://example.com/one']);
    expect(r.skipped).toEqual([
      { line: 'not a url', reason: 'not_link' },
      { line: 'example.net', reason: 'no_scheme' },
      { line: 'example.org:8080/x', reason: 'no_scheme' },
      { line: 'ftp://files.example.com/a', reason: 'not_web' },
      { line: 'https://x.com/someone/status/1', reason: 'twitter' },
    ]);
  });
});
