/**
 * Entity or concept: a page's kind by majority (owner decision D6).
 *
 * Sources disagree on kind: "APCA" is a PRODUCT in one source and a CONCEPT
 * in the next. A new page takes the kind most of its sources give. An
 * existing page changes kind only when the other kind has at least two
 * thirds of its sources and at least KIND_FLIP_MIN_SOURCES of them, so one
 * or two sources never flip it back and forth between re-drafts (2026-10-17,
 * session e55c740b: "APCA" entity → concept, "WCAG 2.1" concept → entity).
 * Each source counts once.
 *
 * Pure: plan/route.ts reads the mentions and applies the result.
 */

export type PageKind = 'entity' | 'concept';

/** Fewest sources of the other kind that can change an existing page's kind. */
export const KIND_FLIP_MIN_SOURCES = 3;

export interface KindCounts {
  entity: number;
  concept: number;
}

export function isPageKind(pageType: string): pageType is PageKind {
  return pageType === 'entity' || pageType === 'concept';
}

/** The kind a stored mention gives (entity_mentions.entity_type; 'CONCEPT' for concepts). */
export function mentionKind(entityType: string | null): PageKind {
  return (entityType ?? '').trim().toUpperCase() === 'CONCEPT' ? 'concept' : 'entity';
}

/**
 * The kind each source gives a subject. A source's stored mention wins: it
 * is the source's own extraction, while a resolver group carries one type
 * for every name it merged. A source of this session whose mention is not
 * stored under the subject's name (a variant spelling the resolver folded
 * in) counts by the resolver bucket that holds it.
 */
export function sourceKinds(
  stored: ReadonlyArray<{ source_id: string; entity_type: string | null }>,
  session: ReadonlyMap<string, PageKind>,
): Map<string, PageKind> {
  const kinds = new Map(session);
  for (const m of stored) kinds.set(m.source_id, mentionKind(m.entity_type));
  return kinds;
}

export function countKinds(kinds: Iterable<PageKind>): KindCounts {
  const counts: KindCounts = { entity: 0, concept: 0 };
  for (const k of kinds) counts[k]++;
  return counts;
}

/** `current` is the existing page's kind, or null for a new page. A tie stays an entity. */
export function decidePageKind(current: PageKind | null, counts: KindCounts): PageKind {
  if (current === null) return counts.concept > counts.entity ? 'concept' : 'entity';
  const other: PageKind = current === 'entity' ? 'concept' : 'entity';
  const n = counts[other];
  const total = counts.entity + counts.concept;
  return n >= KIND_FLIP_MIN_SOURCES && 3 * n >= 2 * total ? other : current;
}
