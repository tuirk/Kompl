/**
 * Typed relations around a set of pages (the MCP research_topic pack): rows
 * whose two ends both resolve to shown pages, at least one of them in the
 * set. One pass over the relationship_mentions rows, like relation-edges.ts,
 * so the cost does not grow with the size of the set. Reads only.
 */

import type Database from 'better-sqlite3';
import { getDb } from './db';
import { prefersFirst, sourceDayLookup } from './relation-direction';
import { buildNameMap, loadPages, loadRelationRows } from './relation-names';
import { compareRelationLabels, isSymmetricRelation, relationLabel } from './relation-labels';
import { loadOutdatedIndex, type OutdatedNote } from './relation-outdated';

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
  /**
   * Distinct sources, newest first, led by the one `quote` and `sentence`
   * come from: the newest with a quote, else the newest with a sentence.
   */
  source_ids: string[];
  /** Kompl's one-line summary from the leading source; null when none was kept. */
  sentence: string | null;
  /** The leading source's own sentence, checked at extraction (v30); else null. */
  quote: string | null;
  /** Other sources state it the other way round (relation-direction.ts); null when none do. */
  direction_dispute: DirectionDisputeIds | null;
  /** Every source is older than a "Changed" finding about both ends (relation-outdated.ts); else null. */
  outdated: OutdatedNote | null;
}

/** The sources, newest first, that state a relation the other way round from `from` to `to`. */
export interface DirectionDisputeIds {
  other_source_ids: string[];
}

/** What one source says about a relation. */
interface SourceSays {
  sentence: string | null;
  quote: string | null;
}

/** A relation as gathered from the rows: ends as stored; sources map to what they say, newest first. */
interface Found {
  fromId: string;
  toId: string;
  type: string;
  sources: Map<string, SourceSays>;
  /** Index of its newest row (rows come newest first). */
  firstRow: number;
  /** The sources of the opposite reading this one won over. */
  otherWay: string[];
}

/**
 * The strongest `limit` relations touching `pageIds`: specific relations
 * before "related to", then most sources, then both ends in the set, then
 * the label order, titles and ids. "Related to" is left out for a pair a
 * specific relation already joins. Archived pages and Saved Links are never
 * an end. Both directions of a symmetric type (competes with, contradicts,
 * related to) merge into one relation, read from a page in the set; every
 * other type, unknown ones included, keeps its stored direction, and when
 * sources state it both ways round, one of them (oneWayRound).
 */
export function getRelationsAmong(pageIds: readonly string[], limit: number): PageRelation[] {
  const wanted = new Set(pageIds);
  if (wanted.size === 0 || limit <= 0) return [];
  const db = getDb();
  const pages = loadPages(db);
  const titleOf = (id: string) => (pages.get(id) as { title: string }).title;
  const names = buildNameMap(db, pages, false);
  const found = oneWayRound(db, gather(names, loadRelationRows(db), wanted));
  const outdated = loadOutdatedIndex(db, names);
  return rank(withoutRepeatedRelated(found), wanted, titleOf)
    .slice(0, limit)
    .map((f) => ({
      ...toPageRelation(f, wanted, titleOf),
      outdated: outdated.check(
        { page_id: f.fromId, name: titleOf(f.fromId) }, { page_id: f.toId, name: titleOf(f.toId) }, f.sources.keys()
      ),
    }));
}

/**
 * A directed type stated both ways round between two pages keeps the
 * reading prefersFirst picks (relation-direction.ts), which lists the
 * other reading's sources.
 */
function oneWayRound(db: Database.Database, found: Found[]): Found[] {
  const byKey = new Map(found.map((f) => [`${f.type}\u0000${f.fromId}\u0000${f.toId}`, f]));
  const dayOf = sourceDayLookup(db);
  const reading = (f: Found) => ({
    sourceIds: [...f.sources.keys()],
    quoted: [...f.sources.values()].some((s) => s.quote !== null),
    firstRow: f.firstRow,
  });
  const lost = new Set<Found>();
  for (const f of found) {
    if (isSymmetricRelation(f.type) || lost.has(f)) continue;
    const back = byKey.get(`${f.type}\u0000${f.toId}\u0000${f.fromId}`);
    if (!back || back === f || lost.has(back)) continue;
    const [kept, other] = prefersFirst(reading(f), reading(back), dayOf) ? [f, back] : [back, f];
    kept.otherWay = [...other.sources.keys()];
    lost.add(other);
  }
  return found.filter((f) => !lost.has(f));
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
  for (const [index, row] of rows.entries()) {
    const fromId = names.get(row.from_canonical.toLowerCase());
    const toId = names.get(row.to_canonical.toLowerCase());
    if (fromId === undefined || toId === undefined || fromId === toId) continue;
    if (!wanted.has(fromId) && !wanted.has(toId)) continue;
    const type = row.relationship_type;
    const key = `${type}\u0000${isSymmetricRelation(type) ? pairKey(fromId, toId) : `${fromId}\u0000${toId}`}`;
    let entry = found.get(key);
    if (!entry) {
      entry = { fromId, toId, type, sources: new Map(), firstRow: index, otherWay: [] };
      found.set(key, entry);
    }
    const said = entry.sources.get(row.source_id);
    if (!said) {
      entry.sources.set(row.source_id, { sentence: row.description, quote: row.quote });
    } else {
      said.sentence ??= row.description;
      said.quote ??= row.quote;
    }
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

function toPageRelation(f: Found, wanted: Set<string>, titleOf: (id: string) => string): Omit<PageRelation, 'outdated'> {
  // A symmetric relation reads from the set's page when only one end is in it.
  const swap = isSymmetricRelation(f.type) && !wanted.has(f.fromId);
  const [fromId, toId] = swap ? [f.toId, f.fromId] : [f.fromId, f.toId];
  const all = [...f.sources];
  const lead = all.find(([, s]) => s.quote !== null) ?? all.find(([, s]) => s.sentence !== null);
  const source_ids = lead ? [lead[0], ...all.filter(([id]) => id !== lead[0]).map(([id]) => id)] : all.map(([id]) => id);
  return {
    from: { page_id: fromId, title: titleOf(fromId) },
    to: { page_id: toId, title: titleOf(toId) },
    type: f.type,
    source_ids,
    sentence: lead ? lead[1].sentence : null,
    quote: lead ? lead[1].quote : null,
    direction_dispute: f.otherWay.length > 0 ? { other_source_ids: f.otherWay } : null,
  };
}
