/**
 * Which settings rows a .kompl backup carries. Export leaves the others out
 * and import skips them, so backups made by older versions that still carry
 * them can't restore them either.
 */

import { ALIAS_SCREEN_THROUGH_KEY, ALIAS_SCREEN_VERSION_KEY } from './alias-screen';
import { CLAIM_CHECK_FLAG, WIKI_CHECK_FLAG } from './claim-check/flag';
import { COMPILE_REDO_STATE_KEY } from './compile-redo/state';
import { AGENT_ADD_SOURCES_KEY } from './db';
import { DISAGREEMENTS_BACKFILL_KEY } from './disagreement-backfill';
import { PAGE_UPGRADE_FLAG } from './page-upgrade-state';
import { SOURCE_DATES_BACKFILL_KEY } from './source-date-backfill';
import { TRIAGE_RECHECK_FLAG } from './triage-rechecks';
import { WIKI_REPAIR_FLAG, WIKI_REPAIR_STATE_KEY } from './wiki-repair/limits';

const NOT_BACKED_UP = new Set([
  // Belongs to this database (migrate.py owns it). Restoring an older value
  // would make /api/health report the DB as broken until the next restart
  // re-ran migrations; the version travels in manifest.json instead.
  'schema_version',
  // Arms one confirmed page-update run; a backup never arms it.
  PAGE_UPGRADE_FLAG,
  // Letting AI agents add sources (paid compiles) is this install's choice;
  // a backup never turns it on.
  AGENT_ADD_SOURCES_KEY,
  // Re-checking failed triage calls spends AI calls: this install's choice,
  // never switched on by a restore (lib/triage-rechecks.ts).
  TRIAGE_RECHECK_FLAG,
  // The compile's claim check spends AI calls: this install's choice, never
  // switched on by a restore (lib/claim-check/flag.ts).
  CLAIM_CHECK_FLAG,
  // Arms one confirmed whole-wiki check run; a backup never arms it.
  WIKI_CHECK_FLAG,
  // Arms one confirmed wiki repair run; a backup never arms it.
  WIKI_REPAIR_FLAG,
  // The last wiki repair run on this install (lib/wiki-repair/state.ts): its
  // backup file and the pages it left waiting belong to this database.
  WIKI_REPAIR_STATE_KEY,
  // The redo of this install's last compile (lib/compile-redo/state.ts):
  // its session and pages belong to this database.
  COMPILE_REDO_STATE_KEY,
  // Which of this database's alias rows the alias screen has looked at
  // (lib/alias-screen.ts); a backup's ids mean nothing here.
  ALIAS_SCREEN_VERSION_KEY,
  ALIAS_SCREEN_THROUGH_KEY,
  // Whether this database's pages were read into the disagreements record
  // (lib/disagreement-backfill.ts); a restore runs that itself.
  DISAGREEMENTS_BACKFILL_KEY,
  // Whether this database's undated sources were dated from their text
  // (lib/source-date-backfill.ts); a restore runs that itself.
  SOURCE_DATES_BACKFILL_KEY,
]);

export function isBackedUpSetting(key: string): boolean {
  return !NOT_BACKED_UP.has(key);
}
