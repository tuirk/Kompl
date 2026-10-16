import type Database from 'better-sqlite3';
import { numericConflict } from './name-guard';
import { orderRelationPair, readLlmRelations, relationKey, type LlmRelation } from './relation-rows';

/**
 * Fill relationship_mentions.description (schema v28) for rows written
 * before the extract route stored it. The sentence is still in each source's
 * extractions.llm_output, so no LLM call is needed.
 *
 * Each LLM relation is looked up under the names its row could carry: each
 * end pinned through the aliases table as the extract route pins it today,
 * through every alias row (older extractions also used aliases that
 * getAliases() now leaves out, e.g. "Python" -> "Python 2"), or as the LLM
 * wrote it (a row keeps its spelling when an alias is added later), ordered
 * as the extract route orders them (relation-rows.ts). Then, within one
 * source and type, when exactly one row and one LLM relation are left
 * unmatched, they are paired.
 *
 * Only rows whose description IS NULL are written, so a rerun changes
 * nothing and a stored sentence is never replaced. Malformed llm_output is
 * skipped. Runs once at boot (instrumentation.ts) and after a backup import.
 * Returns the rows filled by this run and the rows still without a
 * description.
 */
export function backfillRelationDescriptions(db: Database.Database): { filled: number; unmatched: number } {
  const aliasRows = db
    .prepare('SELECT alias, canonical_name FROM aliases WHERE canonical_name IS NOT NULL ORDER BY id')
    .all() as Array<{ alias: string; canonical_name: string }>;
  // The same rows getAliases() returns: those whose names carry the same numbers.
  const current = aliasLookup(aliasRows.filter((a) => numericConflict(a.alias, a.canonical_name) === null));
  const historical = aliasLookup(aliasRows);
  const spellings = (name: string): string[] => [...new Set([current(name), historical(name), name])];
  const candidates = (rel: LlmRelation): Array<[string, string]> => {
    const pairs = new Map<string, [string, string]>();
    for (const from of spellings(rel.from)) {
      for (const to of spellings(rel.to)) {
        const pair = orderRelationPair(rel.type, from, to);
        const key = relationKey(pair[0], pair[1], rel.type);
        if (!pairs.has(key)) pairs.set(key, pair);
      }
    }
    return [...pairs.values()];
  };

  const extractions = db
    .prepare('SELECT source_id, llm_output FROM extractions')
    .all() as Array<{ source_id: string; llm_output: string | null }>;
  const findRow = db.prepare(
    `SELECT rowid AS rid FROM relationship_mentions
      WHERE source_id = ? AND from_canonical = ? COLLATE NOCASE
        AND to_canonical = ? COLLATE NOCASE AND relationship_type = ?`
  );
  const rowsOfSource = db.prepare(
    `SELECT rowid AS rid, relationship_type, description
       FROM relationship_mentions WHERE source_id = ?`
  );
  const fill = db.prepare(
    `UPDATE relationship_mentions SET description = ? WHERE rowid = ? AND description IS NULL`
  );

  let filled = 0;
  db.transaction(() => {
    for (const { source_id, llm_output } of extractions) {
      const relations = parseRelations(llm_output);
      if (relations === null) continue;

      const matched = new Set<number>();
      // type -> unmatched relations (key of the first candidate -> description)
      const leftover = new Map<string, Map<string, string | null>>();
      for (const rel of relations) {
        const pairs = candidates(rel);
        let rid: number | undefined;
        for (const [from, to] of pairs) {
          rid = (findRow.get(source_id, from, to, rel.type) as { rid: number } | undefined)?.rid;
          if (rid !== undefined) break;
        }
        if (rid === undefined) {
          const byKey = leftover.get(rel.type) ?? new Map<string, string | null>();
          const key = relationKey(pairs[0][0], pairs[0][1], rel.type);
          byKey.set(key, byKey.get(key) ?? rel.description);
          leftover.set(rel.type, byKey);
          continue;
        }
        matched.add(rid);
        if (rel.description !== null) filled += fill.run(rel.description, rid).changes;
      }

      // Pair the last unmatched relation with the last unmatched row of its type.
      if (leftover.size === 0) continue;
      const rows = rowsOfSource.all(source_id) as Array<{ rid: number; relationship_type: string; description: string | null }>;
      for (const [type, byKey] of leftover) {
        const descriptions = [...byKey.values()];
        if (descriptions.length !== 1 || descriptions[0] === null) continue;
        const open = rows.filter((r) => r.relationship_type === type && !matched.has(r.rid));
        if (open.length === 1 && open[0].description === null) {
          filled += fill.run(descriptions[0], open[0].rid).changes;
        }
      }
    }
  })();

  const unmatched = (
    db.prepare('SELECT COUNT(*) AS n FROM relationship_mentions WHERE description IS NULL').get() as { n: number }
  ).n;
  return { filled, unmatched };
}

/** alias -> canonical lookup, case-insensitive; the newest row for an alias wins. */
function aliasLookup(rows: Array<{ alias: string; canonical_name: string }>): (name: string) => string {
  const map = new Map<string, string>();
  for (const { alias, canonical_name } of rows) map.set(alias.toLowerCase(), canonical_name);
  return (name) => map.get(name.toLowerCase()) ?? name;
}

/** The extraction's relationships; null when llm_output is not a JSON object. */
function parseRelations(llmOutput: string | null): LlmRelation[] | null {
  if (!llmOutput) return null;
  try {
    const parsed: unknown = JSON.parse(llmOutput);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return readLlmRelations((parsed as { relationships?: unknown }).relationships);
  } catch {
    return null;
  }
}
