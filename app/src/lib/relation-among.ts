/**
 * Typed relations around a set of pages (the MCP research_topic pack): rows
 * whose two ends both resolve to shown pages, at least one of them in the
 * set. One pass over the relationship_mentions rows, like relation-edges.ts,
 * so the cost does not grow with the size of the set. Reads only.
 */

import { getDb } from './db';
import { buildNameMap, loadPages, loadRelationRows } from './relation-names';
import { compareRelationLabels, isSymmetricRelation, relationLabel } from './relation-labels';

/** The weak relation: listed only after every specific one. */
const RELATED_TO = 'related_to';

export interface RelationEnd {
  page_id: string;
  title: string;
}

/** One relation between two pages; its label reads from `from` (relation-labels.ts). */
export interface PageRelation {
  from: RelationEnd;
  to: RelationEnd;
  type: string;
  /** Distinct sources, the one giving `sentence` first, then newest first. */
  source_ids: string[];
  /** The newest sentence any of those sources gives; null when none was kept. */
  sentence: string | null;
}

/** A relation as gathered from the rows: ends as stored; sources map to their sentence, newest first. */
interface Found {
  fromId: string;
  toId: string;
  type: string;
  sources: Map<string, string | null>;
}

/**
 * The strongest `limit` relations touching `pageIds`: specific relations
 * before "related to", then most sources, then both ends in the set, then
 * the label order, titles and ids. "Related to" is left out for a pair a
 * specific relation already joins. Archived pages and Saved Links are never
 * an end. Both directions of a symmetric type (competes with, contradicts,
 * related to) merge into one relation, read from a page in the set; every
 * other type, unknown ones included, keeps its stored direction.
 */
export function getRelationsAmong(pageIds: readonly string[], limit: number): PageRelation[] {
  const wanted = new Set(pageIds);
  if (wanted.size === 0 || limit <= 0) return [];
  const db = getDb();
  const pages = loadPages(db);
  const titleOf = (id: string) => (pages.get(id) as { title: string }).title;
  const found = gather(buildNameMap(db, pages, false), loadRelationRows(db), wanted);
  return rank(withoutRepeatedRelated(found), wanted, titleOf)
    .slice(0, limit)
    .map((f) => toPageRelation(f, wanted, titleOf));
}

/**
 * "Related to" adds nothing for a pair that a specific relation already
 * joins (either way round), so it is dropped there and its slot goes to
 * another connection. A pair joined only by "related to" keeps it.
 */
function withoutRepeatedRelated(found: Found[]): Found[] {
  const specific = new Set(found.filter((f) => f.type !== RELATED_TO).map((f) => pairKey(f.fromId, f.toId)));
  return found.filter((f) => f.type !== RELATED_TO || !specific.has(pairKey(f.fromId, f.toId)));
}

/** The relations touching `wanted`, one per (type, ends); a symmetric type's two directions share one. */
function gather(names: Map<string, string>, rows: ReturnType<typeof loadRelationRows>, wanted: Set<string>): Found[] {
  const found = new Map<string, Found>();
  for (const row of rows) {
    const fromId = names.get(row.from_canonical.toLowerCase());
    const toId = names.get(row.to_canonical.toLowerCase());
    if (fromId === undefined || toId === undefined || fromId === toId) continue;
    if (!wanted.has(fromId) && !wanted.has(toId)) continue;
    const type = row.relationship_type;
    const key = `${type}\u0000${isSymmetricRelation(type) ? pairKey(fromId, toId) : `${fromId}\u0000${toId}`}`;
    let entry = found.get(key);
    if (!entry) {
      entry = { fromId, toId, type, sources: new Map() };
      found.set(key, entry);
    }
    if ((entry.sources.get(row.source_id) ?? null) === null) entry.sources.set(row.source_id, row.description);
  }
  return [...found.values()];
}

/** The two page ids in either order: one key per unordered pair. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function rank(found: Found[], wanted: Set<string>, titleOf: (id: string) => string): Found[] {
  const weak = (f: Found) => (f.type === RELATED_TO ? 1 : 0);
  const outside = (f: Found) => (wanted.has(f.fromId) && wanted.has(f.toId) ? 0 : 1);
  const compareIds = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return [...found].sort(
    (x, y) =>
      weak(x) - weak(y) ||
      y.sources.size - x.sources.size ||
      outside(x) - outside(y) ||
      compareRelationLabels(relationLabel(x.type, 'out'), relationLabel(y.type, 'out')) ||
      titleOf(x.fromId).localeCompare(titleOf(y.fromId)) ||
      titleOf(x.toId).localeCompare(titleOf(y.toId)) ||
      compareIds(x.fromId, y.fromId) ||
      compareIds(x.toId, y.toId)
  );
}

function toPageRelation(f: Found, wanted: Set<string>, titleOf: (id: string) => string): PageRelation {
  // A symmetric relation reads from the set's page when only one end is in it.
  const swap = isSymmetricRelation(f.type) && !wanted.has(f.fromId);
  const [fromId, toId] = swap ? [f.toId, f.fromId] : [f.fromId, f.toId];
  const all = [...f.sources];
  const said = all.find(([, sentence]) => sentence !== null);
  const source_ids = said ? [said[0], ...all.filter(([id]) => id !== said[0]).map(([id]) => id)] : all.map(([id]) => id);
  return {
    from: { page_id: fromId, title: titleOf(fromId) },
    to: { page_id: toId, title: titleOf(toId) },
    type: f.type,
    source_ids,
    sentence: said ? said[1] : null,
  };
}
