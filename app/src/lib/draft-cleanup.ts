/**
 * Deterministic cleanup of freshly drafted pages, before they are stored.
 *
 * The draft prompt asks for the same things, but models don't always follow
 * it; these passes make the stored page right regardless of the model:
 *
 *   normalizeFrontmatter   keep only the frontmatter keys the app reads
 *   tidyDraftLinks         no links to source pages or the page itself, each
 *                          page linked once, Related lists short and relevant
 *
 * Existing pages are never rewritten by these passes: they run on new drafts
 * only (compile draft/crossref, recompile).
 */

import { isRelatedHeading, parseHeading } from './page-sections';
import { rewriteWikilinksByScope, wikilinkText } from './wikilink-scopes';
import { findWikilinks } from './wikilink-syntax';

/** Pages that hold one source's text. Sources are cited, never linked inline. */
export const SOURCE_PAGE_TYPES: ReadonlySet<string> = new Set(['original-source', 'source-summary']);

/** Most entries a drafted "Related Concepts" list keeps (entries the page already had are always kept). */
export const MAX_RELATED_LINKS = 5;

/**
 * Lower-cased titles of source pages, minus any title that a non-source page
 * also uses (an entity page may share its name with a note).
 */
export function sourceOnlyTitles(rows: ReadonlyArray<{ title: string | null; page_type: string }>): Set<string> {
  const source = new Set<string>();
  const other = new Set<string>();
  for (const row of rows) {
    const title = (row.title ?? '').trim().toLowerCase();
    if (!title) continue;
    (SOURCE_PAGE_TYPES.has(row.page_type) ? source : other).add(title);
  }
  for (const title of other) source.delete(title);
  return source;
}

// Keys the app reads from frontmatter: category and summary (commit and
// approve), entities (page view), title and page_type (kept for readers of
// the raw file). Sources, dates and status live in the database.
const FRONTMATTER_KEYS = new Set(['title', 'page_type', 'category', 'summary', 'entities']);

/**
 * Drop every frontmatter key the app doesn't read: sources, last_updated,
 * status, contested and the like. Models can only invent those values.
 * Idempotent; markdown without a frontmatter block is returned unchanged.
 */
export function normalizeFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown;
  const lines = markdown.split('\n');
  if (lines[0].trim() !== '---') return markdown;
  const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---');
  if (end === -1) return markdown;
  const kept: string[] = [];
  let keeping = false;
  for (const line of lines.slice(1, end)) {
    const key = line.match(/^([A-Za-z_][\w-]*)\s*:/);
    // A top-level key starts at column 0; indented and "- " lines continue it.
    if (key) keeping = FRONTMATTER_KEYS.has(key[1].toLowerCase());
    if (keeping) kept.push(line);
  }
  return [lines[0], ...kept, ...lines.slice(end)].join('\n');
}

export interface TidyLinksOptions {
  /** Lower-cased titles that must not be linked: source pages and the page itself. */
  blocked: ReadonlySet<string>;
  /** Source text of the draft. A Related entry stays only if its page is mentioned here or in the body. */
  sourceText: string;
  /** Lower-cased canonical title → other names (aliases) that count as a mention. */
  surfaces?: ReadonlyMap<string, readonly string[]>;
  /** Lower-cased targets the page's Related list already had; always kept. */
  keepRelated?: ReadonlySet<string>;
  /** Trim Related lists (default true). Off for pages that reproduce a source's own text. */
  trimRelated?: boolean;
}

export interface TidyLinksResult {
  markdown: string;
  /** Links turned into plain text. */
  unlinked: number;
  /** Related entries dropped. */
  relatedDropped: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentions(text: string, name: string): boolean {
  if (name.trim().length < 2) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(name.trim())}(?![\\p{L}\\p{N}])`, 'iu').test(text);
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+\.)\s+/;

interface RelatedSection {
  /** Heading line index. */
  start: number;
  /** First line after the section. */
  end: number;
}

function findRelatedSections(lines: string[]): RelatedSection[] {
  const sections: RelatedSection[] = [];
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---');
    if (end > 0) i = end + 1;
  }
  let inFence = false;
  let open: { start: number; level: number } | null = null;
  for (; i < lines.length; i++) {
    if (lines[i].trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = parseHeading(lines[i]);
    if (!heading) continue;
    if (open && heading.level <= open.level) {
      sections.push({ start: open.start, end: i });
      open = null;
    }
    if (!open && isRelatedHeading(heading)) open = { start: i, level: heading.level };
  }
  if (open) sections.push({ start: open.start, end: lines.length });
  return sections;
}

/** Lower-cased link targets listed in a page's Related sections. */
export function relatedLinkTargets(markdown: string): Set<string> {
  const lines = markdown.split('\n');
  const targets = new Set<string>();
  for (const s of findRelatedSections(lines)) {
    for (let k = s.start + 1; k < s.end; k++) {
      for (const link of findWikilinks(lines[k])) targets.add(link.target.toLowerCase());
    }
  }
  return targets;
}

/**
 * Keep Related lists short and relevant: drop entries that point at a blocked
 * page, repeat an earlier entry, or name a page that neither the body nor the
 * sources mention; keep at most MAX_RELATED_LINKS (plus the page's existing
 * entries). A section left without entries is removed.
 */
function tidyRelatedSections(markdown: string, opts: TidyLinksOptions): { markdown: string; dropped: number } {
  const lines = markdown.split('\n');
  const sections = findRelatedSections(lines);
  if (sections.length === 0) return { markdown, dropped: 0 };

  const inSection = new Set<number>();
  for (const s of sections) for (let k = s.start; k < s.end; k++) inSection.add(k);
  const mentionText = `${lines.filter((_, idx) => !inSection.has(idx)).join('\n')}\n${opts.sourceText}`;
  const isMentioned = (target: string): boolean =>
    mentions(mentionText, target) || (opts.surfaces?.get(target) ?? []).some((s) => mentions(mentionText, s));

  let dropped = 0;
  const drop = new Set<number>();
  for (const s of sections) {
    const seen = new Set<string>();
    const forced: number[] = [];
    const candidates: number[] = [];
    for (let k = s.start + 1; k < s.end; k++) {
      const line = lines[k];
      if (!LIST_ITEM.test(line)) continue;
      const link = findWikilinks(line)[0];
      if (!link) continue;
      const target = link.target.toLowerCase();
      if (opts.blocked.has(target) || seen.has(target)) {
        drop.add(k);
        continue;
      }
      seen.add(target);
      if (opts.keepRelated?.has(target)) forced.push(k);
      else if (isMentioned(target)) candidates.push(k);
      else drop.add(k);
    }
    const budget = Math.max(0, MAX_RELATED_LINKS - forced.length);
    for (const k of candidates.slice(budget)) drop.add(k);

    const remaining = lines.slice(s.start + 1, s.end).filter((l, off) => !drop.has(s.start + 1 + off) && l.trim() !== '');
    if (remaining.length === 0) {
      // Nothing left: drop the heading and the whole section.
      for (let k = s.start; k < s.end; k++) drop.add(k);
    }
  }
  for (const k of drop) {
    const line = lines[k];
    if (LIST_ITEM.test(line) && findWikilinks(line).length > 0) dropped++;
  }
  if (drop.size === 0) return { markdown, dropped: 0 };
  // Rebuild without the dropped lines, collapsing the blank lines a removed
  // section leaves behind (and only those).
  const out: string[] = [];
  let afterDrop = false;
  for (let idx = 0; idx < lines.length; idx++) {
    if (drop.has(idx)) {
      afterDrop = true;
      continue;
    }
    const line = lines[idx];
    if (afterDrop && line.trim() === '' && (out.length === 0 || out[out.length - 1].trim() === '')) continue;
    if (line.trim() !== '') afterDrop = false;
    out.push(line);
  }
  while (afterDrop && out.length > 1 && out[out.length - 1].trim() === '' && out[out.length - 2].trim() === '') {
    out.pop();
  }
  return { markdown: out.join('\n'), dropped };
}

/**
 * Link hygiene for a drafted page:
 *   - links to blocked pages (source pages, the page itself) become plain text
 *   - each page is linked once in the body; later links become plain text
 *   - links in headings become plain text
 *   - Related lists are trimmed (see tidyRelatedSections)
 * The words of every unlinked mention are kept.
 */
export function tidyDraftLinks(markdown: string, opts: TidyLinksOptions): TidyLinksResult {
  const related = opts.trimRelated === false ? { markdown, dropped: 0 } : tidyRelatedSections(markdown, opts);
  let unlinked = 0;
  const out = rewriteWikilinksByScope(
    related.markdown,
    (link) => link.target.toLowerCase(),
    (link, key) => {
      const keep = key !== null && !opts.blocked.has(key) && link.scope !== 'heading' && link.first;
      if (keep) return wikilinkText(link);
      unlinked++;
      return link.label;
    },
  );
  return { markdown: out, unlinked, relatedDropped: related.dropped };
}
