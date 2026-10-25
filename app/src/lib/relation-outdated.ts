/**
 * "May be outdated": a relation whose every source is the older side of a
 * "Changed" finding (a claim a later source superseded) about the same two
 * ends. The read models (relations.ts, relation-edges.ts, relation-among.ts)
 * mark it; nothing is deleted.
 *
 * A relation is marked when one finding F in the disagreements record has:
 *   1. kind 'changed', still recorded (cleared_at NULL) and not dismissed
 *      by the owner; found from page text or by a check alike;
 *   2. its page at one end of the relation;
 *   3. a topic naming both ends: each end's title or an active alias (a
 *      name with no page: that name), case-insensitive, as a whole phrase
 *      ("WCAG 2" is not named by "WCAG 2.1");
 *   4. every source of the relation among F's sources and published before
 *      F's newest source, which is not archived. Only publication dates
 *      count: a source known only by the day it was added has no place in
 *      time, so a finding or relation that needs one is never matched.
 */

import type Database from 'better-sqlite3';
import { sourceDates } from './source-dates';

/** Shown with a relation that may be outdated. */
export interface OutdatedNote {
  /** The newer source that says otherwise. */
  source_id: string;
  source_title: string;
  /** The finding's topic, and the page that records it. */
  topic: string;
  page_id: string;
}

/** One end of a relation: a page, or a name with no page. */
export interface RelationEndRef {
  page_id: string | null;
  name: string;
}

interface Finding {
  page_id: string;
  topic: string;
  created_at: string;
  /** Lowercased source ids published before the newest. */
  older: Set<string>;
  newestDay: string;
  newest: { source_id: string; source_title: string };
}

/** Names shorter than this never match: too likely to sit inside another phrase. */
const MIN_NAME = 2;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function squeeze(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** `name` as a whole phrase of `text`: not inside a word or a number ("2" in "2.1"). */
export function namesPhrase(text: string, name: string): boolean {
  const phrase = squeeze(name);
  if (phrase.length < MIN_NAME) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}]|[.,]\\p{N})`, 'iu').test(squeeze(text));
}

function parseIds(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').map((v) => v.toLowerCase()) : [];
  } catch {
    return [];
  }
}

export interface OutdatedIndex {
  /** The note for a relation between `a` and `b` stated by `sourceIds`, or null. */
  check(a: RelationEndRef, b: RelationEndRef, sourceIds: Iterable<string>): OutdatedNote | null;
}

/**
 * The Changed findings, read once per request. `names` maps a lowercased
 * name to its page (relation-names.ts buildNameMap): every name of a page
 * counts as naming it.
 */
export function loadOutdatedIndex(db: Database.Database, names: ReadonlyMap<string, string>): OutdatedIndex {
  const rows = db
    .prepare(
      `SELECT page_id, topic, source_ids, created_at FROM disagreements
        WHERE kind = 'changed' AND cleared_at IS NULL AND COALESCE(owner_verdict, '') != 'dismissed'`
    )
    .all() as Array<{ page_id: string; topic: string; source_ids: string | null; created_at: string }>;
  const byPage = new Map<string, Finding[]>();
  if (rows.length > 0) {
    const ids = rows.map((r) => parseIds(r.source_ids));
    const dates = sourceDates(db, ids.flat());
    const sourceRow = db.prepare('SELECT source_id, title, status FROM sources WHERE lower(source_id) = ?');
    // A publication date only; '' for a source known by the day it was added.
    const day = (id: string) => {
      const d = dates.get(id);
      return d?.date_kind === 'published' ? d.date : '';
    };
    rows.forEach((row, i) => {
      const published = ids[i].filter((id) => day(id) !== '');
      const newestDay = published.reduce((max, id) => (day(id) > max ? day(id) : max), '');
      if (!newestDay) return;
      const newest = published
        .filter((id) => day(id) === newestDay)
        .map((id) => sourceRow.get(id) as { source_id: string; title: string; status: string | null } | undefined)
        .find((s) => s !== undefined && s.status !== 'archived');
      if (!newest) return;
      const older = new Set(published.filter((id) => day(id) < newestDay));
      if (older.size === 0) return;
      const finding: Finding = {
        page_id: row.page_id,
        topic: row.topic,
        created_at: row.created_at,
        older,
        newestDay,
        newest: { source_id: newest.source_id, source_title: newest.title },
      };
      byPage.set(row.page_id, [...(byPage.get(row.page_id) ?? []), finding]);
    });
  }

  const namesOf = new Map<string, string[]>();
  for (const [name, pageId] of names) namesOf.set(pageId, [...(namesOf.get(pageId) ?? []), name]);
  const named = (topic: string, end: RelationEndRef) =>
    (end.page_id !== null ? (namesOf.get(end.page_id) ?? []) : [end.name]).some((n) => namesPhrase(topic, n));

  return {
    check(a, b, sourceIds) {
      if (byPage.size === 0) return null;
      const sources = [...new Set([...sourceIds].map((id) => id.toLowerCase()))];
      if (sources.length === 0) return null;
      const candidates = [a.page_id, b.page_id]
        .filter((id): id is string => id !== null)
        .flatMap((id) => byPage.get(id) ?? [])
        .filter((f) => sources.every((id) => f.older.has(id)) && named(f.topic, a) && named(f.topic, b))
        .sort((x, y) => (y.newestDay > x.newestDay ? 1 : y.newestDay < x.newestDay ? -1 : y.created_at.localeCompare(x.created_at)));
      const f = candidates[0];
      return f ? { ...f.newest, topic: f.topic, page_id: f.page_id } : null;
    },
  };
}
