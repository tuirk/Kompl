/**
 * Hostname blocklist for the URL connector.
 *
 * Some sites are impossible to auto-scrape: they gate all content behind
 * authenticated JavaScript, and our conversion fallback (MarkItDown) happily
 * returns the login nag / JS-disabled shell as "content" — which passes the
 * length-based source gates and produces junk wiki pages.
 *
 * We block these at intake. Users must use a dedicated connector (e.g. the
 * Twitter bookmark importer for x.com), or paste the content body into the
 * Text connector.
 *
 * Keep this list short and defensible. Each entry matches the host exactly
 * OR any subdomain of it (`www.x.com`, `mobile.twitter.com` both match).
 */

export const BLOCKED_URL_HOSTS: readonly string[] = [
  'x.com',
  'twitter.com',
  't.co',
] as const;

export const URL_HOST_BLOCKED_MESSAGE =
  'x.com, twitter.com, and t.co URLs can\u2019t be auto-scraped \u2014 X gates all content behind JavaScript. Import tweets via the Twitter bookmark connector (JSON export), or paste the post body into the Text connector.';

/**
 * Returns true if the URL's hostname is in the blocklist (exact match or
 * subdomain). Returns false for malformed URLs so callers can keep the
 * existing invalid-URL path for those.
 */
export function isBlockedHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const blocked of BLOCKED_URL_HOSTS) {
    if (host === blocked || host.endsWith('.' + blocked)) return true;
  }
  return false;
}
