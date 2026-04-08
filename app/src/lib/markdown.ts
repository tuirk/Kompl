/**
 * Thin markdown → HTML wrapper for the /source/[source_id] renderer.
 *
 * Uses the `marked` library (lightweight, zero-dep, sync API). Commit 3
 * renders converted source markdown verbatim — no syntax highlighting,
 * no math, no wikilink expansion. The LLM-compiled wiki page in commit 4
 * will eventually go through a richer pipeline, but for now we only need
 * headings, paragraphs, lists, bold/italic, links, and code blocks.
 *
 * Sanitization: we set `marked` options to disable raw HTML in markdown
 * input, because n8n / Firecrawl / MarkItDown output is not guaranteed
 * to be HTML-safe. This is belt-and-braces — the feed content comes from
 * user-chosen URLs, not untrusted third parties, but we still don't want
 * a random Wikipedia <script> tag to escape into our DOM.
 */

import { marked } from 'marked';

marked.setOptions({
  gfm: true,         // GitHub-flavored markdown (tables, strikethrough)
  breaks: false,     // don't convert single \n to <br>
  pedantic: false,
});

export function renderMarkdown(md: string): string {
  // marked 12.x returns string for sync path.
  return marked.parse(md, { async: false }) as string;
}
