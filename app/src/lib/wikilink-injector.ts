/**
 * Deterministic [[wikilink]] injection.
 *
 * Replaces the LLM-based crossref step with a plain-text scan that wraps
 * known page titles (+ aliases) in `[[…]]`. O(n+m+z) via regex alternation
 * over longest-first surface forms. Zero LLM cost, sub-second for thousands
 * of pages. Matches the pattern used by MediaWiki's LinkTitles, Obsidian's
 * Automatic Linker, Logseq, and Roam.
 *
 * What's skipped (in this order of precedence per line):
 *   - YAML frontmatter (from opening `---` line through matching closing `---`)
 *   - Fenced code blocks (```…```)
 *   - Headings (lines starting with `#`)
 *   - Inline code spans (`…`)
 *   - Existing wikilinks (`[[…]]`)
 *
 * Each surface form links at most once per page (first occurrence wins) so
 * the output stays readable. Case-insensitive match on surface form, but the
 * wikilink target is always the canonical title as passed in.
 */

const MIN_SURFACE_LEN = 4;

export interface WikilinkTarget {
  /** Canonical page title — what goes inside [[…]] */
  title: string;
  /** Alternate surface forms that should also trigger a link to `title` */
  aliases?: string[];
}

export interface InjectResult {
  markdown: string;
  linksAdded: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSurfaceMap(targets: WikilinkTarget[]): Map<string, string> {
  // surfaceForm(lowercase) -> canonical title. First writer wins so a surface
  // that happens to equal someone else's alias points to whichever target
  // registered it first — caller controls ordering.
  const map = new Map<string, string>();
  for (const t of targets) {
    if (!t.title) continue;
    const registerSurface = (s: string | undefined) => {
      if (!s || s.length < MIN_SURFACE_LEN) return;
      const key = s.toLowerCase();
      if (!map.has(key)) map.set(key, t.title);
    };
    registerSurface(t.title);
    for (const a of t.aliases ?? []) registerSurface(a);
  }
  return map;
}

function buildPattern(surfaces: string[]): RegExp | null {
  if (surfaces.length === 0) return null;
  // Longest-first so "Bitcoin Cash" matches before "Bitcoin" in overlapping
  // regions. Case-insensitive via /i.
  const alt = [...surfaces]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex)
    .join('|');
  return new RegExp(`\\b(${alt})\\b`, 'gi');
}

interface Segment {
  text: string;
  linkable: boolean;
}

function tokenizeLine(line: string): Segment[] {
  const segments: Segment[] = [];
  let buffer = '';
  let i = 0;

  const flush = (linkable: boolean) => {
    if (buffer) {
      segments.push({ text: buffer, linkable });
      buffer = '';
    }
  };

  while (i < line.length) {
    // Existing wikilink — leave alone
    if (line[i] === '[' && line[i + 1] === '[') {
      flush(true);
      const end = line.indexOf(']]', i + 2);
      if (end < 0) {
        segments.push({ text: line.slice(i), linkable: false });
        return segments;
      }
      segments.push({ text: line.slice(i, end + 2), linkable: false });
      i = end + 2;
      continue;
    }
    // Inline code — leave alone
    if (line[i] === '`') {
      flush(true);
      const end = line.indexOf('`', i + 1);
      if (end < 0) {
        segments.push({ text: line.slice(i), linkable: false });
        return segments;
      }
      segments.push({ text: line.slice(i, end + 1), linkable: false });
      i = end + 1;
      continue;
    }
    buffer += line[i];
    i++;
  }
  flush(true);
  return segments;
}

function injectIntoLine(
  line: string,
  pattern: RegExp,
  surfaceMap: Map<string, string>,
  used: Set<string>
): { line: string; added: number } {
  const segments = tokenizeLine(line);
  let added = 0;
  for (const seg of segments) {
    if (!seg.linkable) continue;
    pattern.lastIndex = 0;
    seg.text = seg.text.replace(pattern, (match) => {
      const key = match.toLowerCase();
      const canonical = surfaceMap.get(key);
      if (!canonical) return match;
      // Self-link guard — pages should not link to themselves. Callers can
      // pre-filter the surfaceMap to exclude the current page's own surfaces
      // if stricter guarantees are needed.
      if (used.has(canonical)) return match;
      used.add(canonical);
      added++;
      // If surface matches canonical exactly (case-insensitive), keep the
      // surface's original casing as the display text inside a single-part
      // wikilink. Otherwise use `[[canonical|surface]]` style to preserve
      // the reader's context.
      if (match.toLowerCase() === canonical.toLowerCase()) {
        return `[[${canonical}]]`;
      }
      return `[[${canonical}|${match}]]`;
    });
  }
  return { line: segments.map((s) => s.text).join(''), added };
}

export function injectWikilinks(
  markdown: string,
  targets: WikilinkTarget[]
): InjectResult {
  const surfaceMap = buildSurfaceMap(targets);
  const pattern = buildPattern([...surfaceMap.keys()]);
  if (pattern === null) return { markdown, linksAdded: 0 };

  const lines = markdown.split('\n');
  const out: string[] = [];
  let inFrontmatter = false;
  let inFence = false;
  let linksAdded = 0;
  // Link each canonical title at most once per page so long pages don't get
  // wikilink-flooded. First occurrence wins.
  const usedCanonicals = new Set<string>();

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];

    // YAML frontmatter: opens with `---` on line 0, closes with next `---`.
    if (idx === 0 && line.trim() === '---') {
      inFrontmatter = true;
      out.push(line);
      continue;
    }
    if (inFrontmatter) {
      if (line.trim() === '---') inFrontmatter = false;
      out.push(line);
      continue;
    }

    // Fenced code block — toggles on every ``` line.
    if (line.startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    // Headings — leave bare so TOC generators don't see linked titles.
    if (line.startsWith('#')) {
      out.push(line);
      continue;
    }

    const { line: updated, added } = injectIntoLine(line, pattern, surfaceMap, usedCanonicals);
    linksAdded += added;
    out.push(updated);
  }

  return { markdown: out.join('\n'), linksAdded };
}
