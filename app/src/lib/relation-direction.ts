/**
 * One direction per directed relation type per pair of ends. Sources can
 * state a directed type both ways for the same two ends ("Henryk
 * Tomaszewski part_of Polish School of Posters" from one source, the
 * reverse from another): the read models (relations.ts, relation-edges.ts,
 * relation-among.ts) show the reading more sources state and keep the other
 * as a conflict the owner can see; nothing is dropped from the table.
 * Symmetric types (relation-labels.ts) never conflict: both ways read the same.
 */

import type Database from 'better-sqlite3';
import { sourceDateOf } from './source-dates';

/** One reading of a directed relation between two ends. */
export interface DirectionReading {
  /** Distinct sources stating it. */
  sourceIds: readonly string[];
  /** At least one of them has a quote checked against the source. */
  quoted: boolean;
  /** Index of its newest row in loadRelationRows' newest-first order. */
  firstRow: number;
}

/** A source's date (YYYY-MM-DD: published, else the day it was added), or null. */
export type SourceDayOf = (sourceId: string) => string | null;

/** sourceDateOf for one source at a time, each read once. */
export function sourceDayLookup(db: Database.Database): SourceDayOf {
  const stmt = db.prepare('SELECT published_at, published_at_source, date_ingested FROM sources WHERE source_id = ?');
  const cache = new Map<string, string | null>();
  return (sourceId) => {
    let day = cache.get(sourceId);
    if (day === undefined) {
      const row = stmt.get(sourceId) as Parameters<typeof sourceDateOf>[0] | undefined;
      day = row ? (sourceDateOf(row)?.published_at ?? null) : null;
      cache.set(sourceId, day);
    }
    return day;
  };
}

function newestDay(reading: DirectionReading, dayOf: SourceDayOf): string {
  let newest = '';
  for (const id of reading.sourceIds) {
    const day = dayOf(id);
    if (day !== null && day > newest) newest = day;
  }
  return newest;
}

/**
 * Which of two opposite readings to show: the one more distinct sources
 * state; on a tie, the one with a checked quote; then the one with the more
 * recent source (by date); then the one extracted last; then `a`.
 * Returns true when `a` wins.
 */
export function prefersFirst(a: DirectionReading, b: DirectionReading, dayOf: SourceDayOf): boolean {
  if (a.sourceIds.length !== b.sourceIds.length) return a.sourceIds.length > b.sourceIds.length;
  if (a.quoted !== b.quoted) return a.quoted;
  const [dayA, dayB] = [newestDay(a, dayOf), newestDay(b, dayOf)];
  if (dayA !== dayB) return dayA > dayB;
  return a.firstRow <= b.firstRow;
}
