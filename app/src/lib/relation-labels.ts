/**
 * Labels for typed relations (relationship_mentions.relationship_type), read
 * from the current page's side: Bitcoin "Uses" proof-of-work, proof-of-work
 * is "Used by" Bitcoin. Shared by the connections read model (relations.ts),
 * the page's connections card and the graph, so no DB imports here.
 */

export type RelationDirection = 'out' | 'in';

/** [label when the page is `from`, label when the page is `to`] */
const KNOWN: Record<string, readonly [string, string]> = {
  part_of: ['Part of', 'Includes'],
  uses: ['Uses', 'Used by'],
  created_by: ['Created by', 'Created'],
  competes_with: ['Competes with', 'Competes with'],
  contradicts: ['Contradicts', 'Contradicts'],
  related_to: ['Related to', 'Related to'],
};

/** Display order of the known labels; other types sit before "Related to". */
const ORDER = [
  'Part of', 'Includes', 'Created by', 'Created', 'Uses', 'Used by',
  'Competes with', 'Contradicts',
];
const RELATED_TO = 'Related to';
/** Starts an unknown type's label read from its `to` end: it reads from the other page to this one. */
const REVERSED = '← ';

/**
 * Types that read the same from both ends; callers merge both directions of
 * such a relation into one. Every other type, unknown ones included, is
 * directional: the extractor stores it in its natural order.
 */
export const SYMMETRIC_RELATIONS: ReadonlySet<string> = new Set(['competes_with', 'contradicts', 'related_to']);

/** "influenced_by" -> "Influenced by": an unknown type read from its `from` end. */
function otherTypeLabel(type: string): string {
  const words = type.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : type;
}

/**
 * An unknown type read from its `to` end. "X by" types turn active, as
 * created_by's "Created by" / "Created" do ("Founded by" -> "Founded");
 * any other gets an arrow saying it reads from the other page
 * ("Located in" -> "← Located in").
 */
function otherTypeReverseLabel(type: string): string {
  const forward = otherTypeLabel(type);
  const active = forward.replace(/\s+by$/i, '');
  return active !== forward && active.length > 0 ? active : `${REVERSED}${forward}`;
}

export function relationLabel(type: string, direction: RelationDirection): string {
  const known = KNOWN[type];
  if (known) return direction === 'out' ? known[0] : known[1];
  // Every symmetric type is known, so an unknown type here is directional.
  if (direction === 'out') return otherTypeLabel(type);
  return otherTypeReverseLabel(type);
}

/** competes_with, contradicts and related_to (SYMMETRIC_RELATIONS); never an unknown type. */
export function isSymmetricRelation(type: string): boolean {
  return SYMMETRIC_RELATIONS.has(type);
}

/**
 * Sort key for labels: the vocabulary order, other labels A-Z ("← Located
 * in" right after "Located in"), "Related to" last.
 */
export function compareRelationLabels(a: string, b: string): number {
  const rank = (label: string): number => {
    if (label === RELATED_TO) return ORDER.length + 1;
    const i = ORDER.indexOf(label);
    return i === -1 ? ORDER.length : i;
  };
  const reversed = (label: string) => (label.startsWith(REVERSED) ? 1 : 0);
  const words = (label: string) => label.slice(reversed(label) * REVERSED.length);
  return rank(a) - rank(b) || words(a).localeCompare(words(b)) || reversed(a) - reversed(b);
}
