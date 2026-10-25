/**
 * "Missing pages": names the sources keep naming that have no page yet. One
 * definition for the knowledge graph's "Show missing pages" (relation-edges.ts)
 * and for wiki_status, research_topic and the health check (wiki-health.ts),
 * so they never disagree about a name. A name counts when:
 *   - the extraction named it (entity_mentions: alias-pinned names, concepts
 *     included) in at least `minSources` sources, counting only mentions
 *     typed as something a page could be about, not a date, amount or number;
 *   - no page has it as its title or an alias, whatever the case. Archived
 *     pages cover their names too: the user put that page away, it is no gap.
 * Ranked as Wikipedia ranks its wanted pages: by how many pages name it (a
 * typed relation between the page and the name), then by sources, then A-Z.
 * Each caller keeps its own threshold and length. Reads only.
 */

import type Database from 'better-sqlite3';
import { buildNameMap, loadPages, loadRelationRows } from './relation-names';
import type { RelationRow } from './relation-rows';

/** Entity types that name amounts, dates and positions ("2009", "second", "40%"), not topics. */
export const NON_TOPIC_TYPES: readonly string[] = ['DATE', 'TIME', 'PERCENT', 'MONEY', 'QUANTITY', 'ORDINAL', 'CARDINAL'];

export interface MissingPage {
  name: string;
  /** Sources that name it (as a topic). */
  source_count: number;
  /** The pages it is named with, by id; empty when only the sources name it. */
  page_ids: string[];
}

/** Relation ends with no shown page, by lowercased name: the name as a row wrote it, and the shown pages it relates to. */
export type NamedWith = Map<string, { name: string; pageIds: Set<string> }>;

/** From relation rows with exactly one end on a shown page (`names`: lowercased name -> page id): the other end. */
export function namedWithPages(rows: Iterable<RelationRow>, names: ReadonlyMap<string, string>): NamedWith {
  const namedWith: NamedWith = new Map();
  for (const row of rows) {
    const fromId = names.get(row.from_canonical.toLowerCase());
    const toId = names.get(row.to_canonical.toLowerCase());
    if ((fromId === undefined) === (toId === undefined)) continue;
    const name = fromId !== undefined ? row.to_canonical : row.from_canonical;
    const key = name.toLowerCase();
    let entry = namedWith.get(key);
    if (!entry) {
      entry = { name, pageIds: new Set() };
      namedWith.set(key, entry);
    }
    entry.pageIds.add((fromId ?? toId) as string);
  }
  return namedWith;
}

export interface MissingOptions {
  /** Sources a name needs. */
  minSources: number;
  /** Names returned at most. */
  limit: number;
  /** Only names some shown page is named with (the graph draws a line to each). */
  linkedOnly?: boolean;
}

/**
 * The missing pages, given the names some shown page is named with and
 * every name a page covers (`anyPage`, archived pages included).
 */
export function rankMissingPages(
  db: Database.Database, namedWith: NamedWith, anyPage: ReadonlyMap<string, string>, opts: MissingOptions
): MissingPage[] {
  const counted = db
    .prepare(
      `SELECT canonical_name AS name, COUNT(DISTINCT source_id) AS sources
         FROM entity_mentions
        WHERE UPPER(COALESCE(entity_type, '')) NOT IN (${NON_TOPIC_TYPES.map(() => '?').join(', ')})
        GROUP BY canonical_name
       HAVING COUNT(DISTINCT source_id) >= ?`
    )
    .all(...NON_TOPIC_TYPES, opts.minSources) as Array<{ name: string; sources: number }>;
  // NOCASE folds ASCII letters only: names that differ in other letters' case meet here.
  const found = new Map<string, MissingPage>();
  for (const { name, sources } of counted) {
    const key = name.toLowerCase();
    if (anyPage.has(key) || (found.get(key)?.source_count ?? 0) >= sources) continue;
    const linked = namedWith.get(key);
    if (opts.linkedOnly && !linked) continue;
    found.set(key, { name: linked?.name ?? name, source_count: sources, page_ids: linked ? [...linked.pageIds].sort() : [] });
  }
  return [...found.values()]
    .sort((x, y) => y.page_ids.length - x.page_ids.length || y.source_count - x.source_count || x.name.localeCompare(y.name))
    .slice(0, opts.limit);
}

/** The missing pages of the live wiki, for callers that have nothing loaded (wiki_status, the health check). */
export function findMissingPages(db: Database.Database, opts: MissingOptions): MissingPage[] {
  const pages = loadPages(db);
  const live = buildNameMap(db, pages, false);
  return rankMissingPages(db, namedWithPages(loadRelationRows(db), live), buildNameMap(db, pages, true), opts);
}
