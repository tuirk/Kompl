/**
 * Keeps competes_with / contradicts rows (DIRECTION_AGNOSTIC_RELATIONS) in the
 * sorted from/to order the extract route writes them in (relation-rows.ts).
 * Renaming one end afterwards (normalizeSessionMentionsToCanonical in db.ts)
 * can leave a row out of order, and plan Rule 4 then misses its source: it
 * counts with an exact sorted match (countSourcesForRelationship).
 */

import type Database from 'better-sqlite3';
import { DIRECTION_AGNOSTIC_RELATIONS, orderRelationPair } from './relation-rows';

/**
 * Swap from/to on the direction-agnostic rows of `sourceIds` that are out of
 * order. When the swapped row lands on a row its source already has,
 * UPDATE OR REPLACE keeps the swapped row and drops the other; a swapped row
 * without a description takes the other row's first, as the rename does.
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
  const twinDescription = db.prepare(
    `SELECT description FROM relationship_mentions
      WHERE source_id = ? AND relationship_type = ? AND from_canonical = ? AND to_canonical = ?
        AND rowid != ? AND description IS NOT NULL`
  );
  const swap = db.prepare(
    `UPDATE OR REPLACE relationship_mentions
        SET from_canonical = ?, to_canonical = ?, description = COALESCE(description, ?)
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
      const twin = twinDescription.get(row.source_id, row.relationship_type, from, to, row.rid) as
        | { description: string }
        | undefined;
      swapped += swap.run(from, to, twin?.description ?? null, row.rid).changes;
    }
  })();
  return swapped;
}
