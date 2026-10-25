/**
 * How an extraction's entities, concepts and relationships become a source's
 * entity_mentions and relationship_mentions rows. The extract route writes
 * them through the stored pin (mention-pin.ts buildMentionPin); resolve
 * rebuilds a session's rows from the same extractions through its groups
 * (sessionMentionRows, written by db.ts rebuildSessionMentions).
 */

import { buildResolverPin, mentionKey, type ResolverGroup } from './mention-pin';
import { buildRelationRows, type RelationRow } from './relation-rows';

export interface EntityMentionRow {
  canonical_name: string;
  source_id: string;
  entity_type: string | null;
}

export interface SourceMentionRows {
  source_id: string;
  entities: EntityMentionRow[];
  relations: RelationRow[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const list = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object') : [];

/**
 * One source's rows. `pin(name, kind)` gives a name's canonical; kind is the
 * entity's type, 'CONCEPT' for a concept, and absent for a relation end.
 * Entities come before concepts, and one row per canonical: the first keeps
 * its type. A relation end takes the canonical the source's own entity or
 * concept of that name got, so both ends of a row name the rows' entities;
 * relation rows are built by buildRelationRows (type spelling, sorted
 * competes_with / contradicts, one row per (from, to, type)).
 */
export function buildSourceMentionRows(
  llmOutput: unknown,
  sourceId: string,
  pin: (name: string, kind?: string) => string
): SourceMentionRows {
  const llm = (llmOutput && typeof llmOutput === 'object' ? llmOutput : {}) as Record<string, unknown>;
  const entities: EntityMentionRow[] = [];
  const seen = new Set<string>();
  const named = new Map<string, string>(); // a listed name -> the canonical it got first
  const add = (name: string, kind: string, entityType: string | null) => {
    if (!name) return;
    const canonical = pin(name, kind);
    if (!named.has(mentionKey(name))) named.set(mentionKey(name), canonical);
    if (seen.has(canonical.toLowerCase())) return;
    seen.add(canonical.toLowerCase());
    entities.push({ canonical_name: canonical, source_id: sourceId, entity_type: entityType });
  };
  for (const ent of list(llm.entities)) add(text(ent.name), text(ent.type), text(ent.type) || null);
  for (const con of list(llm.concepts)) add(text(con.name), 'CONCEPT', 'CONCEPT');
  const kinds = new Map<string, string>();
  for (const ent of list(llm.entities)) if (text(ent.name)) kinds.set(mentionKey(text(ent.name)), text(ent.type).toUpperCase());
  for (const con of list(llm.concepts)) {
    if (text(con.name) && !kinds.has(mentionKey(text(con.name)))) kinds.set(mentionKey(text(con.name)), 'CONCEPT');
  }
  const relations = buildRelationRows(
    llm.relationships,
    sourceId,
    (name) => named.get(mentionKey(name)) ?? pin(name),
    (name) => kinds.get(mentionKey(name)),
  );
  return { source_id: sourceId, entities, relations };
}

/**
 * The rows of each session source after resolve, from its extraction and the
 * resolver's groups (buildResolverPin; `fallback` pins the names no group
 * holds). An extraction whose llm_output does not parse is left out, so its
 * rows stay as they are.
 */
export function sessionMentionRows(
  extractions: Array<{ source_id: string; llm_output: string }>,
  groups: ResolverGroup[],
  fallback: (name: string) => string
): SourceMentionRows[] {
  const pinFor = buildResolverPin(groups, fallback);
  return extractions.flatMap((ext) => {
    let llm: unknown;
    try {
      llm = JSON.parse(ext.llm_output);
    } catch {
      return [];
    }
    return [buildSourceMentionRows(llm, ext.source_id, pinFor(ext.source_id))];
  });
}
