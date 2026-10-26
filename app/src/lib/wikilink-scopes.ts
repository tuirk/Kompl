/**
 * Walk the wikilinks of a page by scope, so "link each page once" can be
 * decided the same way when a draft is cleaned up (draft-cleanup.ts) and when
 * a page is displayed (wiki-display.ts).
 *
 * Scopes:
 *   heading  — a heading line; never counts as a page's first link
 *   related  — a "Related Concepts" / "See also" section (own first-link set)
 *   table    — a markdown table block (own first-link set per table)
 *   body     — everything else (one first-link set for the whole page)
 *
 * Frontmatter, fenced code and inline code are left untouched.
 */

import { replaceWikilinks, type Wikilink } from './wikilink-syntax';
import { isRelatedHeading, parseHeading } from './page-sections';

export type LinkScope = 'body' | 'heading' | 'related' | 'table';

export interface ScopedLink extends Wikilink {
  scope: LinkScope;
  /** First link to this key in its scope. Always false for headings and unresolved links. */
  first: boolean;
}

/** Wikilink syntax for a parsed link: [[Target]] or [[Target|label]]. */
export function wikilinkText(link: Wikilink): string {
  return link.label === link.target ? `[[${link.target}]]` : `[[${link.target}|${link.label}]]`;
}

function mapOutsideInlineCode(line: string, fn: (text: string) => string): string {
  return line
    .split(/(`[^`\n]*`)/)
    .map((part, idx) => (idx % 2 === 1 ? part : fn(part)))
    .join('');
}

/**
 * Rewrite every wikilink with `render`. `keyOf` maps a link to the page it
 * points at (a page id or lower-cased title), or null when it points nowhere.
 */
export function rewriteWikilinksByScope(
  markdown: string,
  keyOf: (link: Wikilink) => string | null,
  render: (link: ScopedLink, key: string | null) => string,
): string {
  const lines = markdown.split('\n');
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---');
    if (end > 0) i = end + 1;
  }
  const bodySeen = new Set<string>();
  let tableSeen: Set<string> | null = null;
  let related: { level: number; seen: Set<string> } | null = null;
  let inFence = false;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      tableSeen = null;
      continue;
    }
    if (inFence) continue;

    let scope: LinkScope;
    let seen: Set<string> | null;
    const heading = parseHeading(line);
    if (heading) {
      if (related && heading.level <= related.level) related = null;
      if (!related && isRelatedHeading(heading)) related = { level: heading.level, seen: new Set() };
      tableSeen = null;
      scope = 'heading';
      seen = null;
    } else if (/^\s*\|/.test(line)) {
      tableSeen ??= new Set();
      scope = 'table';
      seen = tableSeen;
    } else {
      tableSeen = null;
      scope = related ? 'related' : 'body';
      seen = related ? related.seen : bodySeen;
    }

    if (!line.includes('[[')) continue;
    lines[i] = mapOutsideInlineCode(line, (text) =>
      replaceWikilinks(text, (link) => {
        const key = keyOf(link);
        let first = false;
        if (seen && key !== null) {
          first = !seen.has(key);
          seen.add(key);
        }
        return render({ ...link, scope, first }, key);
      }),
    );
  }
  return lines.join('\n');
}
