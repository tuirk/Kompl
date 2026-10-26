/**
 * The wiki repair's hard limits and settings keys (CLAUDE.md rule 7).
 * Import-light: backup-settings.ts and the compile entry routes read these.
 */

/**
 * Rule 7 feature flag (settings row), '0' by default. Only the owner's
 * confirmation in Settings > Wiki health sets it, for one run; the end of the
 * run, Stop and an app restart set it back. Never in backups.
 */
export const WIKI_REPAIR_FLAG = 'wiki_repair_enabled';

/** Settings row: the last run as JSON (lib/wiki-repair/state.ts). Never in backups. */
export const WIKI_REPAIR_STATE_KEY = 'wiki_repair_state';

/** Name matches one run asks the AI about at most; the rest wait for the next run. */
export const MAX_REPAIR_ALIASES = 200;

/** Name matches per AI call: nlp-service /resolve/disambiguate answers 10 per call. */
export const REPAIR_ALIAS_BATCH = 10;

/** Pages one run rebuilds at most; the rest wait for the next run. */
export const MAX_REPAIR_PAGES = 300;

/** Labels the one label call is shown (nlp-service routers/labels.py MAX_NEW_LABELS). */
export const MAX_REPAIR_LABELS = 100;

/** Stop once the run spends more than this × the high estimate it was confirmed with. */
export const REPAIR_MAX_OVERSPEND = 1.5;

/** Stop after this many pages in a row could not be rebuilt for a reason other than the page itself. */
export const REPAIR_MAX_CONSECUTIVE_FAILURES = 3;

/** Folder under the data volume (DATA_ROOT) the backup before each run is saved to. */
export const REPAIR_BACKUP_DIR = 'backups';

/** Backups before a repair kept on the data volume, newest first; older ones are deleted. */
export const REPAIR_BACKUPS_KEPT = 3;
