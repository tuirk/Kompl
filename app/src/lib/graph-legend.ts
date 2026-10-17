/**
 * The graph legend's logic, kept pure so it can be tested without a browser:
 *  - which filter rows it offers (topic groups, page types);
 *  - how many rows differ from the default map (the "Filters" button's badge);
 *  - when the "How to read the map" popover is open (hover, focus, click/tap,
 *    Escape, a click outside);
 *  - where that popover goes so it stays inside the canvas.
 */

import { DEFAULT_FILTERS, type GraphFilters, type GraphModel } from './graph-model';
import { UNCATEGORIZED } from './graph-layout';
import { NEUTRAL_HEX } from './graph-palette';

/** One topic row: a named topic, the overflow topics together, or the uncategorized pages. */
export interface CategoryGroup {
  key: string;
  label: string;
  color: string;
  names: string[];
}

export function legendCategoryGroups(model: GraphModel): CategoryGroup[] {
  const groups: CategoryGroup[] = model.categories
    .filter((c) => !c.overflow && c.name !== UNCATEGORIZED)
    .map((c) => ({ key: c.name, label: c.name, color: c.color, names: [c.name] }));
  const overflow = model.categories.filter((c) => c.overflow).map((c) => c.name);
  if (overflow.length > 0) groups.push({ key: 'other', label: `Other topics (${overflow.length})`, color: NEUTRAL_HEX, names: overflow });
  if (model.categories.some((c) => c.name === UNCATEGORIZED)) {
    groups.push({ key: UNCATEGORIZED, label: UNCATEGORIZED, color: NEUTRAL_HEX, names: [UNCATEGORIZED] });
  }
  return groups;
}

/** Page types offered as filters, in this order; source pages have their own row. */
const TYPE_ORDER = ['entity', 'concept', 'overview', 'comparison'];

export function legendPageTypes(model: GraphModel): string[] {
  const present = new Set(model.nodes.filter((n) => !n.isSource).map((n) => n.pageType));
  return [...TYPE_ORDER.filter((t) => present.has(t)), ...[...present].filter((t) => !TYPE_ORDER.includes(t)).sort()];
}

/** The filter states that live outside GraphFilters. */
export interface LegendExtras {
  includeArchived: boolean;
  showMissing: boolean;
  /** The "Missing pages" row is offered only when there are some. */
  missingCount: number;
}

/**
 * How many of the legend's rows differ from the default map: each row whose
 * checkbox is not as it starts (a topic or page type unchecked; source
 * pages, missing pages, archived pages or either line kind checked).
 */
export function changedFilters(model: GraphModel, filters: GraphFilters, extras: LegendExtras): number {
  const topics = legendCategoryGroups(model).filter((g) => g.names.every((n) => filters.hiddenCategories.has(n))).length;
  const types = legendPageTypes(model).filter((t) => filters.hiddenTypes.has(t)).length;
  const flags = [
    filters.showSources !== DEFAULT_FILTERS.showSources,
    filters.showRelated !== DEFAULT_FILTERS.showRelated,
    filters.showPlain !== DEFAULT_FILTERS.showPlain,
    extras.includeArchived,
    extras.showMissing && extras.missingCount > 0,
  ].filter(Boolean).length;
  return topics + types + flags;
}

/** The badge on the "Filters" button: the state, in words ("3 changed"); empty on the default map. */
export function filtersBadge(changed: number): string {
  return changed > 0 ? `${changed} changed` : '';
}

/**
 * The "How to read the map" popover. Open while the pointer is over the ⓘ
 * button or the popover, while the button has focus, or once pinned by a
 * click or tap (a second click unpins and closes). Escape and a click
 * outside close it whatever opened it.
 */
export interface KeyPopoverState {
  hover: boolean;
  focus: boolean;
  pinned: boolean;
}

export type KeyPopoverEvent = 'enter' | 'leave' | 'focus' | 'blur' | 'click' | 'escape' | 'outside';

export const KEY_POPOVER_CLOSED: KeyPopoverState = { hover: false, focus: false, pinned: false };

export function keyPopover(state: KeyPopoverState, event: KeyPopoverEvent): KeyPopoverState {
  switch (event) {
    case 'enter': return { ...state, hover: true };
    case 'leave': return { ...state, hover: false };
    case 'focus': return { ...state, focus: true };
    case 'blur': return { ...state, focus: false };
    case 'click': return state.pinned ? KEY_POPOVER_CLOSED : { ...state, pinned: true };
    case 'escape':
    case 'outside':
      return KEY_POPOVER_CLOSED;
  }
}

export function isKeyPopoverOpen(state: KeyPopoverState): boolean {
  return state.hover || state.focus || state.pinned;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PopoverPlace {
  left: number;
  top: number;
  /** Taller content scrolls inside the popover. */
  maxHeight: number;
  side: 'below' | 'right';
}

/**
 * Where the popover goes, in the canvas's coordinates: below its button
 * when it fits there, otherwise beside it on the right, as high as fits;
 * always inside the canvas with a margin, and never taller than the canvas.
 */
export function placePopover(anchor: Box, popover: { width: number; height: number }, canvas: { width: number; height: number }, gap = 6, margin = 8): PopoverPlace {
  const maxHeight = Math.max(80, canvas.height - 2 * margin);
  const height = Math.min(popover.height, maxHeight);
  const clampX = (x: number) => Math.min(Math.max(x, margin), Math.max(margin, canvas.width - popover.width - margin));
  const clampY = (y: number) => Math.min(Math.max(y, margin), Math.max(margin, canvas.height - height - margin));
  const below = anchor.top + anchor.height + gap;
  if (below + height <= canvas.height - margin) return { left: clampX(anchor.left), top: below, maxHeight, side: 'below' };
  return { left: clampX(anchor.left + anchor.width + gap), top: clampY(anchor.top), maxHeight, side: 'right' };
}
