/**
 * Read model for typed connections between pages: relationship_mentions rows
 * (one per relation per source, written at extract time) resolved to pages by
 * exact title or alias (relation-names.ts). Used by the page's connections
 * card, the graph and the MCP tools. Reads only; never writes.
 *
 * A relation end that resolves to no page stays a plain name (page_id null).
 * "Related to" is left out for an end a stronger relation already lists.
 * Archived pages and Saved Links are never shown as a connection. A
 * directed type stated both ways round shows one way, with both sides
 * listed (relation-direction.ts); a relation a later source superseded is
 * marked as possibly outdated (relation-outdated.ts).
 */

import type Database from 'better-sqlite3';
import { getDb } from './db';
import { prefersFirst, sourceDayLookup, type SourceDayOf } from './relation-direction';
import { buildNameMap, loadPages, loadRelationRows } from './relation-names';
import { compareRelationLabels, isSymmetricRelation, relationLabel, type RelationDirection } from './relation-labels';
import { loadOutdatedIndex, type OutdatedNote } from './relation-outdated';

export { getRelationEdges, type EdgeRelation, type MissingPage, type RelationEdge, type RelationEdges } from './relation-edges';
export { getRelationsAmong, type DirectionDisputeIds, type PageRelation, type RelationEnd } from './relation-among';
export type { OutdatedNote } from './relation-outdated';

/** The weakest relation type: never listed for a page another relation already joins. */
const RELATED_TO = 'related_to';

/** Evidence entries kept per connection: quotes, then sentences, newest first. */
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
  /** Kompl's one-line summary of the relation, written on reading the source. */
  sentence: string | null;
  /**
   * The source's own sentence, checked against the source at extraction
   * (v30); null when none was found, and for relations extracted before.
   */
  quote: string | null;
}

/** What one source says about a connection. */
interface SourceSays {
  sentence: string | null;
  quote: string | null;
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
  /**
   * Sources state this directed relation both ways round: the item reads the
   * way more of them say (relation-direction.ts); both sides are listed.
   * null when they agree.
   */
  direction_dispute: DirectionDispute | null;
  /** Every source is older than a "Changed" finding about both ends (relation-outdated.ts); else null. */
  outdated: OutdatedNote | null;
}

/** A source by id and title. */
export interface SourceRef {
  source_id: string;
  source_title: string;
}

/** One way round a directed relation reads, from the page, and the sources saying so (newest first). */
export interface DirectionSide {
  label: string;
  sources: SourceRef[];
}

export interface DirectionDispute {
  /** The reading the item shows. */
  kept: DirectionSide;
  /** The opposite reading, from fewer (or equally many, weaker) sources. */
  other: DirectionSide;
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

/**
 * Typed connections of a page, grouped by label, plus its other wikilinked
 * pages. Each connection keeps `evidenceLimit` sources (EVIDENCE_PER_ITEM).
 */
export function getPageConnections(pageId: string, opts: { evidenceLimit?: number } = {}): PageConnections {
  const evidenceLimit = opts.evidenceLimit ?? EVIDENCE_PER_ITEM;
  const db = getDb();
  const pages = loadPages(db);
  if (!pages.has(pageId)) return { groups: [], linked_only: [] };
  // Archived names resolve too, so this page's own names work when it is
  // archived, and a name of an archived page never shows as a plain name.
  const names = buildNameMap(db, pages, true);
  const shown = (id: string) => pages.get(id)?.archived === false;

  // key: other end + type + label. says: source_id -> its sentence and quote, newest first.
  const items = new Map<string, Entry>();
  for (const [index, row] of loadRelationRows(db).entries()) {
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
        end,
        otherName,
        firstRow: index,
        item: {
          page_id: otherId, title, type, direction, source_count: 0, evidence: [],
          direction_dispute: null, outdated: null,
        },
        says: new Map(),
      };
      items.set(key, entry);
    }
    const said = entry.says.get(row.source_id);
    if (!said) {
      entry.says.set(row.source_id, { sentence: row.description, quote: row.quote });
    } else {
      said.sentence ??= row.description;
      said.quote ??= row.quote;
    }
  }

  const sourceRow = db.prepare('SELECT title, status FROM sources WHERE source_id = ?');
  const titled = (ids: Iterable<string>): SourceRef[] =>
    [...ids].flatMap((source_id) => {
      const source = sourceRow.get(source_id) as { title: string } | undefined;
      return source ? [{ source_id, source_title: source.title }] : [];
    });
  keepOneDirection(items, sourceDayLookup(db), titled);

  // "Related to" is the weakest relation: an end another relation already
  // lists is not listed again under it.
  const typedEnds = new Set([...items.values()].filter((e) => e.item.type !== RELATED_TO).map((e) => e.end));

  const outdated = loadOutdatedIndex(db, names);
  const byLabel = new Map<string, ConnectionItem[]>();
  const weight = (s: SourceSays) => (s.quote !== null ? 0 : s.sentence !== null ? 1 : 2);
  for (const { end, otherName, item, says } of items.values()) {
    if (item.type === RELATED_TO && typedEnds.has(end)) continue;
    item.source_count = says.size;
    item.outdated = outdated.check(
      { page_id: pageId, name: (pages.get(pageId) as { title: string }).title },
      { page_id: item.page_id, name: otherName },
      says.keys()
    );
    // Sorting is stable, so each rank stays newest first.
    const ranked = [...says].sort(([, a], [, b]) => weight(a) - weight(b));
    for (const [source_id, { sentence, quote }] of ranked) {
      if (item.evidence.length >= evidenceLimit) break;
      const source = sourceRow.get(source_id) as { title: string; status: string | null } | undefined;
      if (source) {
        item.evidence.push({
          source_id,
          source_title: source.title,
          source_archived: source.status === 'archived',
          sentence,
          quote,
        });
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

/** A connection while its rows are gathered: `firstRow` is its newest row's index. */
interface Entry {
  end: string;
  otherName: string;
  firstRow: number;
  item: ConnectionItem;
  says: Map<string, SourceSays>;
}

/**
 * Both readings of a directed type with one end ("Part of" and "Includes"
 * the same page): keep the one prefersFirst picks and list both sides on it.
 */
function keepOneDirection(
  items: Map<string, Entry>, dayOf: SourceDayOf, titled: (ids: Iterable<string>) => SourceRef[]
): void {
  const byEndAndType = new Map<string, Array<[string, Entry]>>();
  for (const [key, entry] of items) {
    if (isSymmetricRelation(entry.item.type)) continue;
    const pairKey = `${entry.end}\u0000${entry.item.type}`;
    byEndAndType.set(pairKey, [...(byEndAndType.get(pairKey) ?? []), [key, entry]]);
  }
  const reading = (e: Entry) => ({
    sourceIds: [...e.says.keys()],
    quoted: [...e.says.values()].some((s) => s.quote !== null),
    firstRow: e.firstRow,
  });
  const side = (e: Entry): DirectionSide => ({ label: relationLabel(e.item.type, e.item.direction), sources: titled(e.says.keys()) });
  for (const both of byEndAndType.values()) {
    if (both.length !== 2) continue;
    const [[keyA, a], [keyB, b]] = both;
    const [kept, lostKey, lost] = prefersFirst(reading(a), reading(b), dayOf) ? [a, keyB, b] : [b, keyA, a];
    kept.item.direction_dispute = { kept: side(kept), other: side(lost) };
    items.delete(lostKey);
  }
}

/** The other end of one connection: a page, or a name with no page yet. */
export type ConnectionEnd = { page_id: string } | { name: string };

/**
 * One connection of a page with every source behind it (the page read model
 * keeps EVIDENCE_PER_ITEM): its items to `other` of `type` read in
 * `direction` from the page. For a panel's "+N more sources". Empty when the
 * page has no such connection.
 */
export function getConnectionEvidence(
  pageId: string, other: ConnectionEnd, type: string, direction: RelationDirection
): ConnectionItem[] {
  const matches = (i: ConnectionItem) =>
    'page_id' in other ? i.page_id === other.page_id : i.page_id === null && i.title.toLowerCase() === other.name.toLowerCase();
  return getPageConnections(pageId, { evidenceLimit: Infinity })
    .groups.flatMap((g) => g.items)
    .filter((i) => i.type === type && i.direction === direction && matches(i));
}
