/**
 * The knowledge graph payload behind GET /api/wiki/graph: every page as a
 * node (type, category, sources, how many pages it shares a line with) and
 * one line per page pair from the relations read model (relation-edges.ts:
 * typed relations, plain wikilink, weight), plus the most-named names that
 * have no page yet. Reads only. The page's colours, layout and filters are
 * worked out client-side (lib/graph-model.ts).
 */

import { getAllArchivedPageIds, getDb } from './db';
import { getRelationEdges, type MissingPage, type RelationEdge } from './relation-edges';

/** Bookkeeping, never a connection (as in the relations read model). */
const SAVED_LINKS_PAGE_ID = 'saved-links';

export interface WikiGraphNode {
  id: string;
  label: string;
  /** The page_type. */
  group: string;
  /** 'Uncategorized' when the page has none. */
  category: string;
  source_count: number;
  summary: string | null;
  last_updated: string | null;
  /** Only with include_archived: page_type 'archived', or every backing source archived. */
  archived?: boolean;
  /** Pages it shares a line with: a typed relation, a plain link, or both. */
  degree: number;
}

export interface WikiGraph {
  nodes: WikiGraphNode[];
  /** One per page pair, both ends in `nodes`. */
  links: RelationEdge[];
  missing: MissingPage[];
}

/**
 * Archived pages are left out unless includeArchived, when they come back
 * flagged `archived` (the page draws them muted). Saved Links never shows.
 */
export function getWikiGraph(includeArchived = false): WikiGraph {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT page_id AS id, title AS label, page_type AS "group",
              COALESCE(NULLIF(TRIM(category), ''), 'Uncategorized') AS category,
              source_count, summary, last_updated
         FROM pages
        WHERE page_id != ?
        ORDER BY page_id`
    )
    .all(SAVED_LINKS_PAGE_ID) as Array<Omit<WikiGraphNode, 'degree' | 'archived'>>;

  const archivedIds = getAllArchivedPageIds();
  const nodes: WikiGraphNode[] = [];
  for (const row of rows) {
    const archived = row.group === 'archived' || archivedIds.has(row.id);
    if (archived && !includeArchived) continue;
    nodes.push(archived ? { ...row, archived: true, degree: 0 } : { ...row, degree: 0 });
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const { edges, missing } = getRelationEdges({ includeArchived });
  const links = edges.filter((e) => byId.has(e.source) && byId.has(e.target));
  for (const e of links) {
    (byId.get(e.source) as WikiGraphNode).degree += 1;
    (byId.get(e.target) as WikiGraphNode).degree += 1;
  }
  return { nodes, links, missing };
}
