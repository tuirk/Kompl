/**
 * The disagreements record (plan 3.4): every disagreement Kompl knows about
 * on a page, whoever found it, with the owner's verdict. One table
 * (scripts/migrate.py DISAGREEMENTS_SQL) behind the page panel, the activity
 * feed, MCP read_page and recent_changes.
 *
 * Who finds them (found_by):
 *   page_text    the page's own "### Disputed:" / "### Changed:" sections
 *                (lib/page-disputes.ts). Every commit path syncs them from
 *                the committed markdown inside its Phase 2 transaction
 *                (recordPageDisagreements, CLAUDE.md rule 5).
 *   triage       a new source the match triage judged to contradict the
 *                page (lib/compile/triage-disagreement.ts). Verdicts logged
 *                before the record existed come in once through
 *                importTriageVerdicts (lib/disagreement-backfill.ts).
 *   claim_check  the claim check (plan 3.3) and
 *   wiki_check   the whole-wiki check (plan 3.6) call recordDisagreement.
 *
 * Status is 'possible' until the owner confirms or dismisses a finding
 * (setOwnerVerdict). Nothing else ever writes owner_verdict, and status
 * follows it, so a later compile or check never overturns the owner.
 * Synchronous SQLite only: every write is safe inside a caller's
 * transaction.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

import { getDb, logActivity } from './db';
import { findPageDisputes } from './page-disputes';

/** disputed: a live disagreement; changed: a claim a later source superseded; contradiction: not classified yet. */
export const DISAGREEMENT_KINDS = ['disputed', 'changed', 'contradiction', 'scope', 'opinion'] as const;
export type DisagreementKind = (typeof DISAGREEMENT_KINDS)[number];
export const DISAGREEMENT_FINDERS = ['page_text', 'triage', 'claim_check', 'wiki_check'] as const;
export type DisagreementFinder = (typeof DISAGREEMENT_FINDERS)[number];
export type DisagreementStatus = 'possible' | 'confirmed' | 'dismissed';
export type OwnerVerdict = 'confirmed' | 'dismissed';

export interface Disagreement {
  disagreement_id: string;
  page_id: string;
  found_by: DisagreementFinder;
  kind: DisagreementKind;
  status: DisagreementStatus;
  owner_verdict: OwnerVerdict | null;
  owner_verdict_at: string | null;
  topic: string;
  reason: string | null;
  anchor: string | null;
  source_a: string | null;
  quote_a: string | null;
  source_b: string | null;
  quote_b: string | null;
  /** Every source involved: both sides, or every source a page section cites. */
  source_ids: string[];
  match_key: string;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  /** page_text: when the page's text stopped recording it (null while it does). */
  cleared_at: string | null;
}

type Row = Omit<Disagreement, 'source_ids'> & { source_ids: string };

function parseIds(raw: string | null): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function fromRow(row: Row): Disagreement {
  return { ...row, source_ids: parseIds(row.source_ids) };
}

/** A finding from a check (anything but the page's own text). */
export interface DisagreementFinding {
  page_id: string;
  found_by: Exclude<DisagreementFinder, 'page_text'>;
  kind: DisagreementKind;
  /**
   * One finding per (page, found_by, key): recording the same key again
   * updates that finding. Defaults to the new source for a triage verdict
   * and to the two sides ("a|b") otherwise (defaultFindingKey). Pass one
   * when a pair of sources can disagree more than once, e.g. the two
   * claims' ids.
   */
  key?: string;
  topic?: string;
  reason?: string | null;
  /** Side a and its exact quote; null when side a is the page itself. */
  source_a?: string | null;
  quote_a?: string | null;
  source_b?: string | null;
  quote_b?: string | null;
  session_id?: string | null;
  /** When it was found, for findings recorded after the fact; default now. */
  at?: string | null;
}

/** The sides that are sources in this wiki; a side whose source is gone is recorded as null. */
function knownSources(db: Database.Database, ids: Array<string | null | undefined>): Set<string> {
  const wanted = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (wanted.length === 0) return new Set();
  const rows = db
    .prepare(`SELECT source_id FROM sources WHERE source_id IN (${wanted.map(() => '?').join(', ')})`)
    .all(...wanted) as Array<{ source_id: string }>;
  return new Set(rows.map((r) => r.source_id));
}

/**
 * The key a finding gets when the caller names none: a triage verdict is
 * one per (page, new source), whatever side a it names; any other finding
 * is one per pair of sides.
 */
export function defaultFindingKey(finding: Pick<DisagreementFinding, 'found_by' | 'source_a' | 'source_b'>): string {
  if (finding.found_by === 'triage') return finding.source_b ?? '';
  return `${finding.source_a ?? ''}|${finding.source_b ?? ''}`;
}

/**
 * Record a disagreement a check found, or refresh the same finding (same
 * page, finder and key): kind, topic, reason, sides and quotes are updated
 * (a quote or reason left out keeps the stored one); status and the
 * owner's verdict never change here. Synchronous; safe inside a
 * transaction. Throws on an unknown kind or finder, or a page that does not
 * exist.
 *
 * For the triage step (plan 3.5): on a 'contradiction' verdict call
 *   recordDisagreement(db, { page_id, found_by: 'triage', kind: 'contradiction',
 *     source_b: newSourceId, reason, session_id,
 *     source_a?, quote_a?, quote_b? })   // the cited claim it contradicts, when known
 * Its default key (the new source) matches the findings imported from
 * page_contradiction_detected rows, so logging both never doubles one.
 */
export function recordDisagreement(
  db: Database.Database,
  finding: DisagreementFinding,
  options: { insertOnly?: boolean } = {},
): { disagreement_id: string; created: boolean } {
  if (!(DISAGREEMENT_KINDS as readonly string[]).includes(finding.kind)) {
    throw new Error(`unknown disagreement kind: ${finding.kind}`);
  }
  // Page text is synced from the committed markdown, never recorded by hand.
  const finder: string = finding.found_by;
  if (!(DISAGREEMENT_FINDERS as readonly string[]).includes(finder) || finder === 'page_text') {
    throw new Error(`unknown disagreement finder: ${finding.found_by}`);
  }
  const key = finding.key ?? defaultFindingKey(finding);
  const known = knownSources(db, [finding.source_a, finding.source_b]);
  const sideA = finding.source_a && known.has(finding.source_a) ? finding.source_a : null;
  const sideB = finding.source_b && known.has(finding.source_b) ? finding.source_b : null;
  const sourceIds = [...new Set([finding.source_a, finding.source_b].filter((id): id is string => !!id))];

  const existing = db
    .prepare('SELECT disagreement_id FROM disagreements WHERE page_id = ? AND found_by = ? AND match_key = ?')
    .get(finding.page_id, finding.found_by, key) as { disagreement_id: string } | undefined;
  if (existing) {
    if (!options.insertOnly) {
      db.prepare(
        `UPDATE disagreements
            SET kind = ?, topic = COALESCE(NULLIF(?, ''), topic), reason = COALESCE(?, reason),
                source_a = ?, quote_a = COALESCE(?, quote_a), source_b = ?, quote_b = COALESCE(?, quote_b),
                source_ids = ?, session_id = COALESCE(?, session_id),
                updated_at = datetime('now'), cleared_at = NULL
          WHERE disagreement_id = ?`,
      ).run(
        finding.kind,
        finding.topic ?? '',
        finding.reason ?? null,
        sideA,
        finding.quote_a ?? null,
        sideB,
        finding.quote_b ?? null,
        JSON.stringify(sourceIds),
        finding.session_id ?? null,
        existing.disagreement_id,
      );
    }
    return { disagreement_id: existing.disagreement_id, created: false };
  }

  const id = randomUUID();
  db.prepare(
    `INSERT INTO disagreements
       (disagreement_id, page_id, found_by, kind, status, topic, reason,
        source_a, quote_a, source_b, quote_b, source_ids, match_key, session_id,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, 'possible', ?, ?, ?, ?, ?, ?, ?, ?, ?,
             COALESCE(datetime(?), datetime('now')), datetime('now'))`,
  ).run(
    id,
    finding.page_id,
    finding.found_by,
    finding.kind,
    finding.topic ?? '',
    finding.reason ?? null,
    sideA,
    finding.quote_a ?? null,
    sideB,
    finding.quote_b ?? null,
    JSON.stringify(sourceIds),
    key,
    finding.session_id ?? null,
    finding.at ?? null,
  );
  return { disagreement_id: id, created: true };
}

function sameSources(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

/** Was this page-text dispute logged to the feed before the record existed (activity rows only)? */
function loggedBefore(db: Database.Database, pageId: string): Array<{ topic: string; sourceIds: string[] }> {
  const rows = db
    .prepare(
      `SELECT details FROM activity_log
        WHERE action_type = 'page_dispute_recorded' AND json_extract(details, '$.page_id') = ?`,
    )
    .all(pageId) as Array<{ details: string | null }>;
  return rows.map((row) => {
    try {
      const d = JSON.parse(row.details ?? '{}') as { topic?: unknown; source_ids?: unknown };
      return {
        topic: typeof d.topic === 'string' ? d.topic.toLowerCase() : '',
        sourceIds: Array.isArray(d.source_ids) ? d.source_ids.filter((s): s is string => typeof s === 'string') : [],
      };
    } catch {
      return { topic: '', sourceIds: [] };
    }
  });
}

/**
 * Bring a page's page_text findings in line with the disputes its markdown
 * records. A dispute is the same finding as a stored one with the same
 * topic or the same cited sources (the model rewords between updates); a
 * finding the text no longer records is marked cleared, and comes back with
 * its verdict if the text records it again. Each new finding is logged once
 * as page_dispute_recorded unless `log` is false. Returns how many are new.
 * Throws on a database error; callers use recordPageDisagreements.
 */
export function syncPageTextDisagreements(
  db: Database.Database,
  page: { page_id: string; title: string },
  markdown: string,
  options: { session_id?: string | null; at?: string | null; log?: boolean } = {},
): number {
  const disputes = findPageDisputes(markdown);
  const stored = (
    db
      .prepare(
        `SELECT * FROM disagreements WHERE page_id = ? AND found_by = 'page_text'
          ORDER BY cleared_at IS NOT NULL, created_at, rowid`,
      )
      .all(page.page_id) as Row[]
  ).map(fromRow);
  const used = new Set<string>();
  const added: Array<{ id: string; dispute: (typeof disputes)[number] }> = [];

  for (const dispute of disputes) {
    const topic = dispute.topic.toLowerCase();
    const match = stored.find(
      (s) => !used.has(s.disagreement_id) && (s.topic.toLowerCase() === topic || sameSources(s.source_ids, dispute.sourceIds)),
    );
    if (match) {
      used.add(match.disagreement_id);
      const changed =
        match.kind !== dispute.kind ||
        match.topic !== dispute.topic ||
        match.anchor !== dispute.anchor ||
        match.cleared_at !== null ||
        match.source_ids.join('\n') !== dispute.sourceIds.join('\n');
      if (changed) {
        db.prepare(
          `UPDATE disagreements
              SET kind = ?, topic = ?, anchor = ?, source_ids = ?, session_id = COALESCE(?, session_id),
                  updated_at = datetime('now'), cleared_at = NULL
            WHERE disagreement_id = ?`,
        ).run(
          dispute.kind,
          dispute.topic,
          dispute.anchor,
          JSON.stringify(dispute.sourceIds),
          options.session_id ?? null,
          match.disagreement_id,
        );
      }
      continue;
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO disagreements
         (disagreement_id, page_id, found_by, kind, status, topic, anchor, source_ids, match_key,
          session_id, created_at, updated_at)
       VALUES (?, ?, 'page_text', ?, 'possible', ?, ?, ?, ?, ?,
               COALESCE(datetime(?), datetime('now')), datetime('now'))`,
    ).run(
      id,
      page.page_id,
      dispute.kind,
      dispute.topic,
      dispute.anchor,
      JSON.stringify(dispute.sourceIds),
      id,
      options.session_id ?? null,
      options.at ?? null,
    );
    used.add(id);
    added.push({ id, dispute });
  }

  db.prepare(
    `UPDATE disagreements SET cleared_at = datetime('now'), updated_at = datetime('now')
      WHERE page_id = ? AND found_by = 'page_text' AND cleared_at IS NULL
        AND disagreement_id NOT IN (SELECT value FROM json_each(?))`,
  ).run(page.page_id, JSON.stringify([...used]));

  if (added.length > 0 && options.log !== false) {
    // Disputes logged by releases before the record are not new either.
    const logged = loggedBefore(db, page.page_id);
    for (const { id, dispute } of added) {
      const topic = dispute.topic.toLowerCase();
      if (logged.some((l) => l.topic === topic || sameSources(l.sourceIds, dispute.sourceIds))) continue;
      logActivity('page_dispute_recorded', {
        source_id: null,
        session_id: options.session_id ?? null,
        details: {
          page_id: page.page_id,
          title: page.title,
          kind: dispute.kind,
          topic: dispute.topic,
          anchor: dispute.anchor,
          source_ids: dispute.sourceIds,
          disagreement_id: id,
        },
      });
    }
  }
  return added.length;
}

/**
 * The commit paths' call (compile commit, draft approval, page update and
 * restore, recompile): syncs the page_text findings from the committed
 * markdown inside the caller's Phase 2 transaction. Runs in its own
 * savepoint, so a failure here rolls back only the record's writes and
 * never the page commit; the next commit of the page syncs it again.
 * Returns how many findings are new.
 */
export function recordPageDisagreements(
  db: Database.Database,
  page: { page_id: string; title: string },
  markdown: string,
  options: { session_id?: string | null } = {},
): number {
  try {
    return db.transaction(() => syncPageTextDisagreements(db, page, markdown, options))();
  } catch (err) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'disagreements_sync_failed',
        page_id: page.page_id,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return 0;
  }
}

/**
 * Record the triage verdicts logged as page_contradiction_detected that the
 * record does not hold yet (one page, or every page). Insert-only and keyed
 * like recordDisagreement's triage findings, so it never doubles one or
 * touches a verdict. Returns how many it added.
 */
export function importTriageVerdicts(db: Database.Database, pageId?: string): number {
  const rows = db
    .prepare(
      `SELECT a.id, a.timestamp, a.source_id, a.details
         FROM activity_log a
        WHERE a.action_type = 'page_contradiction_detected'
          ${pageId ? "AND json_extract(a.details, '$.page_id') = ?" : ''}
        ORDER BY a.id`,
    )
    .all(...(pageId ? [pageId] : [])) as Array<{ id: number; timestamp: string; source_id: string | null; details: string | null }>;
  if (rows.length === 0) return 0;
  const pageExists = db.prepare('SELECT 1 FROM pages WHERE page_id = ?');
  let added = 0;
  db.transaction(() => {
    for (const row of rows) {
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(row.details ?? '{}') as Record<string, unknown>;
      } catch {
        continue;
      }
      const page = typeof d.page_id === 'string' ? d.page_id : null;
      if (!page || !pageExists.get(page)) continue;
      const source = row.source_id ?? (typeof d.source_id === 'string' ? d.source_id : null);
      const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
      const result = recordDisagreement(
        db,
        {
          page_id: page,
          found_by: 'triage',
          kind: 'contradiction',
          // A verdict whose source id was never logged keys on its row.
          key: source ? undefined : `activity:${row.id}`,
          source_b: source,
          reason: str(d.reason),
          session_id: str(d.session_id),
          at: str(d.detected_at) ?? row.timestamp,
        },
        { insertOnly: true },
      );
      if (result.created) added++;
    }
  })();
  return added;
}

/** A page's findings: page text first, then the checks', oldest first. Cleared page-text findings only when asked. */
export function listPageDisagreements(pageId: string, options: { includeCleared?: boolean } = {}): Disagreement[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM disagreements
        WHERE page_id = ? ${options.includeCleared ? '' : 'AND cleared_at IS NULL'}
        ORDER BY found_by != 'page_text', created_at, rowid`,
    )
    .all(pageId) as Row[];
  return rows.map(fromRow);
}

export function getDisagreement(id: string): Disagreement | null {
  const row = getDb().prepare('SELECT * FROM disagreements WHERE disagreement_id = ?').get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

/**
 * The owner's verdict: 'confirmed', 'dismissed', or null to take it back.
 * Status follows it. The only writer of owner_verdict. Returns the updated
 * finding, or null when there is no such finding.
 */
export function setOwnerVerdict(id: string, verdict: OwnerVerdict | null): Disagreement | null {
  const result = getDb()
    .prepare(
      `UPDATE disagreements
          SET owner_verdict = ?,
              owner_verdict_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END,
              status = COALESCE(?, 'possible'),
              updated_at = datetime('now')
        WHERE disagreement_id = ?`,
    )
    .run(verdict, verdict, verdict, id);
  return result.changes > 0 ? getDisagreement(id) : null;
}
