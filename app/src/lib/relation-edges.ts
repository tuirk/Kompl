/**
 * Page-level edges for the graph: one per unordered page pair, carrying the
 * typed relations between the two pages and whether a wikilink joins them.
 * Plus the missing pages (missing-pages.ts) named with a shown page, which
 * the graph joins to those pages. Reads only.
 */

import { getDb } from './db';
import { MISSING_PAGE_MIN_SOURCES, namedWithPages, rankMissingPages, type MissingPage } from './missing-pages';
import { buildNameMap, loadPages, loadRelationRows } from './relation-names';
import { compareRelationLabels, isSymmetricRelation, relationLabel, type RelationDirection } from './relation-labels';

export type { MissingPage } from './missing-pages';

/** Missing-page names returned; each needs MISSING_PAGE_MIN_SOURCES sources, as in wiki_status. */
const MISSING_MAX = 40;

/** `direction` is read from the edge's `source` page. */
export interface EdgeRelation {
  type: string;
  direction: RelationDirection;
  source_count: number;
}

export interface RelationEdge {
  source: string;
  target: string;
  /** Strongest first: most sources, then the label order. */
  relations: EdgeRelation[];
  wikilink: boolean;
  /** Most sources behind one typed relation; 0 when only a wikilink. */
  weight: number;
}

export interface RelationEdges {
  edges: RelationEdge[];
  /** Missing pages named with a shown page, from MISSING_PAGE_MIN_SOURCES sources; most pages, then most sources first. */
  missing: MissingPage[];
}

/**
 * Archived pages are left out unless includeArchived; Saved Links always.
 * Symmetric relation types (relation-labels.ts) merge both directions into
 * one relation that keeps the direction of its newest row.
 */
export function getRelationEdges(opts: { includeArchived?: boolean } = {}): RelationEdges {
  const db = getDb();
  const includeArchived = opts.includeArchived ?? false;
  const pages = loadPages(db);
  const names = buildNameMap(db, pages, includeArchived);
  const anyPage = includeArchived ? names : buildNameMap(db, pages, true);
  const shown = (id: string) => {
    const page = pages.get(id);
    return page !== undefined && (includeArchived || !page.archived);
  };

  type Pair = { source: string; target: string; relations: Map<string, { type: string; direction: RelationDirection; sources: Set<string> }>; wikilink: boolean };
  const pairs = new Map<string, Pair>();
  const pairOf = (a: string, b: string): Pair => {
    const [source, target] = a < b ? [a, b] : [b, a];
    const key = `${source}\u0000${target}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = { source, target, relations: new Map(), wikilink: false };
      pairs.set(key, pair);
    }
    return pair;
  };
  const rows = loadRelationRows(db);
  for (const row of rows) {
    const fromId = names.get(row.from_canonical.toLowerCase()) ?? null;
    const toId = names.get(row.to_canonical.toLowerCase()) ?? null;
    if (fromId === null || toId === null || fromId === toId) continue;
    const type = row.relationship_type;
    const pair = pairOf(fromId, toId);
    const direction: RelationDirection = fromId === pair.source ? 'out' : 'in';
    const key = isSymmetricRelation(type) ? type : `${type}\u0000${direction}`;
    let rel = pair.relations.get(key);
    if (!rel) {
      rel = { type, direction, sources: new Set() };
      pair.relations.set(key, rel);
    }
    rel.sources.add(row.source_id);
  }

  const links = db
    .prepare(`SELECT source_page_id AS a, target_page_id AS b FROM page_links WHERE link_type = 'wikilink'`)
    .all() as Array<{ a: string; b: string }>;
  for (const { a, b } of links) {
    // loadPages leaves out Saved Links, so shown() drops it too.
    if (a !== b && shown(a) && shown(b)) pairOf(a, b).wikilink = true;
  }

  const edges = [...pairs.values()]
    .map((p): RelationEdge => {
      const relations = [...p.relations.values()]
        .map((r) => ({ type: r.type, direction: r.direction, source_count: r.sources.size }))
        .sort(
          (x, y) =>
            y.source_count - x.source_count ||
            compareRelationLabels(relationLabel(x.type, x.direction), relationLabel(y.type, y.direction))
        );
      return {
        source: p.source,
        target: p.target,
        relations,
        wikilink: p.wikilink,
        weight: relations.reduce((max, r) => Math.max(max, r.source_count), 0),
      };
    })
    .sort((x, y) => (x.source < y.source ? -1 : x.source > y.source ? 1 : x.target < y.target ? -1 : x.target > y.target ? 1 : 0));

  const missing = rankMissingPages(db, namedWithPages(rows, names), anyPage, {
    minSources: MISSING_PAGE_MIN_SOURCES,
    limit: MISSING_MAX,
    linkedOnly: true,
  });
  return { edges, missing };
}
