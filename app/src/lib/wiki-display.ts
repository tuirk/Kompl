/**
 * Display-time cleanup of page markdown. Runs on every page view, old pages
 * included, and never changes what is stored.
 */

import { rewriteWikilinksByScope } from './wikilink-scopes';

/**
 * Expand [[Page Title]] / [[Page Title|label]] wikilinks to markdown links.
 *
 *   - each page is linked once in the body; later mentions show as text
 *   - Related lists and tables link their own entries
 *   - headings never link (their anchors stay stable)
 *   - unknown titles and links to the page itself show as text
 *   - fenced and inline code are left as written
 */
export function expandWikilinksForDisplay(
  markdown: string,
  pageIdOf: (title: string) => string | undefined,
  currentPageId: string,
): string {
  return rewriteWikilinksByScope(
    markdown,
    (link) => pageIdOf(link.target) ?? null,
    (link, pageId) =>
      pageId !== null && pageId !== currentPageId && link.scope !== 'heading' && link.first
        ? `[${link.label}](/wiki/${pageId})`
        : link.label,
  );
}
