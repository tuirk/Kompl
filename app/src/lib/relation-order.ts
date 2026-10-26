/**
 * Keeps competes_with / contradicts rows (DIRECTION_AGNOSTIC_RELATIONS) in the
 * sorted from/to order the extract route writes them in (relation-rows.ts).
 * Renaming one end afterwards in place can leave a row out of order, and plan
 * Rule 4 then misses its source: it counts with an exact sorted match
 * (countSourcesForRelationship). Resolve no longer renames in place: it
 * rebuilds the session's rows through buildRelationRows (db.ts
 * rebuildSessionMentions), so this is left for rows an older resolve renamed.
 */

import type Database from 'better-sqlite3';
import { DIRECTION_AGNOSTIC_RELATIONS, orderRelationPair } from './relation-rows';

/**
 * Swap from/to on the direction-agnostic rows of `sourceIds` that are out of
 * order. When the swapped row lands on a row its source already has,
 * UPDATE OR REPLACE keeps the swapped row and drops the other; a swapped row
 * without a description takes the other row's first, as the rename does, and
 * one without a quote takes the other row's quote with its check.
 *
 * Without `sourceIds` it covers every row: the one-time repair for rows
 * renamed before the rename re-sorted them. Nothing runs that at boot.
 * Returns the number of rows swapped.
 */
export function sortDirectionAgnosticRelations(db: Database.Database, sourceIds?: readonly string[]): number {
  const types = [...DIRECTION_AGNOSTIC_RELATIONS];
  const typeList = types.map(() => '?').join(', ');
  const select = `SELECT rowid AS rid, source_id, from_canonical, to_canonical, relationship_type
                    FROM relationship_mentions WHERE relationship_type IN (${typeList})`;
  const everyRow = db.prepare(select);
  const rowsOfSource = db.prepare(`${select} AND source_id = ?`);
  // from/to are COLLATE NOCASE, so this finds the row the swap collides with.
  const twinOf = db.prepare(
    `SELECT description, quote, quote_verified FROM relationship_mentions
      WHERE source_id = ? AND relationship_type = ? AND from_canonical = ? AND to_canonical = ?
        AND rowid != ?`
  );
  // SET expressions read the row's old values, so quote_verified follows
  // the quote that is kept.
  const swap = db.prepare(
    `UPDATE OR REPLACE relationship_mentions
        SET from_canonical = ?, to_canonical = ?, description = COALESCE(description, ?),
            quote_verified = CASE WHEN quote IS NULL THEN ? ELSE quote_verified END,
            quote = COALESCE(quote, ?)
      WHERE rowid = ?`
  );

  type Row = { rid: number; source_id: string; from_canonical: string; to_canonical: string; relationship_type: string };
  let swapped = 0;
  db.transaction(() => {
    const rows = (
      sourceIds === undefined
        ? everyRow.all(...types)
        : sourceIds.flatMap((id) => rowsOfSource.all(...types, id))
    ) as Row[];
    for (const row of rows) {
      const [from, to] = orderRelationPair(row.relationship_type, row.from_canonical, row.to_canonical);
      if (from === row.from_canonical && to === row.to_canonical) continue;
      const twin = twinOf.get(row.source_id, row.relationship_type, from, to, row.rid) as
        | { description: string | null; quote: string | null; quote_verified: number | null }
        | undefined;
      swapped += swap.run(
        from,
        to,
        twin?.description ?? null,
        twin?.quote ? twin.quote_verified : null,
        twin?.quote ?? null,
        row.rid
      ).changes;
    }
  })();
  return swapped;
}
