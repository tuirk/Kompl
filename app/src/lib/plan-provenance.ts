/**
 * Which sources a committed draft credits, recorded once per page
 * (plan 2.1; audit B4 and B11).
 *
 * The draft records the sources its prompt carried, as text or as
 * pre-extracted data (page_plans.used_source_ids, v30): the prompt budget
 * can leave some out, and those did not contribute. A page gets one
 * 'created' or 'updated' row per source: an update does not add rows for
 * sources that already contributed to the page, so the table no longer grows
 * with every update. A 'mentioned' row (a link recorded without rewriting
 * the page) does not count as contributing.
 *
 * Both functions are synchronous DB work for the commit transaction
 * (CLAUDE.md rule 5): compile/commit/route.ts and lib/approve-plan.ts.
 */

import type Database from 'better-sqlite3';

import { insertProvenance } from './db';

/**
 * The plan sources a draft used, in plan order. `usedSourceIdsJson` is
 * page_plans.used_source_ids: NULL for drafts made before it and for drafts
 * with no prompt (original-source pages, overviews), which credit every plan
 * source as before.
 */
export function contributingSourceIds(planSourceIds: string[], usedSourceIdsJson: string | null): string[] {
  if (usedSourceIdsJson === null) return planSourceIds;
  const used = new Set(JSON.parse(usedSourceIdsJson) as string[]);
  return planSourceIds.filter((id) => used.has(id));
}

export function getPlanUsedSourceIds(db: Database.Database, planId: string): string | null {
  const row = db.prepare('SELECT used_source_ids FROM page_plans WHERE plan_id = ?').get(planId) as
    | { used_source_ids: string | null }
    | undefined;
  return row?.used_source_ids ?? null;
}

/**
 * Record `sourceIds` as contributors of the page, skipping sources that
 * already have a 'created' or 'updated' row on it, then set
 * pages.source_count from provenance (COUNT DISTINCT, every row type).
 * Returns the number of rows added.
 */
export function recordPageContributions(
  db: Database.Database,
  args: { page_id: string; source_ids: string[]; content_hash: string; contribution_type: 'created' | 'updated' },
): number {
  const hasRow = db.prepare(
    `SELECT 1 FROM provenance
      WHERE page_id = ? AND source_id = ? AND contribution_type IN ('created', 'updated')
      LIMIT 1`,
  );
  let added = 0;
  for (const source_id of new Set(args.source_ids)) {
    if (hasRow.get(args.page_id, source_id)) continue;
    insertProvenance({
      source_id,
      page_id: args.page_id,
      content_hash: args.content_hash,
      contribution_type: args.contribution_type,
    });
    added++;
  }
  db.prepare(
    `UPDATE pages SET source_count = (
       SELECT COUNT(DISTINCT source_id) FROM provenance WHERE page_id = ?
     ) WHERE page_id = ?`,
  ).run(args.page_id, args.page_id);
  return added;
}
