/**
 * Shared reads behind the connections read model (relations.ts and
 * relation-edges.ts): which pages exist, which names resolve to them, and
 * the relationship_mentions rows. Resolution is by exact title or alias
 * only, case-insensitive; no fuzzy matching, so a short name never lands on
 * an unrelated page.
 */

import type Database from 'better-sqlite3';
import { getAllArchivedPageIds } from './db';
import { numericConflict } from './name-guard';
import type { RelationRow } from './relation-rows';

/** The Saved Links page is bookkeeping, never a connection. */
const SAVED_LINKS_PAGE_ID = 'saved-links';

export interface PageInfo {
  title: string;
  /** page_type 'archived', or every backing source archived. */
  archived: boolean;
}

/** Every page except Saved Links, with its title and archived state. */
export function loadPages(db: Database.Database): Map<string, PageInfo> {
  const archivedIds = getAllArchivedPageIds();
  const rows = db.prepare('SELECT page_id, title, page_type FROM pages').all() as Array<{
    page_id: string;
    title: string;
    page_type: string;
  }>;
  const pages = new Map<string, PageInfo>();
  for (const r of rows) {
    if (r.page_id === SAVED_LINKS_PAGE_ID) continue;
    pages.set(r.page_id, { title: r.title, archived: r.page_type === 'archived' || archivedIds.has(r.page_id) });
  }
  return pages;
}

/**
 * Lowercased name -> page_id. Within a tier an exact title wins, then an
 * alias row naming its page (canonical_page_id), then an alias whose
 * canonical name is a page title; the newest alias row wins, and the first
 * name written is kept. Aliases whose two names carry different numbers are
 * skipped, as in getAliases(). Live pages form the first tier, complete
 * with their aliases; with includeArchived, archived pages follow as a
 * second tier, so they only take names no live page claims.
 */
export function buildNameMap(
  db: Database.Database,
  pages: Map<string, PageInfo>,
  includeArchived: boolean
): Map<string, string> {
  const aliases = (
    db
      .prepare('SELECT alias, canonical_name, canonical_page_id FROM aliases ORDER BY id DESC')
      .all() as Array<{ alias: string; canonical_name: string; canonical_page_id: string | null }>
  ).filter((a) => numericConflict(a.alias, a.canonical_name) === null);

  const map = new Map<string, string>();
  const claim = (key: string, pageId: string) => {
    if (!map.has(key)) map.set(key, pageId);
  };
  for (const archivedTier of includeArchived ? [false, true] : [false]) {
    const titles = new Map<string, string>();
    for (const [pageId, page] of pages) {
      const key = page.title.toLowerCase();
      if (page.archived === archivedTier && !titles.has(key)) titles.set(key, pageId);
    }
    for (const [key, pageId] of titles) claim(key, pageId);
    for (const a of aliases) {
      const page = a.canonical_page_id ? pages.get(a.canonical_page_id) : undefined;
      if (page?.archived === archivedTier) claim(a.alias.toLowerCase(), a.canonical_page_id as string);
    }
    for (const a of aliases) {
      const pageId = titles.get(a.canonical_name.toLowerCase());
      if (pageId !== undefined) claim(a.alias.toLowerCase(), pageId);
    }
  }
  return map;
}

/** All relationship_mentions rows, newest first. */
export function loadRelationRows(db: Database.Database): RelationRow[] {
  return db
    .prepare(
      `SELECT from_canonical, to_canonical, relationship_type, source_id, description
         FROM relationship_mentions
        ORDER BY first_seen_at DESC, source_id, rowid`
    )
    .all() as RelationRow[];
}
