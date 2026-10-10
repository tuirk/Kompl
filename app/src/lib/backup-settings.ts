/**
 * Which settings rows a .kompl backup carries. Export leaves the others out
 * and import skips them, so backups made by older versions that still carry
 * them can't restore them either.
 */

import { AGENT_ADD_SOURCES_KEY } from './db';
import { PAGE_UPGRADE_FLAG } from './page-upgrade-state';

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
]);

export function isBackedUpSetting(key: string): boolean {
  return !NOT_BACKED_UP.has(key);
}
