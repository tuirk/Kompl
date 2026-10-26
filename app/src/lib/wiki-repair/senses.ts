/**
 * A step of the wiki repair (after the link fixes): links to a one-word name that point at the
 * wrong sense of the word. No AI call.
 *
 * Until commit ff619d66 the link step of a compile (lib/wikilink-injector.ts)
 * matched titles in any case, so the common word "vertigo" ("benign
 * paroxysmal positional vertigo") became [[Vertigo]], the Hitchcock film, and
 * the casing was lost. Such a link is turned back into plain words only when
 * the text proves the word was never the name:
 *   - the link is plain, [[Vertigo]], or labelled with the same word in
 *     lowercase, and its target is a page whose title is one capitalised word
 *     (not an acronym);
 *   - every source credited to the page was read, and none writes the word
 *     with a capital anywhere (a sentence start or a heading counts), while
 *     at least one writes it in lowercase. A page with a source that cannot
 *     be read, or no source, is left alone;
 *   - the link is not a line of its own (a chosen "related" entry).
 * The words come back in lowercase, or with their capital at the start of a
 * sentence. Pages change through the outbox commit (CLAUDE.md rule 5,
 * lib/page-rewrite.ts); Saved Links is never touched; a page whose text waits
 * for the boot reconciler is left for the next run.
 */

import type Database from 'better-sqlite3';

import { getPage, readPageMarkdown, readRawMarkdown } from '../db';
import { APP_PAGE_IDS } from '../draft-rules';
import { commitPageRewrite, pageVersionToken } from '../page-rewrite';
import { findWikilinks } from '../wikilink-syntax';
import { mapProse, type LinkFixPage, type LinkOutcome } from './links';

const ONE_CAPITALISED_WORD = /^\p{Lu}\p{Ll}+$/u;
/** A link alone on its line: a list entry the writer chose. */
const OWN_LINE = /^\s*(?:[-*+]|\d+[.)])?\s*\[\[[^\]\n]+\]\]\s*[.,;]?\s*$/;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** How the texts write the word: only in lowercase, ever with a capital, or not at all. */
export function wordCase(word: string, texts: Iterable<string>): 'lowercase' | 'capitalised' | 'absent' {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(word)}(?![\\p{L}\\p{N}])`, 'giu');
  let lower = false;
  for (const text of texts) {
    for (const m of text.matchAll(re)) {
      if (m[0] !== m[0].toLowerCase()) return 'capitalised';
      lower = true;
    }
  }
  return lower ? 'lowercase' : 'absent';
}

function sentenceStart(before: string): boolean {
  const rest = before.replace(/[\s*_>#"'(\-+]+$/, '');
  return rest === '' || /[.!?:]$/.test(rest);
}

/** The text with the links to `words` (page titles) turned into plain words. */
export function unlinkWrongSense(markdown: string, words: ReadonlySet<string>): { markdown: string; fixed: number } {
  return mapProse(markdown, (part) => {
    if (OWN_LINE.test(part)) return { text: part, fixed: 0 };
    let fixed = 0;
    let out = '';
    let last = 0;
    for (const link of findWikilinks(part)) {
      const lower = link.target.toLowerCase();
      if (!words.has(link.target) || (link.label !== link.target && link.label !== lower)) continue;
      const before = out + part.slice(last, link.index);
      out = before + (sentenceStart(before) ? link.target : lower);
      last = link.index + link.length;
      fixed++;
    }
    return fixed === 0 ? { text: part, fixed } : { text: out + part.slice(last), fixed };
  });
}

interface Candidate {
  page_id: string;
  title: string;
  targets: string[];
}

/** Pages with a wikilink to a page titled with one capitalised word, and those titles. */
function candidates(db: Database.Database): Candidate[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT p.page_id, p.title, t.title AS target
         FROM page_links l
         JOIN pages p ON p.page_id = l.source_page_id
         JOIN pages t ON t.page_id = l.target_page_id
        WHERE l.link_type = 'wikilink' AND l.source_page_id != l.target_page_id
        ORDER BY p.title COLLATE NOCASE, p.page_id`,
    )
    .all() as Array<{ page_id: string; title: string; target: string }>;
  const byPage = new Map<string, Candidate>();
  for (const r of rows) {
    if (!ONE_CAPITALISED_WORD.test(r.target) || APP_PAGE_IDS.has(r.page_id)) continue;
    const entry = byPage.get(r.page_id) ?? { page_id: r.page_id, title: r.title, targets: [] };
    entry.targets.push(r.target);
    byPage.set(r.page_id, entry);
  }
  return [...byPage.values()];
}

/** The titles among `targets` the page's own sources prove were only ever the common word. */
function provenWords(db: Database.Database, pageId: string, targets: string[], raw: Map<string, string | null>): Set<string> {
  const ids = (db.prepare('SELECT DISTINCT source_id FROM provenance WHERE page_id = ?').all(pageId) as Array<{ source_id: string }>).map(
    (r) => r.source_id,
  );
  const texts: string[] = [];
  for (const id of ids) {
    if (!raw.has(id)) {
      try {
        raw.set(id, readRawMarkdown(id));
      } catch {
        raw.set(id, null);
      }
    }
    const text = raw.get(id);
    if (text == null) return new Set(); // a source that cannot be read proves nothing
    texts.push(text);
  }
  return new Set(texts.length === 0 ? [] : targets.filter((t) => wordCase(t, texts) === 'lowercase'));
}

/** The pages with links to turn back into plain words, and how many each. Reads only. */
export function planSenseFixes(db: Database.Database): LinkFixPage[] {
  const raw = new Map<string, string | null>();
  const out: LinkFixPage[] = [];
  for (const c of candidates(db)) {
    const words = provenWords(db, c.page_id, c.targets, raw);
    const markdown = words.size > 0 ? readPageMarkdown(c.page_id) : null;
    if (markdown === null) continue;
    const { fixed } = unlinkWrongSense(markdown, words);
    if (fixed > 0) out.push({ page_id: c.page_id, title: c.title, links: fixed });
  }
  return out;
}

/** Turns the wrong-sense links back into words, one outbox commit per page, counting into `outcome`. */
export async function applySenseFixes(
  db: Database.Database,
  beforePage: () => void = () => {},
  outcome: LinkOutcome = { pages: 0, links: 0, missed: 0 },
): Promise<LinkOutcome> {
  const raw = new Map<string, string | null>();
  for (const c of candidates(db)) {
    beforePage();
    const page = getPage(c.page_id);
    const words = page ? provenWords(db, c.page_id, c.targets, raw) : new Set<string>();
    const markdown = words.size > 0 ? readPageMarkdown(c.page_id) : null;
    if (!page || markdown === null) continue;
    const { markdown: corrected, fixed } = unlinkWrongSense(markdown, words);
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
