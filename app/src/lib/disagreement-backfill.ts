/**
 * Filling the disagreements record (lib/disagreements.ts) from what a wiki
 * already holds, and carrying it through a .kompl backup. No LLM calls.
 *
 * backfillDisagreements runs once per install at boot (instrumentation.ts,
 * versioned by DISAGREEMENTS_BACKFILL_KEY) and after every import:
 *   - each page's current text: its Disputed/Changed sections. Pages
 *     committed before 1ff33db3 (Oct 10 2026), which first logged disputes,
 *     never reached the activity feed at all; pages after it only logged
 *     them. Backfilled findings are dated by the page's last update and are
 *     not logged to the feed again.
 *   - every triage verdict logged as page_contradiction_detected.
 * Idempotent: a page that already has page-text findings was synced at its
 * last commit and is left alone; triage findings are keyed by source.
 *
 * Backups: export writes every row (owner verdicts included) to
 * db/disagreements.json; import inserts them before the backfill, so a
 * restore keeps the owner's verdicts and a backup made before the record
 * gets one from its pages and activity log.
 */

import type Database from 'better-sqlite3';

import { readPageMarkdown } from './db';
import {
  DISAGREEMENT_FINDERS,
  DISAGREEMENT_KINDS,
  importTriageVerdicts,
  syncPageTextDisagreements,
} from './disagreements';

/** Settings row naming the backfill version this database has had. Not backed up (lib/backup-settings.ts). */
export const DISAGREEMENTS_BACKFILL_KEY = 'disagreements_backfill_version';
/** Bump when the backfill learns to find findings it used to miss. */
export const DISAGREEMENTS_BACKFILL_VERSION = '1';

/** Kompl's own pages, which record no disputes. */
const SKIPPED_PAGE_IDS = new Set(['saved-links']);
/** Pages read per write transaction. */
const BATCH = 200;

export interface BackfillResult {
  pages_read: number;
  page_text: number;
  triage: number;
}

export function backfillDisagreements(db: Database.Database): BackfillResult {
  const pages = db
    .prepare(
      `SELECT p.page_id, p.title, p.last_updated
         FROM pages p
        WHERE p.page_type != 'archived'
          AND NOT EXISTS (SELECT 1 FROM disagreements d WHERE d.page_id = p.page_id AND d.found_by = 'page_text')
        ORDER BY p.page_id`,
    )
    .all() as Array<{ page_id: string; title: string; last_updated: string | null }>;

  let pagesRead = 0;
  let pageText = 0;
  for (let i = 0; i < pages.length; i += BATCH) {
    // Files are read before the write transaction, never inside it.
    const batch = pages
      .slice(i, i + BATCH)
      .filter((p) => !SKIPPED_PAGE_IDS.has(p.page_id))
      .map((p) => {
        let markdown: string | null = null;
        try {
          markdown = readPageMarkdown(p.page_id);
        } catch (err) {
          console.error('[disagreement-backfill] could not read page', p.page_id, err);
        }
        return { ...p, markdown };
      })
      .filter((p): p is typeof p & { markdown: string } => p.markdown !== null);
    pagesRead += batch.length;
    db.transaction(() => {
      for (const p of batch) {
        pageText += syncPageTextDisagreements(db, p, p.markdown, { at: p.last_updated, log: false });
      }
    })();
  }

  const triage = importTriageVerdicts(db);
  return { pages_read: pagesRead, page_text: pageText, triage };
}

/** Every finding, for the .kompl backup. */
export function getAllDisagreements(db: Database.Database): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM disagreements ORDER BY created_at, rowid').all() as Array<Record<string, unknown>>;
}

const VERDICTS = new Set(['confirmed', 'dismissed']);

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Insert the backup's findings (db/disagreements.json), inside the import's
 * transaction after pages and sources. Rows that name an unknown kind or
 * finder, a page the backup lacks, or a key already present are skipped; a
 * side whose source is missing is kept as null. Status follows the owner's
 * verdict. Returns how many were inserted.
 */
export function importDisagreements(db: Database.Database, rows: unknown[]): number {
  const pageExists = db.prepare('SELECT 1 FROM pages WHERE page_id = ?');
  const sourceExists = db.prepare('SELECT 1 FROM sources WHERE source_id = ?');
  const insert = db.prepare(
    `INSERT OR IGNORE INTO disagreements
       (disagreement_id, page_id, found_by, kind, status, owner_verdict, owner_verdict_at,
        topic, reason, anchor, source_a, quote_a, source_b, quote_b, source_ids, match_key,
        session_id, created_at, updated_at, cleared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             COALESCE(?, datetime('now')), COALESCE(?, datetime('now')), ?)`,
  );
  let inserted = 0;
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = text(r.disagreement_id);
    const pageId = text(r.page_id);
    const foundBy = text(r.found_by);
    const kind = text(r.kind);
    const key = text(r.match_key);
    if (!id || !pageId || !key || !pageExists.get(pageId)) continue;
    if (!foundBy || !(DISAGREEMENT_FINDERS as readonly string[]).includes(foundBy)) continue;
    if (!kind || !(DISAGREEMENT_KINDS as readonly string[]).includes(kind)) continue;
    const verdict = text(r.owner_verdict);
    const ownerVerdict = verdict && VERDICTS.has(verdict) ? verdict : null;
    const side = (v: unknown) => {
      const s = text(v);
      return s && sourceExists.get(s) ? s : null;
    };
    let sourceIds = '[]';
    if (Array.isArray(r.source_ids)) sourceIds = JSON.stringify(r.source_ids.filter((s) => typeof s === 'string'));
    else if (typeof r.source_ids === 'string') {
      try {
        const parsed: unknown = JSON.parse(r.source_ids);
        if (Array.isArray(parsed)) sourceIds = JSON.stringify(parsed.filter((s) => typeof s === 'string'));
      } catch {
        // keep '[]'
      }
    }
    const result = insert.run(
      id,
      pageId,
      foundBy,
      kind,
      ownerVerdict ?? 'possible',
      ownerVerdict,
      ownerVerdict ? text(r.owner_verdict_at) : null,
      text(r.topic) ?? '',
      text(r.reason),
      text(r.anchor),
      side(r.source_a),
      text(r.quote_a),
      side(r.source_b),
      text(r.quote_b),
      sourceIds,
      key,
      text(r.session_id),
      text(r.created_at),
      text(r.updated_at),
      text(r.cleared_at),
    );
    inserted += result.changes;
  }
  return inserted;
}
