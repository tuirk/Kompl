import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { dropCitationLabels } from './summary-text';
import { findWikilinks, stripWikilinks } from './wikilink-syntax';

/** Links in running text need more than colour (WCAG 1.4.1); matches `article a` in globals.css. */
export const INLINE_LINK_STYLE: CSSProperties = {
  textDecoration: 'underline',
  textDecorationThickness: 1,
  textUnderlineOffset: '0.18em',
  textDecorationColor: 'rgba(var(--accent-rgb), 0.45)',
};

/**
 * Inline-render [[Page Title]] and [[Page Title|label]] wikilinks in plain
 * prose (no markdown features). Resolvable titles emit a Next.js <Link> showing
 * the label; unresolvable titles render as plain label text (no broken link).
 * Use in contexts where the surrounding element is NOT already an <a> — nested
 * anchors are invalid HTML.
 *
 * For listing cards/rows that are themselves wrapped in <Link>, use
 * stripWikilinkBrackets() instead. Both render page summaries, so both drop
 * drafting citation labels ("[S1]") left in old summaries
 * (lib/summary-text.ts).
 */
export function renderInlineWikilinks(
  summary: string,
  titleMap: Map<string, string>,
): ReactNode[] {
  const text = dropCitationLabels(summary);
  const parts: ReactNode[] = [];
  let last = 0;
  for (const link of findWikilinks(text)) {
    if (link.index > last) parts.push(text.slice(last, link.index));
    const pageId = titleMap.get(link.target.toLowerCase());
    if (pageId) {
      parts.push(
        <Link key={`${link.index}-${link.target}`} href={`/wiki/${pageId}`} style={INLINE_LINK_STYLE}>
          {link.label}
        </Link>,
      );
    } else {
      parts.push(link.label);
    }
    last = link.index + link.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/**
 * Strip [[ ]] wikilink syntax to plain text (the display label). Use in
 * contexts already wrapped in a <Link> (listing cards, search rows) where
 * nesting another anchor would be invalid HTML. Citation labels go too.
 */
export function stripWikilinkBrackets(text: string): string {
  return stripWikilinks(dropCitationLabels(text));
}
