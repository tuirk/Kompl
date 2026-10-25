/**
 * Whether the wiki is empty in the sense a backup restore needs: no page a
 * person compiled. Import (POST /api/import) refuses otherwise, and
 * onboarding offers the restore link only while this is 0.
 */

import { getDb } from './db';

/**
 * System-generated pages that don't count as "user data". The Saved Links
 * overview page is rebuilt any time an ingest fails; it must not block a
 * fresh import into an otherwise-empty wiki.
 */
export const SYSTEM_PAGE_IDS = ['saved-links'] as const;

/** Pages other than the system pages. */
export function countUserPages(): number {
  const placeholders = SYSTEM_PAGE_IDS.map(() => '?').join(', ');
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM pages WHERE page_id NOT IN (${placeholders})`)
    .get(...SYSTEM_PAGE_IDS) as { n: number };
  return row.n;
}
