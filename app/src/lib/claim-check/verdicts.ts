/**
 * Saved claim-check verdicts (table claim_verdicts, schema v30 step;
 * scripts/migrate.py CLAIM_VERDICTS_SQL).
 *
 * Each pair of claims is judged once, by a compile's claim check or by the
 * whole-wiki check, whichever reaches it first; its verdict stays, so no
 * later run asks again (EpiKompl idea: saved verdicts). The verdict is the
 * judge's, never the owner's: the owner confirms or dismisses the finding
 * in the disagreements record (lib/disagreements.ts setOwnerVerdict), and
 * nothing here touches that.
 */

import type Database from 'better-sqlite3';

export const CLAIM_VERDICTS = ['disputed', 'outdated', 'scope', 'opinion', 'none'] as const;
export type ClaimVerdict = (typeof CLAIM_VERDICTS)[number];
export type ClaimCheckFinder = 'claim_check' | 'wiki_check';

export interface SavedClaimVerdict {
  pair_key: string;
  source_a: string;
  claim_a: string;
  source_b: string;
  claim_b: string;
  subject: string;
  verdict: ClaimVerdict;
  topic: string;
  reason: string | null;
  /** outdated only: the side whose source is provably later. */
  newer: 'a' | 'b' | null;
  found_by: ClaimCheckFinder;
  model: string | null;
  session_id: string | null;
}

/** Every judged pair's key. */
export function judgedPairKeys(db: Database.Database): Set<string> {
  const rows = db.prepare('SELECT pair_key FROM claim_verdicts').all() as Array<{ pair_key: string }>;
  return new Set(rows.map((r) => r.pair_key));
}

/**
 * Keep a pair's verdict. The first verdict stays: a pair judged meanwhile
 * (two runs at once) is not overwritten. Returns false then, or when either
 * source is gone. Synchronous; safe inside a transaction.
 */
export function saveClaimVerdict(db: Database.Database, v: SavedClaimVerdict): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO claim_verdicts
         (pair_key, source_a, claim_a, source_b, claim_b, subject, verdict, topic, reason,
          newer, found_by, model, session_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM sources WHERE source_id = ?)
          AND EXISTS (SELECT 1 FROM sources WHERE source_id = ?)`,
    )
    .run(
      v.pair_key,
      v.source_a,
      v.claim_a,
      v.source_b,
      v.claim_b,
      v.subject,
      v.verdict,
      v.topic,
      v.reason,
      v.newer,
      v.found_by,
      v.model,
      v.session_id,
      v.source_a,
      v.source_b,
    );
  return result.changes > 0;
}

/**
 * The whole-wiki check's open findings (not dismissed), newest first, as
 * GET /api/wiki/status lists the last health check's contradictions for
 * MCP wiki_status: the two sources, and the page with what they disagree on.
 */
export function wikiCheckFindings(db: Database.Database): Array<{ page_a: string; page_b: string; claim: string }> {
  const rows = db
    .prepare(
      `SELECT p.title AS page_title, d.topic, d.reason,
              COALESCE(sa.title, 'A source no longer in the wiki') AS title_a,
              COALESCE(sb.title, 'A source no longer in the wiki') AS title_b
         FROM disagreements d
         JOIN pages p ON p.page_id = d.page_id
         LEFT JOIN sources sa ON sa.source_id = d.source_a
         LEFT JOIN sources sb ON sb.source_id = d.source_b
        WHERE d.found_by = 'wiki_check' AND d.status != 'dismissed'
        ORDER BY d.created_at DESC, d.rowid DESC`,
    )
    .all() as Array<{ page_title: string; topic: string; reason: string | null; title_a: string; title_b: string }>;
  return rows.map((r) => ({
    page_a: r.title_a,
    page_b: r.title_b,
    claim: `${r.page_title}: ${r.topic}${r.reason ? `. ${r.reason}` : ''}`,
  }));
}

/** When the whole-wiki check last judged a pair; null if it never has. */
export function lastWikiCheckAt(db: Database.Database): string | null {
  const row = db
    .prepare(`SELECT MAX(judged_at) AS at FROM claim_verdicts WHERE found_by = 'wiki_check'`)
    .get() as { at: string | null };
  return row.at;
}

// ── Backups ────────────────────────────────────────────────────────────────

/** Every saved verdict, for the .kompl backup (db/claim_verdicts.json). */
export function getAllClaimVerdicts(db: Database.Database): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM claim_verdicts ORDER BY judged_at, pair_key').all() as Array<Record<string, unknown>>;
}

const FINDERS = new Set<string>(['claim_check', 'wiki_check']);

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Insert a backup's saved verdicts, inside the import's transaction after
 * the sources. Rows naming an unknown verdict or finder, a source the backup
 * lacks, or a pair already present are skipped. Backups from before the
 * table carry none: their pairs are simply judged again when checked.
 * Returns how many were inserted.
 */
export function importClaimVerdicts(db: Database.Database, rows: unknown[]): number {
  const sourceExists = db.prepare('SELECT 1 FROM sources WHERE source_id = ?');
  const insert = db.prepare(
    `INSERT OR IGNORE INTO claim_verdicts
       (pair_key, source_a, claim_a, source_b, claim_b, subject, verdict, topic, reason,
        newer, found_by, model, session_id, judged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(datetime(?), datetime('now')))`,
  );
  let inserted = 0;
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const pair = text(r.pair_key);
    const a = text(r.source_a);
    const b = text(r.source_b);
    const claimA = text(r.claim_a);
    const claimB = text(r.claim_b);
    const verdict = text(r.verdict);
    const finder = text(r.found_by);
    if (!pair || !a || !b || !claimA || !claimB || !sourceExists.get(a) || !sourceExists.get(b)) continue;
    if (!verdict || !(CLAIM_VERDICTS as readonly string[]).includes(verdict) || !finder || !FINDERS.has(finder)) continue;
    const newer = verdict === 'outdated' && (r.newer === 'a' || r.newer === 'b') ? r.newer : null;
    const result = insert.run(
      pair,
      a,
      claimA,
      b,
      claimB,
      typeof r.subject === 'string' ? r.subject : '',
      verdict,
      typeof r.topic === 'string' ? r.topic : '',
      text(r.reason),
      newer,
      finder,
      text(r.model),
      text(r.session_id),
      text(r.judged_at),
    );
    inserted += result.changes;
  }
  return inserted;
}
