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

/**
 * Strip YAML frontmatter before rendering.
 * Handles both proper `---`-fenced frontmatter and bare YAML (no fences) —
 * older drafts from before the prompt fix sometimes omitted the fences,
 * which left raw `title: ... page_type: ...` prose at the top of the page.
 */
export function stripFrontmatter(md: string): string {
  // Case A: --- ... --- fenced frontmatter.
  if (md.startsWith('---\n')) {
    const end = md.indexOf('\n---\n', 4);
    if (end !== -1) return md.slice(end + 5);
    return md;
  }
  // Case B: bare YAML — only strip if the first line is a known frontmatter key,
  // to avoid accidentally eating body content that happens to start with `foo: bar`.
  const firstKey = md.match(/^([a-zA-Z_][\w-]*):\s/);
  if (!firstKey) return md;
  const known = new Set([
    'title', 'page_type', 'category', 'summary', 'sources', 'last_updated',
  ]);
  if (!known.has(firstKey[1])) return md;

  const lines = md.split('\n');
  let i = 0;
  let terminatedByDelimiter = false;
  while (i < lines.length) {
    const l = lines[i];
    if (l === '') break;
    // A lone `---` or a standalone ``` line also terminates — the dominant imported
    // shape from the pre-fix LLM is "<bare YAML> / ``` / <body to EOF>" with no
    // closing fence anywhere.
    const trimmed = l.trim();
    if (trimmed === '---' || trimmed === '```') {
      terminatedByDelimiter = true;
      break;
    }
    // Accept top-level YAML keys, indented continuations, and list items.
    const yamlish =
      /^[a-zA-Z_][\w-]*:/.test(l) || /^[ \t]/.test(l) || /^-\s/.test(l);
    if (!yamlish) return md; // Body content detected mid-stream — don't strip.
    i++;
  }
  // Skip the terminator line itself, then any immediately-following blank line.
  let bodyStart = i + 1;
  if (terminatedByDelimiter && lines[bodyStart] === '') bodyStart++;
  return lines.slice(bodyStart).join('\n');
}

/**
 * Strip a ```markdown wrapper the LLM sometimes adds around the page body.
 *
 * Two variants survive in imported pages:
 *   - Matched pair: body starts with ``` and ends with ```
 *   - Unmatched opener: body starts with ``` but never closes (renders as an
 *     EOF-spanning code block). Dominant imported shape.
 *
 * We only strip *plain* fences (``` or ```markdown / ```md) — a language-tagged
 * fence like ```python at line 0 is treated as a real code block, not a wrapper.
 */
export function stripWrappingFence(md: string): string {
  const lines = md.split('\n');
  // Skip leading blank lines to locate the first content line.
  let start = 0;
  while (start < lines.length && lines[start].trim() === '') start++;
  if (start >= lines.length) return md;

  const firstContent = lines[start].trim();
  const isWrapperOpener =
    firstContent === '```' ||
    firstContent === '```markdown' ||
    firstContent === '```md';
  if (!isWrapperOpener) return md;

  // Find trailing content line; if it's a plain closing ```, strip both ends.
  let end = lines.length - 1;
  while (end >= start && lines[end].trim() === '') end--;
  const lastIsCloser = end > start && lines[end].trim() === '```';

  const innerStart = start + 1;
  const innerEnd = lastIsCloser ? end - 1 : lines.length - 1;
  return lines.slice(innerStart, innerEnd + 1).join('\n');
}

/**
 * Remove a `## Sources` heading and its following list from the body.
 * The wiki footer already renders provenance; older drafts duplicated this in-body.
 * Scope: strip from `## Sources` until the next `## ` heading or end of document.
 */
export function stripSourcesSection(md: string): string {
  return md.replace(
    /(^|\n)##\s+Sources\s*\n[\s\S]*?(?=\n##\s|\n?$)/i,
    '$1',
  );
}

/**
 * Remove a leading `## Content` heading (but keep its content).
 * The outer "CONTENT" section divider owns the label now, so an in-body
 * `## Content` at the top duplicates it. Source-summary pages emitted by
 * the pre-fix prompt all had this. We only strip the first heading in the
 * document — a `## Content` appearing deeper is legitimate.
 */
export function stripLeadingContentHeading(md: string): string {
  return md.replace(/^\s*##\s+Content\s*\n/, '');
}
