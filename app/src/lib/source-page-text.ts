/**
 * A source's own page (source-summary): the source text comes from the
 * stored source, word for word, and the model writes only the frontmatter
 * and the sections after it (Key Facts, Entities Mentioned, Concepts).
 *
 * The model used to copy the whole source into its reply. A long one (a
 * 265k-character report, a long Wikipedia article) does not fit in a
 * reply: such pages were saved cut off mid-link, and once a cut-off reply
 * failed instead, they failed (owner decision 2026-10-25: text from the
 * file, the model writes the rest). Used by every path that drafts a
 * source page: the compile draft step, recompile and redraft.
 */

import { normalizeFrontmatter } from './draft-cleanup';

/**
 * The page: the draft's frontmatter, the source text, then the draft's
 * sections. Anything the model still wrote before its first "## " section
 * is dropped, since the source text stands there.
 */
export function withSourceText(draft: string, sourceText: string): string {
  const md = normalizeFrontmatter(draft);
  const end = md.startsWith('---\n') ? md.indexOf('\n---\n', 4) : -1;
  const front = end === -1 ? '' : md.slice(0, end + 5);
  const body = end === -1 ? md : md.slice(end + 5);
  const firstSection = body.search(/^## /m);
  const sections = firstSection === -1 ? '' : body.slice(firstSection).trim();
  return [front.trimEnd(), sourceText.trim(), sections].filter((part) => part.length > 0).join('\n\n') + '\n';
}
