/**
 * Reads the onboarding URL box: one link per line. Links are counted once
 * (the same page pasted twice, or with and without a trailing slash, by
 * lib/url-key.ts), and every line that won't be read says why, so nothing
 * is dropped silently.
 *
 * A bare domain ("example.com") is not read: Kompl takes http(s) links only
 * everywhere (the staging route, the agent add_source tool), so the reason
 * tells the person to add https:// rather than guessing it for them.
 */

import { isBlockedHost } from './url-blocklist';
import { urlKey } from './url-key';

export type SkipReason = 'no_scheme' | 'not_web' | 'not_link' | 'twitter';

export interface SkippedLine {
  line: string;
  reason: SkipReason;
}

export interface UrlLines {
  /** Links to add, each page once, in the order pasted. */
  urls: string[];
  /** Lines naming a page already in `urls`. */
  duplicates: number;
  /** Lines that won't be read, with why. */
  skipped: SkippedLine[];
}

export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  no_scheme: 'add https:// at the start',
  not_web: 'only http and https links can be added',
  not_link: 'not a web link',
  twitter: 'X/Twitter links go through the Twitter / X connector',
};

/** Looks like a site address typed without its scheme: "example.com/page". */
const BARE_DOMAIN = /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+(:\d+)?([/?#]\S*)?$/u;

export function parseUrlLines(raw: string): UrlLines {
  const urls: string[] = [];
  const seen = new Set<string>();
  const skipped: SkippedLine[] = [];
  let duplicates = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: URL | null = null;
    try {
      parsed = new URL(trimmed);
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      skipped.push({ line: trimmed, reason: BARE_DOMAIN.test(trimmed) ? 'no_scheme' : 'not_link' });
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      // "example.com:8080" parses with "example.com:" as its scheme.
      skipped.push({ line: trimmed, reason: BARE_DOMAIN.test(trimmed) ? 'no_scheme' : 'not_web' });
      continue;
    }
    if (isBlockedHost(trimmed)) {
      skipped.push({ line: trimmed, reason: 'twitter' });
      continue;
    }
    const key = urlKey(trimmed) ?? trimmed;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    urls.push(trimmed);
  }
  return { urls, duplicates, skipped };
}
