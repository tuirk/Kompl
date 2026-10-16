/**
 * Display rules for a page's connections card (app/wiki/[page_id]/
 * ConnectionsPanel.tsx): what the section counts, which rows show before
 * "Show all" and the small notes beside a row. Pure and free of DB imports
 * (relations.ts is imported for its types only), so the graph panels can
 * reuse it.
 */

import { relationLabel } from './relation-labels';
import type { ConnectionGroup, ConnectionItem, PageConnections } from './relations';

/** "Also linked" rows shown before "Show all", as the old "Linked from" list. */
export const ALSO_LINKED_VISIBLE = 8;
/** "Related to" is the weakest relation: rows past this sit behind "Show all". */
export const RELATED_VISIBLE = 3;

const RELATED_LABEL = relationLabel('related_to', 'out');

/** Rows the card lists: every connection plus every "Also linked" page. */
export function connectionsCount(connections: PageConnections): number {
  return connections.groups.reduce((n, g) => n + g.items.length, 0) + connections.linked_only.length;
}

/** Rows of a group shown before "Show all": the first few of "Related to", all of any other. */
export function visibleRowCount(group: ConnectionGroup): number {
  return group.label === RELATED_LABEL ? RELATED_VISIBLE : group.items.length;
}

/** The rows shown at first and the rest, which go behind "Show all". */
export function splitRows<T>(rows: readonly T[], visible: number): { shown: T[]; rest: T[] } {
  return { shown: rows.slice(0, visible), rest: rows.slice(visible) };
}

/** "3 sources" beside a connection backed by more than one source; null for one. */
export function sourcesNote(item: Pick<ConnectionItem, 'source_count'>): string | null {
  return item.source_count > 1 ? `${item.source_count} sources` : null;
}

/** "+2 more sources" under the evidence when the read model kept fewer entries than sources. */
export function moreSourcesNote(item: Pick<ConnectionItem, 'source_count' | 'evidence'>): string | null {
  const more = item.source_count - item.evidence.length;
  if (more <= 0) return null;
  return `+${more} more source${more === 1 ? '' : 's'}`;
}
