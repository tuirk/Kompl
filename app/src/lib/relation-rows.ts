/**
 * How an extraction's relationships become relationship_mentions rows.
 * Shared by /api/compile/extract (new extractions) and the description
 * backfill (relation-backfill.ts), so both pin and order names the same way.
 */

/**
 * Types stored with from/to sorted lowercase, so "A vs B" and "B vs A" share
 * one row (and one primary key). Directional types keep their natural order.
 */
export const DIRECTION_AGNOSTIC_RELATIONS: ReadonlySet<string> = new Set(['competes_with', 'contradicts']);

/** Longest description kept; the extract prompt asks for one sentence. */
export const RELATION_DESCRIPTION_MAX_CHARS = 300;

export interface RelationRow {
  from_canonical: string;
  to_canonical: string;
  relationship_type: string;
  source_id: string;
  description: string | null;
}

/** One usable entry of `llm_output.relationships`, names as the LLM wrote them. */
export interface LlmRelation {
  from: string;
  to: string;
  type: string;
  description: string | null;
}

/** The LLM's description, trimmed and clipped; empty or not a string -> null. */
export function cleanRelationDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > RELATION_DESCRIPTION_MAX_CHARS
    ? text.slice(0, RELATION_DESCRIPTION_MAX_CHARS).trimEnd()
    : text;
}

/** from/to in stored order: sorted lowercase for direction-agnostic types. */
export function orderRelationPair(type: string, from: string, to: string): [string, string] {
  if (DIRECTION_AGNOSTIC_RELATIONS.has(type) && from.toLowerCase() > to.toLowerCase()) {
    return [to, from];
  }
  return [from, to];
}

/**
 * Identity of a row within one source, compared like the table's primary key
 * (from/to are COLLATE NOCASE, which folds ASCII letters only).
 */
export function relationKey(from: string, to: string, type: string): string {
  const nocase = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return `${nocase(from)}\u0000${nocase(to)}\u0000${type}`;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Entries with both names and a type; anything else (or a non-array) is skipped. */
export function readLlmRelations(relationships: unknown): LlmRelation[] {
  if (!Array.isArray(relationships)) return [];
  const out: LlmRelation[] = [];
  for (const rel of relationships as unknown[]) {
    if (!rel || typeof rel !== 'object') continue;
    const r = rel as Record<string, unknown>;
    const from = text(r.from_entity);
    const to = text(r.to);
    const type = text(r.type);
    if (!from || !to || !type) continue;
    out.push({ from, to, type, description: cleanRelationDescription(r.description) });
  }
  return out;
}

/**
 * Rows for one source's `llm_output.relationships`. `pin` maps a raw name to
 * its canonical spelling (the aliases table). One row per (from, to, type):
 * the first entry wins, and a later duplicate only supplies the description
 * when the first had none.
 */
export function buildRelationRows(
  relationships: unknown,
  sourceId: string,
  pin: (name: string) => string
): RelationRow[] {
  const rows = new Map<string, RelationRow>();
  for (const rel of readLlmRelations(relationships)) {
    const [from, to] = orderRelationPair(rel.type, pin(rel.from), pin(rel.to));
    const key = relationKey(from, to, rel.type);
    const seen = rows.get(key);
    if (seen) {
      seen.description ??= rel.description;
      continue;
    }
    rows.set(key, {
      from_canonical: from,
      to_canonical: to,
      relationship_type: rel.type,
      source_id: sourceId,
      description: rel.description,
    });
  }
  return [...rows.values()];
}
