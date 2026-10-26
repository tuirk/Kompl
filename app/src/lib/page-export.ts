/**
 * Page bodies for the Markdown and Obsidian exports.
 *
 * Stored pages cite sources as [^<source id>] tokens (and older pages as raw
 * ids in assorted shapes), which an editor like Obsidian shows as raw text.
 * Exports turn them into numbered footnotes with definitions — the same
 * numbers the page view shows. The JSON and .kompl backup exports keep the
 * stored text unchanged.
 */

import { citationsToFootnotes } from './citations';
import { healedPageBody } from './markdown';
import { getNumberedSources } from './page-sources';
import { safeExternalUrl } from './safe-url';

export interface ExportedPageBody {
  /** Body with numbered footnotes and their definitions appended. */
  body: string;
  /** The page's source titles, cited ones first, each once. */
  sourceTitles: string[];
}

function footnoteText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function exportPageBody(
  pageId: string,
  raw: string,
  isKnownTitle: (title: string) => boolean,
): ExportedPageBody {
  const scan = citationsToFootnotes(healedPageBody(raw).trimStart(), isKnownTitle);
  const sources = getNumberedSources(pageId, scan.order);

  const definitions = scan.order.map((_, i) => {
    const source = sources[i];
    const title = source?.title ? footnoteText(source.title) : 'Source no longer in the wiki';
    const url = source?.source_url ? safeExternalUrl(source.source_url) : null;
    return `[^${i + 1}]: ${title}${url ? ` — <${url}>` : ''}`;
  });
  const body =
    definitions.length > 0 ? `${scan.markdown.trimEnd()}\n\n${definitions.join('\n')}\n` : scan.markdown;

  const sourceTitles: string[] = [];
  for (const source of sources) {
    const title = source.title ? footnoteText(source.title) : null;
    if (title && !sourceTitles.includes(title)) sourceTitles.push(title);
  }
  return { body, sourceTitles };
}
