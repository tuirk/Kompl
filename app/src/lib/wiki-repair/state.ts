/**
 * State of the wiki repair (lib/wiki-repair/run.ts).
 *
 * The running run lives on globalThis, like the page update's, so dev-server
 * reloads share one run. Its record is also saved in a settings row
 * (WIKI_REPAIR_STATE_KEY) at every step and after every page, so after a
 * stop or an app restart Settings still says what was done, where the
 * backup is, and which pages are still waiting to be rebuilt: the next run
 * continues with them.
 */

import { getSetting, setSetting } from '../db';
import { WIKI_REPAIR_FLAG, WIKI_REPAIR_STATE_KEY } from './limits';

export type RepairStep = 'backup' | 'aliases' | 'mentions' | 'links' | 'pages' | 'labels';
export const REPAIR_STEPS: readonly RepairStep[] = ['backup', 'aliases', 'mentions', 'links', 'pages', 'labels'];

export type RepairStopReason =
  | 'user'
  | 'flag_off'
  | 'daily_cost_ceiling'
  | 'rate_limited'
  | 'nlp_unreachable'
  | 'overspend'
  | 'consecutive_failures'
  | 'pages_over_confirmed'
  | 'restart'
  | 'error';

/** A page whose sources changed and that is still to be rebuilt. */
export interface PendingPage {
  page_id: string;
  title: string;
  /** Sources that no longer name the page. */
  remove: string[];
  /** Sources that now name it. */
  add: string[];
}

export interface RepairIssue {
  page_id: string;
  title: string;
  /** RedraftError code, or 'no_sources_left'. */
  reason: string;
  message: string;
}

export interface RepairRun {
  run_id: string;
  status: 'running' | 'finished' | 'stopped';
  stop_requested: boolean;
  /** Locked at confirmation, like a compile session's model. */
  model: string;
  model_label: string;
  /** The step running now, or the one the run stopped in. */
  step: RepairStep | null;
  steps_done: RepairStep[];
  backup: { file: string; bytes: number; taken_at: string } | null;
  aliases: { total: number; judged: number; confirmed: number; retired: number; undecided: number };
  mentions: { sources: number; pages: number } | null;
  /** Links through unused name matches corrected; absent in a record saved before this step existed. */
  links?: { pages: number; links: number; missed: number } | null;
  pages: {
    total: number;
    done: number;
    rebuilt: number;
    skipped: number;
    failed: number;
    consecutive_failures: number;
    current_title: string | null;
  };
  labels: { merged: number; pages: number } | null;
  /** What the owner confirmed: the run's fixed bounds and its estimate. */
  confirmed: {
    aliases: number;
    max_pages: number;
    cost_usd_low: number;
    cost_usd_high: number;
    minutes_low: number;
    minutes_high: number;
  };
  spend_limit_usd: number;
  spent_usd: number;
  stop_reason: RepairStopReason | null;
  last_error: string | null;
  /** Pages skipped or failed (the most recent ones). */
  issues: RepairIssue[];
  /** Pages still to rebuild; a later run continues with them. */
  pending_pages: PendingPage[];
  started_at: string;
  finished_at: string | null;
}

interface RepairState {
  starting: boolean;
  run: RepairRun | null;
}

const STATE_KEY = '__komplWikiRepair';

export function repairState(): RepairState {
  const g = globalThis as { [STATE_KEY]?: RepairState };
  return (g[STATE_KEY] ??= { starting: false, run: null });
}

export function isWikiRepairRunning(): boolean {
  const s = repairState();
  return s.starting || s.run?.status === 'running';
}

/**
 * 409 body for a compile entry route while the wiki is being repaired, or
 * null. Same shape as pageUpgradeBlock (lib/page-upgrade-state.ts).
 */
export function wikiRepairBlock(): { error_code: 'wiki_repair_in_progress'; error: string } | null {
  if (!isWikiRepairRunning()) return null;
  return {
    error_code: 'wiki_repair_in_progress',
    error: 'Kompl is repairing the wiki. Start the compile once the repair finishes, or stop the repair in Settings → Wiki health.',
  };
}

/** Saves the run's record (the settings row). */
export function saveRun(run: RepairRun): void {
  setSetting(WIKI_REPAIR_STATE_KEY, JSON.stringify(run));
}

/** The last run's record, or null when there is none or it does not read back. */
export function readSavedRun(): RepairRun | null {
  const raw = getSetting(WIKI_REPAIR_STATE_KEY);
  if (!raw) return null;
  try {
    const run = JSON.parse(raw) as RepairRun;
    if (typeof run?.run_id !== 'string' || !Array.isArray(run.pending_pages)) return null;
    return run;
  } catch {
    return null;
  }
}

/** The run to show: the live one, else the saved record. */
export function currentRun(): RepairRun | null {
  return repairState().run ?? readSavedRun();
}

/**
 * After an app restart: the flag goes back to off, and a run the old process
 * left 'running' is recorded as stopped by the restart (its pages waiting to
 * be rebuilt stay listed for the next run).
 */
export function settleAfterRestart(): void {
  if (getSetting(WIKI_REPAIR_FLAG) === '1') setSetting(WIKI_REPAIR_FLAG, '0');
  const run = readSavedRun();
  if (run?.status !== 'running') return;
  saveRun({
    ...run,
    status: 'stopped',
    stop_reason: 'restart',
    stop_requested: false,
    pages: { ...run.pages, current_title: null },
    finished_at: new Date().toISOString(),
  });
}

/** Test-only: forget any run (state is process-global). */
export function __resetWikiRepairStateForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__resetWikiRepairStateForTesting may only be called when NODE_ENV=test');
  }
  repairState().starting = false;
  repairState().run = null;
}
