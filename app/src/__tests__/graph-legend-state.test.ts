/**
 * The graph legend's pure logic (lib/graph-legend.ts): the "Filters"
 * badge's count, when the "How to read the map" popover opens and closes
 * (hover, focus, click/tap, Escape, a click outside), how its Escape comes
 * before the details panel's, and where the popover goes on the canvas.
 */

import { describe, expect, it } from 'vitest';
import { closesPanelOnEscape } from '../lib/graph-focus';
import {
  changedFilters, filtersBadge, isKeyPopoverOpen, KEY_POPOVER_CLOSED, keyPopover, legendCategoryGroups, placePopover,
  type KeyPopoverEvent, type KeyPopoverState,
} from '../lib/graph-legend';
import { buildGraphModel, DEFAULT_FILTERS } from '../lib/graph-model';
import type { WikiGraph, WikiGraphNode } from '../lib/wiki-graph';

const page = (id: string, category: string, group = 'entity'): WikiGraphNode =>
  ({ id, label: id, group, category, source_count: 1, summary: null, last_updated: null, degree: 0 });
const DATA: WikiGraph = {
  nodes: [page('a', 'Travel'), page('b', 'Travel', 'concept'), page('c', 'Crypto', 'overview'), page('s', 'Crypto', 'source-summary')],
  links: [],
  missing: [],
};
const model = buildGraphModel(DATA);
const NONE = { includeArchived: false, showMissing: false, missingCount: 0 };

describe('the "Filters" badge', () => {
  it('counts nothing on the default map, and says nothing', () => {
    expect(changedFilters(model, DEFAULT_FILTERS, NONE)).toBe(0);
    expect(filtersBadge(0)).toBe('');
  });

  it('counts each row whose checkbox differs from the default map', () => {
    const f = { ...DEFAULT_FILTERS, hiddenCategories: new Set(['Travel']), hiddenTypes: new Set(['concept']), showSources: true, showRelated: true, showPlain: true };
    expect(changedFilters(model, f, NONE)).toBe(5);
    expect(changedFilters(model, f, { includeArchived: true, showMissing: true, missingCount: 2 })).toBe(7);
    expect(filtersBadge(3)).toBe('3 changed');
    expect(filtersBadge(3)).not.toMatch(/show|hide/i);
  });

  it('ignores filters with no row: missing pages when there are none, types and topics not on the map', () => {
    expect(changedFilters(model, DEFAULT_FILTERS, { includeArchived: false, showMissing: true, missingCount: 0 })).toBe(0);
    const f = { ...DEFAULT_FILTERS, hiddenCategories: new Set(['Gone']), hiddenTypes: new Set(['comparison']) };
    expect(changedFilters(model, f, NONE)).toBe(0);
  });

  it('counts the overflow topics as their one row', () => {
    const many: WikiGraph = { nodes: Array.from({ length: 14 }, (_, i) => page(`p${i}`, `Topic ${i}`)), links: [], missing: [] };
    const big = buildGraphModel(many);
    const other = legendCategoryGroups(big).find((g) => g.key === 'other');
    expect(other?.names.length).toBeGreaterThan(1);
    const f = { ...DEFAULT_FILTERS, hiddenCategories: new Set(other?.names) };
    expect(changedFilters(big, f, NONE)).toBe(1);
  });
});

describe('the key popover: when it is open', () => {
  const run = (...events: KeyPopoverEvent[]): KeyPopoverState => events.reduce(keyPopover, KEY_POPOVER_CLOSED);

  it('opens on hover and stays open while the pointer is over the button or the popover', () => {
    expect(isKeyPopoverOpen(run())).toBe(false);
    expect(isKeyPopoverOpen(run('enter'))).toBe(true);
    // Button -> popover: the button's leave is followed by the popover's enter (the leave waits a moment).
    expect(isKeyPopoverOpen(run('enter', 'leave', 'enter'))).toBe(true);
    expect(isKeyPopoverOpen(run('enter', 'leave'))).toBe(false);
  });

  it('opens on keyboard focus and closes when focus leaves', () => {
    expect(isKeyPopoverOpen(run('focus'))).toBe(true);
    expect(isKeyPopoverOpen(run('focus', 'blur'))).toBe(false);
  });

  it('opens on click or tap and stays open until a second click, Escape or a click outside', () => {
    const pinned = run('click');
    expect(isKeyPopoverOpen(pinned)).toBe(true);
    expect(isKeyPopoverOpen(run('enter', 'click', 'leave'))).toBe(true); // clicked, then the pointer left
    expect(isKeyPopoverOpen(run('focus', 'click', 'blur'))).toBe(true);
    expect(isKeyPopoverOpen(run('click', 'click'))).toBe(false);
    // A tap: focus then click opens; a second tap closes.
    expect(isKeyPopoverOpen(run('focus', 'click'))).toBe(true);
    expect(isKeyPopoverOpen(run('focus', 'click', 'click'))).toBe(false);
  });

  it('closes on Escape and on a click outside, whatever opened it', () => {
    for (const opened of [['enter'], ['focus'], ['click'], ['enter', 'focus', 'click']] as KeyPopoverEvent[][]) {
      expect(run(...opened, 'escape')).toEqual(KEY_POPOVER_CLOSED);
      expect(run(...opened, 'outside')).toEqual(KEY_POPOVER_CLOSED);
    }
  });

  it('takes Escape before the details panel: once handled, the page leaves its panel open', () => {
    const event = { key: 'Escape', defaultPrevented: false, target: { tagName: 'BUTTON' } };
    // The popover listens first (capture) and handles the key...
    expect(closesPanelOnEscape(event)).toBe(true);
    event.defaultPrevented = true; // ...with preventDefault()
    // ...so the page's handler, which runs after it, keeps the panel.
    expect(closesPanelOnEscape(event)).toBe(false);
    // Typing in a field: neither closes.
    expect(closesPanelOnEscape({ key: 'Escape', defaultPrevented: false, target: { tagName: 'INPUT' } })).toBe(false);
  });
});

describe('the key popover: where it goes', () => {
  const canvas = { width: 1600, height: 870 };
  const info = { left: 100, top: 20, width: 26, height: 26 };
  const pop = { width: 284, height: 380 };

  it('sits below the ⓘ button when there is room', () => {
    expect(placePopover(info, pop, canvas)).toEqual({ left: 100, top: 52, maxHeight: 854, side: 'below' });
  });

  it('flips to the right of the button on a short canvas, as high as fits', () => {
    const at = placePopover(info, pop, { width: 1200, height: 400 });
    expect(at.side).toBe('right');
    expect(at.left).toBe(100 + 26 + 6);
    expect(at.top).toBe(12); // the button's top (20) moved up so all 380 px fit: 400 - 380 - 8
  });

  it('always stays inside the canvas', () => {
    const narrow = placePopover({ left: 250, top: 20, width: 26, height: 26 }, pop, { width: 400, height: 870 });
    expect(narrow.left + pop.width).toBeLessThanOrEqual(400 - 8);
    expect(narrow.left).toBeGreaterThanOrEqual(8);
    const tiny = placePopover(info, { width: 284, height: 900 }, { width: 600, height: 300 });
    expect(tiny.maxHeight).toBe(284);
    expect(tiny.top).toBeGreaterThanOrEqual(8);
    expect(tiny.top + Math.min(900, tiny.maxHeight)).toBeLessThanOrEqual(300 - 8);
  });
});
