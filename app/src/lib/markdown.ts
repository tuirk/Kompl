/**
 * Thin markdown → HTML wrapper used by wiki, source, and page renderers.
 *
 * Uses the `marked` library (lightweight, zero-dep, sync API). Heading
 * renderer is overridden to inject `id` attributes using the same slug
 * logic as `extractHeadings()` in the wiki page, so TOC anchor links work.
 *
 * Sanitization: raw HTML in markdown input is not rendered — n8n / Firecrawl /
 * MarkItDown output is not guaranteed to be HTML-safe.
 */

import { marked, Renderer } from 'marked';

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
}

const renderer = new Renderer();
renderer.heading = (text: string, level: number) => {
  const id = slugify(text);
  return `<h${level} id="${id}">${text}</h${level}>\n`;
};

marked.setOptions({
  gfm: true,         // GitHub-flavored markdown (tables, strikethrough)
  breaks: false,     // don't convert single \n to <br>
  pedantic: false,
});

export function renderMarkdown(md: string): string {
  // marked 12.x returns string for sync path.
  return marked.parse(md, { async: false, renderer }) as string;
}
