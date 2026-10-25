/**
 * One spelling per web page, for "is this link already saved?": the URL as
 * parsed (scheme and host lower-cased, default port and dot segments
 * dropped) without a trailing slash on its path. The path keeps its case:
 * /A and /a can be different pages. null when it isn't a URL.
 */
export function urlKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  // An empty path reads back as "/", so the site root keeps one key.
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.href;
}

/**
 * The spellings a stored copy of `key` most likely has, lower-cased for a
 * case-insensitive first pass: as keyed, and with the trailing slash back.
 */
export function urlKeyCandidates(key: string): string[] {
  const slashed = new URL(key);
  if (!slashed.pathname.endsWith('/')) slashed.pathname += '/';
  return [...new Set([key, slashed.href].map((u) => u.toLowerCase()))];
}
