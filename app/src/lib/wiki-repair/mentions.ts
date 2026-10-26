/**
 * Step 3 of the wiki repair: every source's mentions credited again from its
 * extraction (plan 1.5, applied to the whole wiki), and the pages whose
 * credited sources change as a result.
 *
 * A source's rows are rebuilt the way extract writes them
 * (lib/mention-rows.ts buildSourceMentionRows through
 * lib/mention-pin.ts buildMentionPin): an entity or concept page's own
 * title first, then the newest active alias, else the name as written. So
 * an alias the repair retired, or one still set aside, no longer sends a
 * source to the wrong page, in mentions and in relations alike.
 *
 * A page's mention set is the sources whose rows name its title
 * (entity_mentions.canonical_name, COLLATE NOCASE). A source that stops
 * naming an entity or concept page leaves it; one that starts naming it
 * joins it. Only pages whose credited sources (provenance) actually change
 * are rebuilt: a source that never contributed to the page has nothing to
 * take back, and one already credited has nothing to add.
 *
 * Reads here never write: the plan (dry run) runs the same computation over
 * other alias sets.
 */

import type Database from 'better-sqlite3';

import { rebuildWikiMentions } from '../db';
import { isDraftedPage } from '../draft-rules';
import { buildMentionPin, mentionKey } from '../mention-pin';
import { buildSourceMentionRows, type SourceMentionRows } from '../mention-rows';
import type { PendingPage } from './state';

/** canonical_name is COLLATE NOCASE, which folds ASCII letters only. */
export const nocase = (name: string): string => name.replace(/[A-Z]/g, (c) => c.toLowerCase());

export interface AliasPair {
  alias: string;
  canonical_name: string;
}

export interface WikiExtractions {
  /** Each source's parsed extraction, oldest first. */
  items: Array<{ source_id: string; llm: Record<string, unknown> }>;
  /** mentionKey(name) → the sources whose extraction lists that entity or concept name. */
  namedBy: Map<string, Set<string>>;
}

const named = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .map((x) => (x && typeof x === 'object' ? (x as { name?: unknown }).name : null))
        .filter((n): n is string => typeof n === 'string' && n.trim() !== '')
    : [];

/**
 * Every source's extraction that parses to an object. A source whose
 * extraction is missing or does not parse is left out, so its rows stay as
 * they are.
 */
export function readWikiExtractions(db: Database.Database): WikiExtractions {
  const rows = db
    .prepare(
      `SELECT e.source_id, e.llm_output FROM extractions e
         JOIN sources s ON s.source_id = e.source_id
        ORDER BY e.created_at, e.source_id`
    )
    .all() as Array<{ source_id: string; llm_output: string | null }>;
  const items: WikiExtractions['items'] = [];
  const namedBy = new Map<string, Set<string>>();
  for (const row of rows) {
    let llm: unknown;
    try {
      llm = row.llm_output ? JSON.parse(row.llm_output) : null;
    } catch {
      continue;
    }
    if (!llm || typeof llm !== 'object' || Array.isArray(llm)) continue;
    const obj = llm as Record<string, unknown>;
    items.push({ source_id: row.source_id, llm: obj });
    for (const name of [...named(obj.entities), ...named(obj.concepts)]) {
      const key = mentionKey(name);
      const set = namedBy.get(key) ?? new Set<string>();
      set.add(row.source_id);
      namedBy.set(key, set);
    }
  }
  return { items, namedBy };
}

/** Entity and concept pages Kompl drafts, by title (NOCASE key). */
export function topicPagesByKey(db: Database.Database): Map<string, Array<{ page_id: string; title: string }>> {
  const rows = db
    .prepare(`SELECT page_id, title, page_type FROM pages WHERE page_type IN ('entity', 'concept') ORDER BY title, page_id`)
    .all() as Array<{ page_id: string; title: string; page_type: string }>;
  const byKey = new Map<string, Array<{ page_id: string; title: string }>>();
  for (const r of rows) {
    if (!isDraftedPage(r)) continue;
    byKey.set(nocase(r.title), [...(byKey.get(nocase(r.title)) ?? []), { page_id: r.page_id, title: r.title }]);
  }
  return byKey;
}

/** The pin extract uses: entity and concept page titles first, then `aliases` (oldest first). */
export function repairPin(db: Database.Database, aliases: AliasPair[]): (name: string) => string {
  const titles = db
    .prepare(`SELECT title FROM pages WHERE page_type IN ('entity', 'concept') ORDER BY title, page_type`)
    .all() as Array<{ title: string }>;
  return buildMentionPin(titles, aliases);
}

/** Every source's new rows through `aliases`. */
export function wikiMentionRows(db: Database.Database, ext: WikiExtractions, aliases: AliasPair[]): SourceMentionRows[] {
  const pin = repairPin(db, aliases);
  return ext.items.map(({ source_id, llm }) => buildSourceMentionRows(llm, source_id, (name) => pin(name)));
}

/**
 * The pages whose credited sources change when `rows` replace the stored
 * rows of their sources: for each entity or concept page, the credited
 * sources that stop naming it and the active sources that start to.
 */
export function pageCreditChanges(db: Database.Database, rows: SourceMentionRows[]): PendingPage[] {
  const pages = topicPagesByKey(db);
  const oldKeys = new Map<string, Set<string>>();
  for (const r of db.prepare('SELECT canonical_name, source_id FROM entity_mentions').all() as Array<{
    canonical_name: string;
    source_id: string;
  }>) {
    const set = oldKeys.get(r.source_id) ?? new Set<string>();
    set.add(nocase(r.canonical_name));
    oldKeys.set(r.source_id, set);
  }
  const credited = db.prepare('SELECT 1 FROM provenance WHERE page_id = ? AND source_id = ? LIMIT 1');
  const active = db.prepare("SELECT 1 FROM sources WHERE source_id = ? AND status = 'active'");

  const changes = new Map<string, PendingPage>();
  const touch = (page: { page_id: string; title: string }) => {
    const entry = changes.get(page.page_id) ?? { page_id: page.page_id, title: page.title, remove: [], add: [] };
    changes.set(page.page_id, entry);
    return entry;
  };
  for (const { source_id, entities } of rows) {
    const before = oldKeys.get(source_id) ?? new Set<string>();
    const after = new Set(entities.map((e) => nocase(e.canonical_name)));
    for (const key of before) {
      if (after.has(key)) continue;
      for (const page of pages.get(key) ?? []) {
        if (credited.get(page.page_id, source_id)) touch(page).remove.push(source_id);
      }
    }
    for (const key of after) {
      if (before.has(key)) continue;
      for (const page of pages.get(key) ?? []) {
        if (!credited.get(page.page_id, source_id) && active.get(source_id)) touch(page).add.push(source_id);
      }
    }
  }
  return [...changes.values()]
    .filter((p) => p.remove.length > 0 || p.add.length > 0)
    .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
}

/**
 * Pages still waiting from an earlier run, with this run's changes folded
 * in: a source both dropped and re-added cancels out.
 */
export function mergePendingPages(earlier: PendingPage[], now: PendingPage[]): PendingPage[] {
  const merged = new Map<string, PendingPage>();
  for (const p of [...earlier, ...now]) {
    const prev = merged.get(p.page_id);
    if (!prev) {
      merged.set(p.page_id, { ...p, remove: [...new Set(p.remove)], add: [...new Set(p.add)] });
      continue;
    }
    const remove = new Set(prev.remove);
    const add = new Set(prev.add);
    for (const id of p.remove) {
      if (add.has(id)) add.delete(id);
      else remove.add(id);
    }
    for (const id of p.add) {
      if (remove.has(id)) remove.delete(id);
      else add.add(id);
    }
    merged.set(p.page_id, { page_id: p.page_id, title: p.title, remove: [...remove], add: [...add] });
  }
  return [...merged.values()].filter((p) => p.remove.length > 0 || p.add.length > 0);
}

/**
 * Writes the new rows (one transaction, db.ts rebuildWikiMentions) and
 * returns the pages whose credited sources change. `persist` runs in the
 * same transaction, so the list of pages to rebuild is saved with the rows.
 */
export function recreditMentions(
  db: Database.Database,
  aliases: AliasPair[],
  persist: (changes: PendingPage[], sources: number) => void,
): { sources: number; changes: PendingPage[] } {
  const rows = wikiMentionRows(db, readWikiExtractions(db), aliases);
  let result = { sources: 0, changes: [] as PendingPage[] };
  db.transaction(() => {
    const changes = pageCreditChanges(db, rows);
    const sources = rebuildWikiMentions(rows);
    persist(changes, sources);
    result = { sources, changes };
  })();
  return result;
}
