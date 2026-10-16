/**
 * Page-level edges for the graph: one per unordered page pair, carrying the
 * typed relations between the two pages and whether a wikilink joins them.
 * Plus the most-named relation ends that have no page yet. Reads only.
 */

import { getDb } from './db';
import { buildNameMap, loadPages, loadRelationRows } from './relation-names';
import { compareRelationLabels, isSymmetricRelation, relationLabel, type RelationDirection } from './relation-labels';

/** Missing-page names returned, and the sources (entity_mentions) each needs. */
const MISSING_MAX = 40;
const MISSING_MIN_SOURCES = 2;

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

export interface MissingPage {
  name: string;
  source_count: number;
  page_ids: string[];
}

export interface RelationEdges {
  edges: RelationEdge[];
  /** Names typed-linked to a shown page, with no page at all, named in 2+ sources. */
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
  const missing = new Map<string, { name: string; pageIds: Set<string> }>();

  for (const row of loadRelationRows(db)) {
    const fromId = names.get(row.from_canonical.toLowerCase()) ?? null;
    const toId = names.get(row.to_canonical.toLowerCase()) ?? null;
    const type = row.relationship_type;
    if (fromId !== null && toId !== null) {
      if (fromId === toId) continue;
      const pair = pairOf(fromId, toId);
      const direction: RelationDirection = fromId === pair.source ? 'out' : 'in';
      const key = isSymmetricRelation(type) ? type : `${type}\u0000${direction}`;
      let rel = pair.relations.get(key);
      if (!rel) {
        rel = { type, direction, sources: new Set() };
        pair.relations.set(key, rel);
      }
      rel.sources.add(row.source_id);
    } else if (fromId !== null || toId !== null) {
      const name = fromId !== null ? row.to_canonical : row.from_canonical;
      const key = name.toLowerCase();
      if (anyPage.has(key)) continue; // it has a page, just not a shown one
      let entry = missing.get(key);
      if (!entry) {
        entry = { name, pageIds: new Set() };
        missing.set(key, entry);
      }
      entry.pageIds.add((fromId ?? toId) as string);
    }
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

  const mentionCount = db.prepare(
    'SELECT COUNT(DISTINCT source_id) AS n FROM entity_mentions WHERE canonical_name = ?'
  );
  const missingPages = [...missing.values()]
    .map((m) => ({
      name: m.name,
      source_count: (mentionCount.get(m.name) as { n: number }).n,
      page_ids: [...m.pageIds].sort(),
    }))
    .filter((m) => m.source_count >= MISSING_MIN_SOURCES)
    .sort((x, y) => y.source_count - x.source_count || x.name.localeCompare(y.name))
    .slice(0, MISSING_MAX);

  return { edges, missing: missingPages };
}
