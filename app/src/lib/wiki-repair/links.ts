/**
 * Step 4 of the wiki repair: links written through a name match Kompl no
 * longer uses. No AI call.
 *
 * The link step of a compile (lib/wikilink-injector.ts) writes a link found
 * through a name match as [[Page|words]]: "English" became
 * [[programming language|English]] while "English" → "programming language"
 * was a name match. Once that match is set aside (lib/alias-screen.ts) or
 * retired (the repair's name check), pages that were not rewritten still
 * carry the link, and with it "Also linked", page_links and the map's
 * paths. Each such link is corrected:
 *   - when the words are exactly another page's title (any case), the link
 *     points to that page instead, still showing the same words;
 *   - otherwise the link goes and the words stay as plain text.
 * A link counts as made through an unused match only when its words differ
 * from its page's title and an unused row pairs those words with that page;
 * a pair some active row still makes is in use. Unused means suspended,
 * retired, or numbers that differ ("Python 3" → "Python 2"), as getAliases()
 * reads them. Links the writer chose otherwise ([[Vibe coding|vibe coding]],
 * a related list) are never touched.
 *
 * Pages change through the outbox commit (CLAUDE.md rule 5,
 * lib/page-rewrite.ts): the previous version is kept and page_links is
 * derived again from the new text. Saved Links is never touched; a page
 * whose text waits for the boot reconciler is left for the next run.
 */

import type Database from 'better-sqlite3';

import { getPage, readPageMarkdown } from '../db';
import { APP_PAGE_IDS } from '../draft-rules';
import { numericConflict } from '../name-guard';
import { commitPageRewrite, pageVersionToken } from '../page-rewrite';
import { findWikilinks } from '../wikilink-syntax';

const pairKey = (alias: string, canonical: string) => `${alias.trim().toLowerCase()}\u0000${canonical.trim().toLowerCase()}`;

/**
 * Name matches no compile step uses, as alias/canonical keys. `treatActive`:
 * row ids counted as in use (the plan's low end: the set-aside pairs the AI
 * may confirm).
 */
export function unusedAliasPairs(db: Database.Database, treatActive: ReadonlySet<number> = new Set()): Set<string> {
  const rows = db
    .prepare(`SELECT id, alias, canonical_name, status FROM aliases WHERE canonical_name IS NOT NULL`)
    .all() as Array<{ id: number; alias: string; canonical_name: string; status: string | null }>;
  const used = new Set<string>();
  const unused = new Set<string>();
  for (const r of rows) {
    const active = (r.status ?? 'active') === 'active' || treatActive.has(r.id);
    const inUse = active && numericConflict(r.alias, r.canonical_name) === null;
    (inUse ? used : unused).add(pairKey(r.alias, r.canonical_name));
  }
  for (const key of used) unused.delete(key);
  return unused;
}

export interface LinkContext {
  unused: ReadonlySet<string>;
  /** Lowercased title -> title, every page. */
  titles: ReadonlyMap<string, string>;
  /** The page's own title: words naming it never link to it. */
  ownTitle: string;
}

function fixText(text: string, ctx: LinkContext): { text: string; fixed: number } {
  let fixed = 0;
  let out = '';
  let last = 0;
  for (const link of findWikilinks(text)) {
    const label = link.label;
    if (label.toLowerCase() === link.target.toLowerCase() || !ctx.unused.has(pairKey(label, link.target))) continue;
    const title = ctx.titles.get(label.toLowerCase());
    const replacement =
      title !== undefined && title.toLowerCase() !== ctx.ownTitle.toLowerCase()
        ? title === label
          ? `[[${title}]]`
          : `[[${title}|${label}]]`
        : label;
    out += text.slice(last, link.index) + replacement;
    last = link.index + link.length;
    fixed++;
  }
  return fixed === 0 ? { text, fixed } : { text: out + text.slice(last), fixed };
}

/**
 * Runs `fn` over the prose of a page: the lines outside frontmatter and
 * fenced code, split around inline code. `fn` gets one stretch of text and
 * says what it fixed there.
 */
export function mapProse(
  markdown: string,
  fn: (part: string) => { text: string; fixed: number },
): { markdown: string; fixed: number } {
  const lines = markdown.split('\n');
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---');
    if (end > 0) i = end + 1;
  }
  let fixed = 0;
  let inFence = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line.includes('[[')) continue;
    lines[i] = line
      .split(/(`[^`\n]*`)/)
      .map((part, idx) => {
        if (idx % 2 === 1) return part;
        const r = fn(part);
        fixed += r.fixed;
        return r.text;
      })
      .join('');
  }
  return { markdown: fixed === 0 ? markdown : lines.join('\n'), fixed };
}

/**
 * The page text with its links through unused name matches corrected.
 * Frontmatter, fenced code and inline code are left as they are.
 */
export function correctAliasLinks(markdown: string, ctx: LinkContext): { markdown: string; fixed: number } {
  return mapProse(markdown, (part) => fixText(part, ctx));
}

function titleMap(db: Database.Database): Map<string, string> {
  const titles = new Map<string, string>();
  for (const { title } of db.prepare('SELECT title FROM pages ORDER BY title').all() as Array<{ title: string }>) {
    if (!titles.has(title.toLowerCase())) titles.set(title.toLowerCase(), title);
  }
  return titles;
}

/**
 * Pages that link to a page an unused match names: the only pages that can
 * hold such a link (page_links is derived from every page's text).
 */
function candidatePages(db: Database.Database, unused: ReadonlySet<string>): Array<{ page_id: string; title: string }> {
  const canonicals = new Set([...unused].map((k) => k.split('\u0000')[1]));
  if (canonicals.size === 0) return [];
  const targets = (db.prepare('SELECT page_id, title FROM pages').all() as Array<{ page_id: string; title: string }>)
    .filter((p) => canonicals.has(p.title.toLowerCase()))
    .map((p) => p.page_id);
  if (targets.length === 0) return [];
  return (db
    .prepare(
      `SELECT DISTINCT p.page_id, p.title FROM page_links l JOIN pages p ON p.page_id = l.source_page_id
        WHERE l.link_type = 'wikilink' AND l.target_page_id IN (${targets.map(() => '?').join(', ')})
        ORDER BY p.title COLLATE NOCASE, p.page_id`
    )
    .all(...targets) as Array<{ page_id: string; title: string }>).filter((p) => !APP_PAGE_IDS.has(p.page_id));
}

export interface LinkFixPage {
  page_id: string;
  title: string;
  links: number;
}

/** The pages whose text has links to correct, and how many each. Reads only. */
export function planLinkFixes(db: Database.Database, unused: ReadonlySet<string>): LinkFixPage[] {
  const titles = titleMap(db);
  const out: LinkFixPage[] = [];
  for (const p of candidatePages(db, unused)) {
    const markdown = readPageMarkdown(p.page_id);
    if (markdown === null) continue;
    const { fixed } = correctAliasLinks(markdown, { unused, titles, ownTitle: p.title });
    if (fixed > 0) out.push({ ...p, links: fixed });
  }
  return out;
}

export interface LinkOutcome {
  /** Pages rewritten. */
  pages: number;
  /** Links corrected on them. */
  links: number;
  /** Pages that changed meanwhile or wait for the boot reconciler: left for the next run. */
  missed: number;
}

/**
 * Corrects every page's links through unused name matches, one outbox
 * commit per page, counting into `outcome` as it goes (the run's record).
 * `beforePage` runs before each page (the run's stop check and save).
 */
export async function applyLinkFixes(
  db: Database.Database,
  beforePage: () => void = () => {},
  outcome: LinkOutcome = { pages: 0, links: 0, missed: 0 },
): Promise<LinkOutcome> {
  const unused = unusedAliasPairs(db);
  const titles = titleMap(db);
  for (const p of candidatePages(db, unused)) {
    beforePage();
    const page = getPage(p.page_id);
    if (!page) continue;
    const markdown = readPageMarkdown(page.page_id);
    if (markdown === null) continue;
    const { markdown: corrected, fixed } = correctAliasLinks(markdown, { unused, titles, ownTitle: page.title });
    if (fixed === 0) continue;
    if (page.pending_content !== null) {
      outcome.missed++;
      continue;
    }
    const result = await commitPageRewrite({
      pageId: page.page_id,
      markdown: corrected,
      expectedToken: pageVersionToken(page.page_id),
      draftRules: null,
      activity: null,
    });
    if (result.ok) {
      outcome.pages++;
      outcome.links += fixed;
    } else {
      outcome.missed++;
    }
  }
  return outcome;
}
