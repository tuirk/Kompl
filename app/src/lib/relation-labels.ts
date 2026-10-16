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

/** "influenced_by" -> "Influenced by"; the same label in both directions. */
function otherTypeLabel(type: string): string {
  const words = type.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : type;
}

export function relationLabel(type: string, direction: RelationDirection): string {
  const known = KNOWN[type];
  if (known) return direction === 'out' ? known[0] : known[1];
  return otherTypeLabel(type);
}

/**
 * True when the label reads the same from both ends (competes_with,
 * contradicts, related_to and unknown types). Callers merge both directions
 * of such a relation into one item.
 */
export function isSymmetricRelation(type: string): boolean {
  return relationLabel(type, 'out') === relationLabel(type, 'in');
}

/** Sort key for labels: the vocabulary order, other labels A-Z, "Related to" last. */
export function compareRelationLabels(a: string, b: string): number {
  const rank = (label: string): number => {
    if (label === RELATED_TO) return ORDER.length + 1;
    const i = ORDER.indexOf(label);
    return i === -1 ? ORDER.length : i;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}
