/**
 * Page-type taxonomy palette. Single source of truth for every wiki UI that
 * colors a dot, badge, stripe, or node by page_type.
 *
 * PAGE_TYPE_VAR — CSS-var values for DOM consumers.
 * PAGE_TYPE_HEX — raw hex for canvas consumers (graph cannot read CSS vars).
 * The two must stay in sync — hex mirrors the var values declared in globals.css.
 *
 * Palette is intentionally disjoint from the app's semantic status tokens
 * (--accent / --success / --warning / --danger) so taxonomic dots never read
 * as status signals. source-summary reuses --fg-muted because it semantically
 * means "low-signal" — same intent as the muted-gray token family.
 */

export const PAGE_TYPE_VAR = {
  'source-summary': 'var(--fg-muted)',
  concept:          'var(--page-concept)',
  entity:           'var(--page-entity)',
  comparison:       'var(--page-comparison)',
  overview:         'var(--page-overview)',
} as const;

export const PAGE_TYPE_HEX = {
  'source-summary': '#a1a1aa',
  concept:          '#5b8def',
  entity:           '#8b5cf6',
  comparison:       '#d97757',
  overview:         '#5eaaa8',
} as const;

export type PageType = keyof typeof PAGE_TYPE_VAR;

export const PAGE_TYPE_LABELS: Record<PageType, string> = {
  'source-summary': 'source summary',
  concept:          'concept',
  entity:           'entity',
  comparison:       'comparison',
  overview:         'overview',
};

/** Archived is a state overlay, not a taxonomic type. Exported so any site
 *  that renders archived pages reuses one value instead of inlining --fg-dim. */
export const ARCHIVED_COLOR = 'var(--fg-dim)';
