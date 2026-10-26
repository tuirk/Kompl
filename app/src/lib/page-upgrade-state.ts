/**
 * In-process state of the bulk page update (lib/page-upgrade.ts).
 *
 * Kept on globalThis so dev-server reloads share one run instead of forking
 * a second loop. An app restart drops it, which simply ends the run: the
 * pages already updated carry the current draft_rules marker, so pressing
 * "Update all" again continues with the rest.
 *
 * Deliberately import-light: the compile entry routes read
 * pageUpgradeBlock() to refuse a new compile while pages are being updated
 * (the run measures its own spend from /llm/usage, so no compile may spend
 * alongside it).
 */

import { CURRENT_DRAFT_RULES } from './writing-rules';

/**
 * CLAUDE.md rule 7 feature flag (settings row), '0' by default. Only the
 * user's confirmation in Settings > Wiki health sets it, for one run; the end
 * of the run and Stop set it back. Never exported to or imported from backups.
 */
export const PAGE_UPGRADE_FLAG = 'page_upgrade_enabled';

/**
 * Settings row: the rules version (lib/writing-rules.ts) whose one-time
 * "pages were written by an earlier version" notice was closed. A release
 * with new rules shows the notice once more.
 */
export const PAGE_UPGRADE_NOTICE_DISMISSED = 'page_upgrade_notice_dismissed';

export type PageUpgradeStopReason =
  | 'user'
  | 'compile_started'
  | 'daily_cost_ceiling'
  | 'consecutive_failures'
  | 'overspend'
  | 'flag_off'
  | 'error';

export interface PageUpgradeIssue {
  page_id: string;
  title: string;
  /** RedraftError code, or 'already_current' / 'unexpected'. */
  error: string;
  message: string;
}

export interface PageUpgradeRun {
  run_id: string;
  status: 'running' | 'finished' | 'stopped';
  /** Stop pressed; the loop stops before the next page. */
  stop_requested: boolean;
  /** Locked at confirmation, like a compile session's model. */
  model: string;
  /** Pages counted at confirmation: the run's fixed iteration bound. */
  total: number;
  /** Pages handled so far: updated + skipped + failed. */
  done: number;
  updated: number;
  skipped: number;
  failed: number;
  consecutive_failures: number;
  current_page_id: string | null;
  current_title: string | null;
  /** The estimate the user confirmed (rounded, as shown). */
  estimate: { cost_usd_low: number; cost_usd_high: number; minutes_low: number; minutes_high: number };
  /** PAGE_UPGRADE_MAX_OVERSPEND × the confirmed high estimate. */
  spend_limit_usd: number;
  /** Measured from /llm/usage deltas while the run is going. */
  spent_usd: number;
  stop_reason: PageUpgradeStopReason | null;
  last_error: string | null;
  failures: PageUpgradeIssue[];
  skips: PageUpgradeIssue[];
  started_at: string;
  finished_at: string | null;
}

interface PageUpgradeState {
  /** A start request is between its checks and the launch. */
  starting: boolean;
  /** The current or most recent run (until the app restarts). */
  run: PageUpgradeRun | null;
}

const STATE_KEY = '__komplPageUpgrade';

export function pageUpgradeState(): PageUpgradeState {
  const g = globalThis as { [STATE_KEY]?: PageUpgradeState };
  return (g[STATE_KEY] ??= { starting: false, run: null });
}

export function isPageUpgradeRunning(): boolean {
  const state = pageUpgradeState();
  return state.starting || state.run?.status === 'running';
}

/**
 * 409 body for a compile entry route while pages are being updated, or null.
 * Same shape as the routes' session_in_progress refusal.
 */
export function pageUpgradeBlock(): { error_code: 'page_upgrade_in_progress'; error: string } | null {
  if (!isPageUpgradeRunning()) return null;
  return {
    error_code: 'page_upgrade_in_progress',
    error: `Kompl is updating pages to the ${CURRENT_DRAFT_RULES} writing rules. Start the compile once the update finishes, or stop the update in Settings → Wiki health.`,
  };
}

/** Test-only: forget any run (state is process-global). */
export function __resetPageUpgradeStateForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__resetPageUpgradeStateForTesting may only be called when NODE_ENV=test');
  }
  const state = pageUpgradeState();
  state.starting = false;
  state.run = null;
}
