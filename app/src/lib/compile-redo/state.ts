/**
 * Redo of the last compile (GitHub #140): its points, limits and the saved
 * record of the current or last redo.
 *
 * n8n forwards only the session id (CLAUDE.md rule 3), so the run reads the
 * redo from this record (a settings row, like the wiki repair's): a session
 * whose record is 'running' runs in redo mode (app/api/compile/run). The
 * record stays 'running' until the pipeline completes, so a Retry after a
 * failed redo continues the redo; a newer compile makes it irrelevant (the
 * record names its session). Never in backups (lib/backup-settings.ts).
 */

import { getSetting, setSetting } from '../db';

/**
 * Where a redo starts: the plan (resolve, match, plan, then onward), the
 * writing (draft onward) or the saving (commit onward). Never fetch or
 * extract (FR-3).
 */
export type RedoPoint = 'plan' | 'write' | 'save';
export const REDO_POINTS: readonly RedoPoint[] = ['plan', 'write', 'save'];

export const REDO_POINT_LABELS: Record<RedoPoint, string> = {
  plan: 'Re-plan the pages',
  write: 'Re-write the pages',
  save: 'Re-save the pages',
};

/** Settings row holding the record as JSON. Never in backups. */
export const COMPILE_REDO_STATE_KEY = 'compile_redo_state';

/**
 * Rule 7 hard cap: a redo writes at most this many pages. A larger compile
 * is refused at confirmation, and a re-plan whose new plan grows past what
 * the owner confirmed stops before writing (lib/compile-redo/replan.ts).
 */
export const MAX_REDO_PAGES = 300;

/** A re-plan may plan up to this many times the pages the compile has now (plus REPLAN_SLACK_PAGES). */
export const REPLAN_HIGH_FACTOR = 1.5;
export const REPLAN_SLACK_PAGES = 5;

export interface RedoPage {
  page_id: string;
  title: string;
}

export interface RedoRecord {
  session_id: string;
  point: RedoPoint;
  status: 'running' | 'finished';
  /** The Settings model the redo runs on (OQ-2), stamped on the session. */
  model: string;
  model_label: string;
  /** What the owner confirmed. */
  confirmed: {
    pages: number;
    max_pages: number;
    calls_low: number;
    calls_high: number;
    cost_usd_low: number;
    cost_usd_high: number;
    minutes_low: number;
    minutes_high: number;
  };
  /**
   * Pages this compile created and nothing changed since, with their version
   * (lib/page-rewrite.ts pageTextVersionToken) at confirmation. A re-plan
   * archives those its new plan leaves out (FR-6) if still unchanged.
   */
  own_pages: Array<RedoPage & { version: string }>;
  /** Pages changed since the compile by something else: left alone (FR-8). */
  skipped: RedoPage[];
  /** Today's AI spending (GET /llm/usage) when the redo started; null when unknown. */
  usage_at_start: { date: string; total_usd: number } | null;
  outcome: {
    planned: number;
    saved: number;
    archived: RedoPage[];
    /** Pages the save left alone because they changed meanwhile. */
    skipped_on_save: number;
    spent_usd: number | null;
  } | null;
  started_at: string;
  finished_at: string | null;
}

export function saveRedo(record: RedoRecord): void {
  setSetting(COMPILE_REDO_STATE_KEY, JSON.stringify(record));
}

/** The saved record, or null when there is none or it does not read back. */
export function readRedo(): RedoRecord | null {
  const raw = getSetting(COMPILE_REDO_STATE_KEY);
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as RedoRecord;
    if (typeof r?.session_id !== 'string' || !REDO_POINTS.includes(r.point) || !Array.isArray(r.own_pages)) return null;
    return r;
  } catch {
    return null;
  }
}

/** The redo this session's pipeline runs, or null for a normal run. */
export function activeRedo(sessionId: string): RedoRecord | null {
  const r = readRedo();
  return r && r.session_id === sessionId && r.status === 'running' ? r : null;
}
