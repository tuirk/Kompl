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
/** Rows of a relation group shown before "Show all", so a hub page's card stays short. */
export const GROUP_VISIBLE = 8;
/** "Related to" is the weakest relation: rows past this sit behind "Show all". */
export const RELATED_VISIBLE = 3;

const RELATED_LABEL = relationLabel('related_to', 'out');

/**
 * The card's headline count: the pages (and names with no page) the page
 * has a typed relation with, each counted once however many relations join
 * them. "Also linked" pages are counted on their own (linked_only.length).
 */
export function connectionsCount(connections: PageConnections): number {
  const ends = new Set<string>();
  for (const g of connections.groups) {
    for (const i of g.items) ends.add(i.page_id ?? `name:${i.title.toLowerCase()}`);
  }
  return ends.size;
}

/**
 * What the headline count is made of, when some of it is names with no page
 * yet: "3 with a page · 12 with no page yet". The map draws only pages (and
 * missing pages named in enough sources), so this is why its focused view
 * can show fewer. Null when every connection has a page.
 */
export function connectionsBreakdown(connections: PageConnections): string | null {
  const pages = new Set<string>();
  const names = new Set<string>();
  for (const g of connections.groups) {
    for (const i of g.items) {
      if (i.page_id) pages.add(i.page_id);
      else names.add(i.title.toLowerCase());
    }
  }
  if (names.size === 0) return null;
  const noPage = `${names.size} with no page yet`;
  return pages.size === 0 ? noPage : `${pages.size} with a page · ${noPage}`;
}

/** True when the card has anything to list: a relation or an "Also linked" page. */
export function hasConnections(connections: PageConnections): boolean {
  return connections.groups.some((g) => g.items.length > 0) || connections.linked_only.length > 0;
}

/** Rows of a group shown before "Show all": the first 3 of "Related to", the first 8 of any other. */
export function visibleRowCount(group: ConnectionGroup): number {
  return group.label === RELATED_LABEL ? RELATED_VISIBLE : GROUP_VISIBLE;
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
