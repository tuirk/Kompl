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

/**
 * The types a comparison page ("A vs B") is about. Plan Rule 4 counts them
 * together toward its source threshold; the draft's comparison dossier
 * reads both.
 */
export const COMPARISON_RELATIONS: ReadonlySet<string> = new Set(['competes_with', 'contradicts']);

/** Longest description kept; the extract prompt asks for one sentence. */
export const RELATION_DESCRIPTION_MAX_CHARS = 300;

/** Longest quote kept; a longer one keeps its start and ends in "…". */
export const RELATION_QUOTE_MAX_CHARS = 500;

/** The types the extract prompt lists (nlp-service llm_client.py). */
const PROMPT_RELATIONS: ReadonlySet<string> = new Set([
  'uses', 'competes_with', 'part_of', 'created_by', 'related_to', 'contradicts',
]);

/**
 * Other wordings of the prompt types, after the folding in
 * normalizeRelationType. Inverse wordings (used_by, includes) are left out:
 * mapping them would flip the relation's direction.
 */
const RELATION_SYNONYMS: ReadonlyMap<string, string> = new Map([
  ['use', 'uses'], ['utilize', 'uses'], ['utilizes', 'uses'], ['utilises', 'uses'],
  ['partof', 'part_of'], ['is_part_of', 'part_of'], ['component_of', 'part_of'],
  ['createdby', 'created_by'], ['is_created_by', 'created_by'], ['made_by', 'created_by'],
  ['competeswith', 'competes_with'], ['competes', 'competes_with'], ['competes_against', 'competes_with'],
  ['competitor', 'competes_with'], ['competitor_of', 'competes_with'],
  ['contradict', 'contradicts'], ['contradicted_by', 'contradicts'], ['conflicts_with', 'contradicts'],
  ['related', 'related_to'], ['relatedto', 'related_to'], ['relates_to', 'related_to'], ['is_related_to', 'related_to'],
]);

/**
 * A prompt type however the LLM spelled it ("Competes with", "PART-OF",
 * "utilizes"); the LLM's JSON mode does not enforce the type list. Any other
 * type is kept as written (trimmed), and relation-labels.ts reads it as before.
 */
export function normalizeRelationType(type: string): string {
  const written = type.trim();
  const folded = written.toLowerCase().replace(/[\s_-]+/g, '_');
  if (PROMPT_RELATIONS.has(folded)) return folded;
  return RELATION_SYNONYMS.get(folded) ?? written;
}

/**
 * The source's sentence for a relation (plan 3.2, extractions from v30 on):
 * `quote` as the extraction stored it, and `quote_verified` from the
 * nlp-service soft check (true: found in the source, and the quote is then
 * the source's own text; false: not found; null: no quote, or an extraction
 * made before quotes). Only a verified quote is ever shown as quoted.
 */
export interface RelationQuote {
  quote: string | null;
  quote_verified: boolean | null;
}

export interface RelationRow extends RelationQuote {
  from_canonical: string;
  to_canonical: string;
  relationship_type: string;
  source_id: string;
  description: string | null;
}

/** One usable entry of `llm_output.relationships`, names as the LLM wrote them. */
export interface LlmRelation extends RelationQuote {
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

/**
 * An entry's quote and its check, as stored: the quote trimmed and clipped
 * (empty or not a string -> null), and quote_verified only true or false
 * when there is a quote (anything else -> null).
 */
export function cleanRelationQuote(quote: unknown, verified: unknown): RelationQuote {
  if (typeof quote !== 'string' || !quote.trim()) return { quote: null, quote_verified: null };
  const text = quote.trim();
  return {
    quote:
      text.length > RELATION_QUOTE_MAX_CHARS ? `${text.slice(0, RELATION_QUOTE_MAX_CHARS - 1).trimEnd()}…` : text,
    quote_verified: typeof verified === 'boolean' ? verified : null,
  };
}

/** quote_verified as SQLite stores it: 1, 0 or NULL. */
export function quoteVerifiedColumn(verified: boolean | null | undefined): number | null {
  return verified === true ? 1 : verified === false ? 0 : null;
}

/** The stored quote_verified column read back. */
export function quoteVerifiedFromColumn(value: number | null | undefined): boolean | null {
  return value === 1 ? true : value === 0 ? false : null;
}

/**
 * A created_by whose from is a person and whose to is not: the maker was
 * written first ("Saul Bass" created_by "The Man with the Golden Arm", one
 * source, film run 2026-10-25, with the quote "Bass ... after creating the
 * title sequence for ... The Man with the Golden Arm"). A person is never
 * made by a film, a product or an idea, so the row is turned.
 */
export function makerFirst(
  type: string,
  from: string,
  to: string,
  kindOf: (name: string) => string | undefined,
): boolean {
  if (type !== 'created_by') return false;
  const [a, b] = [kindOf(from), kindOf(to)];
  return a === 'PERSON' && b !== undefined && b !== 'PERSON';
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
    out.push({
      from,
      to,
      type,
      description: cleanRelationDescription(r.description),
      ...cleanRelationQuote(r.quote, r.quote_verified),
    });
  }
  return out;
}

/**
 * Rows for one source's `llm_output.relationships`. `pin` maps a raw name to
 * its canonical spelling (the aliases table); a prompt type is stored in its
 * canonical spelling (normalizeRelationType). One row per (from, to, type):
 * the first entry wins, and a later duplicate only supplies the description
 * when the first had none, and its quote when the first had none or only an
 * unverified one and the later one is verified.
 *
 * The description backfill reads llm_output with readLlmRelations alone, so
 * it still finds older rows under the type as the LLM wrote it.
 *
 * `kindOf` gives a name's kind in this source (its entity type, 'CONCEPT'
 * for a concept); with it a created_by written the wrong way round is
 * turned (makerFirst).
 */
export function buildRelationRows(
  relationships: unknown,
  sourceId: string,
  pin: (name: string) => string,
  kindOf: (name: string) => string | undefined = () => undefined,
): RelationRow[] {
  const rows = new Map<string, RelationRow>();
  for (const rel of readLlmRelations(relationships)) {
    const type = normalizeRelationType(rel.type);
    const [first, second] = makerFirst(type, rel.from, rel.to, kindOf) ? [rel.to, rel.from] : [rel.from, rel.to];
    const [from, to] = orderRelationPair(type, pin(first), pin(second));
    const key = relationKey(from, to, type);
    const seen = rows.get(key);
    if (seen) {
      seen.description ??= rel.description;
      if (rel.quote !== null && (seen.quote === null || (seen.quote_verified !== true && rel.quote_verified === true))) {
        seen.quote = rel.quote;
        seen.quote_verified = rel.quote_verified;
      }
      continue;
    }
    rows.set(key, {
      from_canonical: from,
      to_canonical: to,
      relationship_type: type,
      source_id: sourceId,
      description: rel.description,
      quote: rel.quote,
      quote_verified: rel.quote_verified,
    });
  }
  return [...rows.values()];
}
