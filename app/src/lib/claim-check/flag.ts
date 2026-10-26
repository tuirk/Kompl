/**
 * CLAUDE.md rule 7 feature flag of the compile's claim check (plan 3.3):
 * judging new sources' claims is up to MAX_CLAIM_CHECK_PAIRS_PER_COMPILE /
 * CLAIM_JUDGE_BATCH_SIZE extra LLM calls per compile. On by default since it
 * passed the accuracy bar the owner vetted (D3, plan 3.7; 2026-10-24: no
 * agreeing pair flagged, 9-10 of 10 found, on deepseek-flash and
 * gemini-2.5-flash); '0' turns it off. Set from Settings, never restored
 * from a backup (lib/backup-settings.ts).
 */

import { getSetting, setSetting } from '../db';

export const CLAIM_CHECK_FLAG = 'claim_check_enabled';

export function getClaimCheckEnabled(): boolean {
  return getSetting(CLAIM_CHECK_FLAG) !== '0';
}

export function setClaimCheckEnabled(value: boolean): void {
  setSetting(CLAIM_CHECK_FLAG, value ? '1' : '0');
}

/**
 * Rule 7 flag of the whole-wiki check (./wiki-check.ts): '0' by default,
 * armed only by the owner's confirmation in Settings > Wiki health for one
 * run, disarmed when the run ends or is stopped. Never restored from a
 * backup.
 */
export const WIKI_CHECK_FLAG = 'wiki_check_enabled';
