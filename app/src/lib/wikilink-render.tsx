import Link from 'next/link';
import type { ReactNode } from 'react';

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * Inline-render [[Page Title]] wikilinks in plain prose (no markdown features).
 * Resolvable titles emit a Next.js <Link>; unresolvable titles render as plain
 * text (no broken link). Use in contexts where the surrounding element is NOT
 * already an <a> — nested anchors are invalid HTML.
 *
 * For listing cards/rows that are themselves wrapped in <Link>, use
 * stripWikilinkBrackets() instead.
 */
export function renderInlineWikilinks(
  text: string,
  titleMap: Map<string, string>,
): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = new RegExp(WIKILINK_RE);
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const title = m[1];
    const pageId = titleMap.get(title.toLowerCase());
    if (pageId) {
      parts.push(
        <Link key={`${m.index}-${title}`} href={`/wiki/${pageId}`}>
          {title}
        </Link>,
      );
    } else {
      parts.push(title);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/**
 * Strip [[ ]] wikilink syntax to plain text. Use in contexts already wrapped
 * in a <Link> (listing cards, search rows) where nesting another anchor would
 * be invalid HTML.
 */
export function stripWikilinkBrackets(text: string): string {
  return text.replace(WIKILINK_RE, (_, title: string) => title);
}
