/**
 * Stored triage failures (table triage_rechecks, schema v30).
 *
 * A match triage call that gives no verdict (rate limit, daily cost
 * ceiling, error) leaves its (source, page) pair unchecked: no plan, no
 * provenance link, and match never looks at that source again once it is
 * compiled. Each such pair is kept here, and a later compile's match step
 * may check it again (lib/compile/triage-recheck.ts).
 *
 * Retry state, not wiki content: backups leave the table out, and deleting
 * the source or the page removes the pair (ON DELETE CASCADE).
 */

import { getDb, getSetting, setSetting } from './db';
import type { TriageFailure, TriageResponse } from './triage-call';

export { MAX_TRIAGE_ATTEMPTS, MAX_TRIAGE_RECHECKS_PER_COMPILE } from './triage-recheck-limits';

/**
 * CLAUDE.md rule 7 feature flag (settings row): re-checking stored pairs is
 * one LLM call per pair. '1' turns it on; off by default. Set from Settings,
 * never restored from a backup (lib/backup-settings.ts).
 */
export const TRIAGE_RECHECK_FLAG = 'triage_recheck_enabled';

export function getTriageRecheckEnabled(): boolean {
  return getSetting(TRIAGE_RECHECK_FLAG) === '1';
}

export function setTriageRecheckEnabled(value: boolean): void {
  setSetting(TRIAGE_RECHECK_FLAG, value ? '1' : '0');
}

/**
 * Stores a failed triage of (source, page), or counts one more failure of a
 * stored pair. A daily cost ceiling refusal is not an attempt: the call was
 * never made. Clears any re-check verdict the pair held. Returns the pair's
 * attempts, or null when the source or page no longer exists (nothing is
 * stored then).
 */
export function recordTriageFailure(
  sourceId: string,
  pageId: string,
  reason: TriageFailure,
  sessionId: string,
): number | null {
  const counted = reason === 'daily_cost_ceiling' ? 0 : 1;
  const row = getDb()
    .prepare(
      `INSERT INTO triage_rechecks (source_id, page_id, reason, attempts, session_id)
       SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM sources WHERE source_id = ?)
          AND EXISTS (SELECT 1 FROM pages WHERE page_id = ?)
       ON CONFLICT (source_id, page_id) DO UPDATE SET
         reason             = excluded.reason,
         attempts           = attempts + excluded.attempts,
         last_failed_at     = CURRENT_TIMESTAMP,
         session_id         = excluded.session_id,
         verdict            = NULL,
         verdict_reason     = NULL,
         verdict_session_id = NULL
       RETURNING attempts`,
    )
    .get(sourceId, pageId, reason, counted, sessionId, sourceId, pageId) as { attempts: number } | undefined;
  return row?.attempts ?? null;
}

export function removeTriagePair(sourceId: string, pageId: string): void {
  getDb().prepare('DELETE FROM triage_rechecks WHERE source_id = ? AND page_id = ?').run(sourceId, pageId);
}

/**
 * Keeps a re-check's verdict on the pair for the session that asked. A retry
 * of that session that plans again hands it to plan without a new call;
 * clearSessionRecheckVerdicts removes the pair once the session completes.
 */
export function stampRecheckVerdict(
  sourceId: string,
  pageId: string,
  verdict: TriageResponse,
  sessionId: string,
): void {
  getDb()
    .prepare(
      `UPDATE triage_rechecks
          SET verdict = ?, verdict_reason = ?, verdict_session_id = ?
        WHERE source_id = ? AND page_id = ?`,
    )
    .run(verdict.decision, verdict.reason, sessionId, sourceId, pageId);
}

/** The session completed: its plans hold the verdicts its re-checks gave. */
export function clearSessionRecheckVerdicts(sessionId: string): number {
  return getDb().prepare('DELETE FROM triage_rechecks WHERE verdict_session_id = ?').run(sessionId).changes;
}

/** Stored pairs still waiting for a verdict (this session's answered ones left out). */
export function countWaitingTriagePairs(sessionId: string): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS n FROM triage_rechecks WHERE verdict_session_id IS NULL OR verdict_session_id != ?')
      .get(sessionId) as { n: number }
  ).n;
}

/** A stored pair with what the re-check needs to know about its source and page. */
export interface StoredTriagePair {
  source_id: string;
  page_id: string;
  reason: string;
  attempts: number;
  verdict: TriageResponse['decision'] | null;
  verdict_reason: string | null;
  verdict_session_id: string | null;
  /** 0 when the source row is gone (the cascade normally removes the pair first). */
  source_exists: 0 | 1;
  source_title: string | null;
  source_status: string | null;
  compile_status: string | null;
  page_exists: 0 | 1;
  page_title: string | null;
  page_summary: string | null;
  /** The source is already recorded on the page. */
  linked: 0 | 1;
  /** Every source behind the page is archived (as getAllArchivedPageIds, uncached). */
  page_archived: 0 | 1;
}

/** Every stored pair, oldest failure first. */
export function listStoredTriagePairs(): StoredTriagePair[] {
  return getDb()
    .prepare(
      `SELECT t.source_id, t.page_id, t.reason, t.attempts,
              t.verdict, t.verdict_reason, t.verdict_session_id,
              s.source_id IS NOT NULL AS source_exists,
              s.title AS source_title, s.status AS source_status, s.compile_status,
              p.page_id IS NOT NULL AS page_exists,
              p.title AS page_title, p.summary AS page_summary,
              EXISTS (SELECT 1 FROM provenance pr
                       WHERE pr.source_id = t.source_id AND pr.page_id = t.page_id) AS linked,
              (EXISTS (SELECT 1 FROM provenance pr JOIN sources ps ON ps.source_id = pr.source_id
                        WHERE pr.page_id = t.page_id)
               AND NOT EXISTS (SELECT 1 FROM provenance pr JOIN sources ps ON ps.source_id = pr.source_id
                                WHERE pr.page_id = t.page_id AND ps.status IS NOT 'archived')) AS page_archived
         FROM triage_rechecks t
         LEFT JOIN sources s ON s.source_id = t.source_id
         LEFT JOIN pages p ON p.page_id = t.page_id
        ORDER BY t.first_failed_at, t.source_id, t.page_id`,
    )
    .all() as StoredTriagePair[];
}
