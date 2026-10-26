/**
 * A source's publication date and where it came from (plan 3.1/3.2, D5: a
 * claim a later source superseded, "### Changed:", is told from a live
 * disagreement, "### Disputed:", by the sources' publication dates).
 *
 * Picked once, at ingest (pickSourceDate), and stored on the source row,
 * sources.published_at and published_at_source (schema v30 step):
 *
 *   1. the source's own metadata, as conversion reports it (nlp-service
 *      services/published_date.py): page_published, page_modified,
 *      file_metadata, youtube, github_push
 *   2. a tweet's own date (the connector stores it as metadata.date_saved)
 *   3. source_text: a date a byline or metadata line near the text's top
 *      gives, labelled "published", "posted", "updated"... or alone on a
 *      short line
 *   4. ingested: the day the source was added
 *
 * Read everywhere through sourceDateOf: a source without a stored date
 * (added before, until the boot backfill reaches it) reads as the day it
 * was added. Draft prompts get it through sourceDates: the publication
 * date, or the saved date marked "saved" (nlp-service llm_client.py
 * _source_dates_line), so the model weighs it accordingly.
 */

import type Database from 'better-sqlite3';

export type PublishedAtSource =
  | 'page_published'
  | 'page_modified'
  | 'file_metadata'
  | 'youtube'
  | 'github_push'
  | 'tweet'
  | 'source_text'
  | 'ingested';

/** A source's date as stored on its row. */
export interface StoredSourceDate {
  /** YYYY-MM-DD. */
  published_at: string;
  published_at_source: PublishedAtSource;
}

/** A source's date as a draft prompt carries it. */
export interface SourceDate {
  /** YYYY-MM-DD */
  date: string;
  /** saved: no publication date is known, `date` is the day it was added. */
  date_kind: 'published' | 'saved';
}

const METADATA_ORIGINS: ReadonlySet<string> = new Set([
  'page_published',
  'page_modified',
  'file_metadata',
  'youtube',
  'github_push',
]);
const ORIGINS: ReadonlySet<string> = new Set([...METADATA_ORIGINS, 'tweet', 'source_text', 'ingested']);

/** Where in the text a date is looked for. */
const TEXT_SCAN_CHARS = 3000;
const SHORT_LINE_SCAN_CHARS = 1500;
const SHORT_LINE_MAX_CHARS = 80;

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH = String.raw`(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?`;
/** A full date as text writes it: 2024-03-05, 2024/03/05, March 5, 2024, 5 March 2024. */
const DATE = String.raw`(?:\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?!\d)|\b${MONTH}\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b|\b(\d{1,2})(?:st|nd|rd|th)?\s+${MONTH},?\s+(\d{4})\b)`;
/**
 * Where a byline or metadata item starts: the line, or a part after "·",
 * "•" or "|" ("By Ana · Published March 5, 2024"). On a short line also
 * after a sentence or a dash ("Updated June 1, 2025. Published January 2,
 * 2024."); in a long one those are prose ("The iPhone — released June 29,
 * 2007 — changed…").
 */
const ITEM_START = String.raw`(?:^|[·•|]\s*)`;
const SHORT_ITEM_START = String.raw`(?:^|(?:[·•|]|[.!?]\s|\s[—–-]\s|[—–])\s*)`;
/** A label that dates the text, then its date: "Published March 5, 2024", "Posted by admin on 5th Mar 2024". */
function labelled(start: string, label: string): RegExp {
  return new RegExp(String.raw`${start}${label}\b[^\n]{0,30}?${DATE}`, 'i');
}
const PUBLISHED_LABEL = String.raw`(?:published|posted|released|written|dated|date)`;
const UPDATED_LABEL = String.raw`(?:updated|last\s+updated|modified|last\s+modified|revised)`;
const PUBLISHED_NEAR = { long: labelled(ITEM_START, PUBLISHED_LABEL), short: labelled(SHORT_ITEM_START, PUBLISHED_LABEL) };
const UPDATED_NEAR = { long: labelled(ITEM_START, UPDATED_LABEL), short: labelled(SHORT_ITEM_START, UPDATED_LABEL) };
/** A date that starts a short line's item: "Mar 5, 2024 · 5 min read", "Ana Ribeiro, March 5, 2024". */
const ITEM_DATE = new RegExp(String.raw`(?:^|(?:[·•|,]|\s[—–-]|[—–])\s*)${DATE}`, 'i');
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})/;
/** SQLite's default limit on bound parameters is far higher; this keeps statements small. */
const CHUNK = 500;

/** YYYY-MM-DD when y/m/d is a real day from 1900 to tomorrow, else null. */
function plausible(y: number, m: number, d: number, now: Date): string | null {
  const day = new Date(Date.UTC(y, m - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) return null;
  if (y < 1900 || day.getTime() > now.getTime() + 86_400_000) return null;
  return day.toISOString().slice(0, 10);
}

function monthNumber(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

/** The date a DATE match names. Groups: ISO 1-3, month-first 4-6, day-first 7-9. */
function fromMatch(m: RegExpMatchArray, now: Date): string | null {
  if (m[1]) return plausible(Number(m[1]), Number(m[2]), Number(m[3]), now);
  if (m[4]) return plausible(Number(m[6]), monthNumber(m[4]), Number(m[5]), now);
  return plausible(Number(m[9]), monthNumber(m[8]), Number(m[7]), now);
}

/** An ISO date's day (time and zone ignored), when it is a plausible one. */
function isoDay(value: unknown, now: Date = new Date()): string | null {
  if (typeof value !== 'string') return null;
  const m = ISO_DAY.exec(value.trim());
  return m ? plausible(Number(m[1]), Number(m[2]), Number(m[3]), now) : null;
}

/** A text's lines without heading, quote and list marks; table rows are left out. */
function textLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^[#>\s-]+/, '').trim())
    .filter((line) => line && !line.startsWith('|'));
}

/**
 * A publication date the text itself gives near its top: one labelled
 * "published", "posted", "date"..., else "updated", "modified"..., else a
 * full date standing on a short line of its own ("Mar 5, 2024 · 5 min
 * read"). Only a byline or metadata line counts: the label or date starts
 * the line or one of its items (ITEM_START). A date in running prose or a
 * table row is never taken: it is more often an event's date than the
 * text's ("Python 3.0 was released on December 3, 2008", an infobox's
 * "| Release date | June 29, 2007 |").
 */
export function dateInText(markdown: string, now: Date = new Date()): string | null {
  const head = markdown.slice(0, TEXT_SCAN_CHARS).replace(/[*_`]/g, '');
  const lines = textLines(head);
  for (const near of [PUBLISHED_NEAR, UPDATED_NEAR]) {
    for (const line of lines) {
      const m = line.match(line.length > SHORT_LINE_MAX_CHARS ? near.long : near.short);
      const day = m ? fromMatch(m, now) : null;
      if (day) return day;
    }
  }
  for (const line of textLines(head.slice(0, SHORT_LINE_SCAN_CHARS))) {
    if (line.length > SHORT_LINE_MAX_CHARS) continue;
    const m = line.match(ITEM_DATE);
    const day = m ? fromMatch(m, now) : null;
    if (day) return day;
  }
  return null;
}

export interface SourceDateInput {
  /** What conversion reported (url and file sources); absent for text. */
  converted?: { published_at?: string | null; published_at_source?: string | null } | null;
  source_type: string;
  metadata?: Record<string, unknown> | null;
  markdown: string;
  now?: Date;
}

/**
 * Steps 1-3 of the module comment: the date a source's metadata, tweet
 * date or text gives, or null when none does.
 */
export function findSourceDate(input: SourceDateInput): StoredSourceDate | null {
  const now = input.now ?? new Date();
  const converted = input.converted;
  const fromMeta = isoDay(converted?.published_at, now);
  if (fromMeta && converted?.published_at_source && METADATA_ORIGINS.has(converted.published_at_source)) {
    return { published_at: fromMeta, published_at_source: converted.published_at_source as PublishedAtSource };
  }
  const tweeted = input.source_type === 'tweet' ? isoDay(input.metadata?.date_saved, now) : null;
  if (tweeted) return { published_at: tweeted, published_at_source: 'tweet' };
  const inText = dateInText(input.markdown, now);
  return inText ? { published_at: inText, published_at_source: 'source_text' } : null;
}

/** The date to store for a new source: findSourceDate, else today (step 4). */
export function pickSourceDate(input: SourceDateInput): StoredSourceDate {
  const now = input.now ?? new Date();
  return findSourceDate({ ...input, now }) ?? { published_at: now.toISOString().slice(0, 10), published_at_source: 'ingested' };
}

/**
 * A source row's date: its stored publication date, else (a source added
 * before dates were kept, or a malformed value) the day it was added
 * (date_ingested is SQLite's "YYYY-MM-DD HH:MM:SS"). The one reading every
 * caller goes through.
 */
export function sourceDateOf(row: {
  published_at?: string | null;
  published_at_source?: string | null;
  date_ingested: string | null;
}): StoredSourceDate | null {
  const stored = isoDay(row.published_at);
  if (stored && row.published_at_source && ORIGINS.has(row.published_at_source)) {
    return { published_at: stored, published_at_source: row.published_at_source as PublishedAtSource };
  }
  const added = row.date_ingested ? ISO_DAY.exec(row.date_ingested.trim())?.[0] : undefined;
  return added ? { published_at: added, published_at_source: 'ingested' } : null;
}

/** sourceDateOf as a draft prompt carries it: an ingest day is marked "saved". */
export function promptDate(row: Parameters<typeof sourceDateOf>[0]): SourceDate | null {
  const found = sourceDateOf(row);
  if (!found) return null;
  return { date: found.published_at, date_kind: found.published_at_source === 'ingested' ? 'saved' : 'published' };
}

/**
 * The date of each known source for a draft prompt, keyed by lowercased
 * source_id (citations carry ids lowercased). Sources with no date at all
 * are left out.
 */
export function sourceDates(db: Database.Database, sourceIds: Iterable<string>): Map<string, SourceDate> {
  const ids = [...new Set([...sourceIds].map((id) => id.toLowerCase()))];
  const out = new Map<string, SourceDate>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = db
      .prepare(
        `SELECT source_id, published_at, published_at_source, date_ingested FROM sources
          WHERE lower(source_id) IN (${chunk.map(() => '?').join(', ')})`
      )
      .all(...chunk) as Array<{
      source_id: string;
      published_at: string | null;
      published_at_source: string | null;
      date_ingested: string | null;
    }>;
    for (const row of rows) {
      const date = promptDate(row);
      if (date) out.set(row.source_id.toLowerCase(), date);
    }
  }
  return out;
}

/** `item` with its source's date added, when the source has one. */
export function withSourceDate<T extends { source_id: string }>(item: T, dates: Map<string, SourceDate>): T & Partial<SourceDate> {
  const found = dates.get(item.source_id.toLowerCase());
  return found ? { ...item, ...found } : item;
}
