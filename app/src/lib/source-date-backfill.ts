/**
 * Publication dates for sources added before Kompl kept them (plan 3.2,
 * D5), from what each source row and its stored text already hold: a
 * tweet's own date, else a date the text gives near its top (lib/
 * source-dates.ts findSourceDate). No LLM calls and no fetches; a page's
 * HTML metadata is gone once converted, so web pages are dated from their
 * text only.
 *
 * Runs once per install at boot (instrumentation.ts, versioned by
 * SOURCE_DATES_BACKFILL_KEY) and after every import. Only sources with no
 * date are dated, and only when a date is found: a source the backfill
 * can't date keeps NULL (read as the day it was added, sourceDateOf), so a
 * later version that learns more can still date it. A date already set is
 * never overwritten, except by the boot run of a new version: it reads
 * each date taken from the text (source_text) again with today's rules,
 * which may stop trusting it (version 2: a labelled date only on a byline
 * or metadata line, so "Python 3.0 was released on December 3, 2008" no
 * longer dates the source). An import restores the dates a backup carries
 * as they are. Rerunning changes nothing.
 */

import type Database from 'better-sqlite3';

import { getSetting, readRawMarkdown, setSetting } from './db';
import { findSourceDate } from './source-dates';

/** Settings row naming the backfill version this database has had. Not backed up (lib/backup-settings.ts). */
export const SOURCE_DATES_BACKFILL_KEY = 'source_dates_backfill_version';
/** Bump when findSourceDate learns to date sources it used to miss, or stops taking a date it used to. */
export const SOURCE_DATES_BACKFILL_VERSION = '2';

/** Sources written per transaction. */
const BATCH = 200;

export interface SourceDatesBackfillResult {
  /** Sources that had no date. */
  undated: number;
  /** Of those, dated now. */
  dated: number;
  /** Of those, without stored text to read. */
  no_text: number;
  /** With rereadText: sources dated from their text whose text no longer gives that date, dated again or left undated. */
  redated: number;
}

/** The day a source was added, as a Date: a found date may not come after it. */
function addedAt(dateIngested: string | null): Date | undefined {
  if (!dateIngested) return undefined;
  const when = new Date(`${dateIngested.trim().replace(' ', 'T')}Z`);
  return Number.isNaN(when.getTime()) ? undefined : when;
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const meta: unknown = JSON.parse(raw);
    return meta && typeof meta === 'object' ? (meta as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function backfillSourceDates(
  db: Database.Database,
  readText: (sourceId: string) => string | null = readRawMarkdown,
  options: { rereadText?: boolean } = {}
): SourceDatesBackfillResult {
  const reread = options.rereadText ? ` OR published_at_source = 'source_text'` : '';
  const rows = db
    .prepare(
      `SELECT source_id, source_type, metadata, date_ingested, published_at FROM sources
        WHERE published_at IS NULL${reread} ORDER BY source_id`
    )
    .all() as Array<{
    source_id: string;
    source_type: string;
    metadata: string | null;
    date_ingested: string | null;
    published_at: string | null;
  }>;
  const write = db.prepare(
    `UPDATE sources SET published_at = ?, published_at_source = ?
      WHERE source_id = ? AND published_at IS NULL`
  );
  const rewrite = db.prepare(
    `UPDATE sources SET published_at = ?, published_at_source = ?
      WHERE source_id = ? AND published_at_source = 'source_text'`
  );
  const undated = rows.filter((row) => row.published_at === null).length;
  const result: SourceDatesBackfillResult = { undated, dated: 0, no_text: 0, redated: 0 };
  for (let i = 0; i < rows.length; i += BATCH) {
    const found: Array<[string, string, string]> = [];
    const redate: Array<[string | null, string | null, string]> = [];
    for (const row of rows.slice(i, i + BATCH)) {
      const text = readText(row.source_id);
      const before = row.published_at;
      // A date read from the text before: without the text there is nothing to read again.
      if (before !== null && text === null) continue;
      if (text === null) result.no_text += 1;
      const date = findSourceDate({
        source_type: row.source_type,
        metadata: parseMetadata(row.metadata),
        markdown: text ?? '',
        now: addedAt(row.date_ingested),
      });
      if (before === null) {
        if (date) found.push([date.published_at, date.published_at_source, row.source_id]);
      } else if (date?.published_at !== before || date.published_at_source !== 'source_text') {
        redate.push([date?.published_at ?? null, date?.published_at_source ?? null, row.source_id]);
      }
    }
    db.transaction(() => {
      for (const args of found) result.dated += write.run(...args).changes;
      for (const args of redate) result.redated += rewrite.run(...args).changes;
    })();
  }
  return result;
}

/** The boot run: the backfill, dates read from the text read again, unless this database already had this version. */
export function backfillSourceDatesOnce(db: Database.Database): SourceDatesBackfillResult | null {
  if (getSetting(SOURCE_DATES_BACKFILL_KEY) === SOURCE_DATES_BACKFILL_VERSION) return null;
  const result = backfillSourceDates(db, readRawMarkdown, { rereadText: true });
  setSetting(SOURCE_DATES_BACKFILL_KEY, SOURCE_DATES_BACKFILL_VERSION);
  return result;
}
