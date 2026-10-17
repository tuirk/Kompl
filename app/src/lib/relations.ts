/**
 * Read model for typed connections between pages: relationship_mentions rows
 * (one per relation per source, written at extract time) resolved to pages by
 * exact title or alias (relation-names.ts). Used by the page's connections
 * card, the graph and the MCP tools. Reads only; never writes.
 *
 * A relation end that resolves to no page stays a plain name (page_id null).
 * Archived pages and Saved Links are never shown as a connection.
 */

import type Database from 'better-sqlite3';
import { getDb } from './db';
import { buildNameMap, loadPages, loadRelationRows } from './relation-names';
import { compareRelationLabels, relationLabel, type RelationDirection } from './relation-labels';

export { getRelationEdges, type EdgeRelation, type MissingPage, type RelationEdge, type RelationEdges } from './relation-edges';
export { getRelationsAmong, type PageRelation, type RelationEnd } from './relation-among';

/** Evidence entries kept per connection: sentences first, newest first. */
const EVIDENCE_PER_ITEM = 3;

/**
 * One source behind a connection. Archived sources stay (they still count in
 * source_count and the page's numbered list); source_archived lets the card
 * mark them.
 */
export interface RelationEvidence {
  source_id: string;
  source_title: string;
  source_archived: boolean;
  sentence: string | null;
}

/**
 * One connection of a page. For symmetric types (the same label both ways:
 * competes_with, contradicts, related_to) both directions merge into one
 * item that keeps the direction of its newest row. Unknown types are
 * directional, so each direction is its own item and label.
 */
export interface ConnectionItem {
  page_id: string | null;
  title: string;
  type: string;
  direction: RelationDirection;
  source_count: number;
  evidence: RelationEvidence[];
}

export interface ConnectionGroup {
  label: string;
  items: ConnectionItem[];
}

export interface LinkedPage {
  page_id: string;
  title: string;
}

export interface PageConnections {
  /** In the vocabulary order (relation-labels.ts); items by sources, then title. */
  groups: ConnectionGroup[];
  /** Pages wikilinked either way that no group already lists, by title. */
  linked_only: LinkedPage[];
}

/** Name (any case) -> page_id over non-archived pages, or all pages with includeArchived. */
export function resolveNames(db: Database.Database, opts: { includeArchived?: boolean } = {}): Map<string, string> {
  return buildNameMap(db, loadPages(db), opts.includeArchived ?? false);
}

/** Typed connections of a page, grouped by label, plus its other wikilinked pages. */
export function getPageConnections(pageId: string): PageConnections {
  const db = getDb();
  const pages = loadPages(db);
  if (!pages.has(pageId)) return { groups: [], linked_only: [] };
  // Archived names resolve too, so this page's own names work when it is
  // archived, and a name of an archived page never shows as a plain name.
  const names = buildNameMap(db, pages, true);
  const shown = (id: string) => pages.get(id)?.archived === false;

  // key: other end + type + label. sentences: source_id -> sentence, newest first.
  const items = new Map<string, { item: ConnectionItem; sentences: Map<string, string | null> }>();
  for (const row of loadRelationRows(db)) {
    const fromId = names.get(row.from_canonical.toLowerCase()) ?? null;
    const toId = names.get(row.to_canonical.toLowerCase()) ?? null;
    let direction: RelationDirection;
    if (fromId === pageId && toId !== pageId) direction = 'out';
    else if (toId === pageId && fromId !== pageId) direction = 'in';
    else continue;
    const otherId = direction === 'out' ? toId : fromId;
    const otherName = direction === 'out' ? row.to_canonical : row.from_canonical;
    if (otherId !== null && !shown(otherId)) continue;

    const type = row.relationship_type;
    const end = otherId !== null ? `p:${otherId}` : `n:${otherName.toLowerCase()}`;
    const key = `${end}\u0000${type}\u0000${relationLabel(type, direction)}`;
    let entry = items.get(key);
    if (!entry) {
      const title = otherId !== null ? (pages.get(otherId) as { title: string }).title : otherName;
      entry = {
        item: { page_id: otherId, title, type, direction, source_count: 0, evidence: [] },
        sentences: new Map(),
      };
      items.set(key, entry);
    }
    if ((entry.sentences.get(row.source_id) ?? null) === null) {
      entry.sentences.set(row.source_id, row.description);
    }
  }

  const sourceRow = db.prepare('SELECT title, status FROM sources WHERE source_id = ?');
  const byLabel = new Map<string, ConnectionItem[]>();
  for (const { item, sentences } of items.values()) {
    item.source_count = sentences.size;
    const all = [...sentences];
    const ranked = [...all.filter(([, s]) => s !== null), ...all.filter(([, s]) => s === null)];
    for (const [source_id, sentence] of ranked) {
      if (item.evidence.length >= EVIDENCE_PER_ITEM) break;
      const source = sourceRow.get(source_id) as { title: string; status: string | null } | undefined;
      if (source) {
        item.evidence.push({ source_id, source_title: source.title, source_archived: source.status === 'archived', sentence });
      }
    }
    const label = relationLabel(item.type, item.direction);
    byLabel.set(label, [...(byLabel.get(label) ?? []), item]);
  }
  const groups = [...byLabel]
    .sort(([a], [b]) => compareRelationLabels(a, b))
    .map(([label, list]) => ({
      label,
      items: list.sort((a, b) => b.source_count - a.source_count || a.title.localeCompare(b.title)),
    }));

  const grouped = new Set(groups.flatMap((g) => g.items.map((i) => i.page_id)));
  const links = db
    .prepare(
      `SELECT source_page_id AS a, target_page_id AS b FROM page_links
        WHERE link_type = 'wikilink' AND (source_page_id = ? OR target_page_id = ?)`
    )
    .all(pageId, pageId) as Array<{ a: string; b: string }>;
  const linked = new Map<string, LinkedPage>();
  for (const { a, b } of links) {
    const other = a === pageId ? b : a;
    if (other === pageId || !shown(other) || grouped.has(other)) continue;
    linked.set(other, { page_id: other, title: (pages.get(other) as { title: string }).title });
  }
  const linked_only = [...linked.values()].sort((x, y) => x.title.localeCompare(y.title));
  return { groups, linked_only };
}
