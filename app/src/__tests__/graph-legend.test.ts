/**
 * The graph legend (app/wiki/graph/GraphLegend.tsx, LegendKey.tsx), a
 * map-app style control: collapsed, a small "Filters" button with a badge
 * when filters differ from the default map; expanded, the filter panel
 * (checkboxes with noun labels, checked = shown) with "Filters", an ⓘ
 * button whose popover is the key "How to read the map", and "Collapse
 * filters". The key has no section of its own in the panel.
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import GraphLegend from '../app/wiki/graph/GraphLegend';
import { KeyBody, KeyDialog } from '../app/wiki/graph/LegendKey';
import { buildGraphModel, DEFAULT_FILTERS, filterGraph, type GraphFilters } from '../lib/graph-model';
import type { RelationEdge } from '../lib/relation-edges';
import type { WikiGraph, WikiGraphNode } from '../lib/wiki-graph';

const page = (id: string, category: string, group = 'entity'): WikiGraphNode =>
  ({ id, label: id, group, category, source_count: 1, summary: null, last_updated: null, degree: 0 });
const rel = (s: string, t: string, type: string): RelationEdge =>
  ({ source: s, target: t, relations: [{ type, direction: 'out', source_count: 1 }], wikilink: false, weight: 1 });
const DATA: WikiGraph = {
  nodes: [page('a', 'Travel'), page('b', 'Travel', 'concept'), page('c', 'Crypto', 'overview'), page('s', 'Crypto', 'source-summary')],
  links: [rel('a', 'b', 'uses'), rel('b', 'c', 'competes_with')],
  missing: [{ name: 'Satoshi', source_count: 2, page_ids: ['c'] }],
};
const model = buildGraphModel(DATA);

function render(filters: GraphFilters = DEFAULT_FILTERS, extra: Partial<Parameters<typeof GraphLegend>[0]> = {}) {
  return renderToString(createElement(GraphLegend, {
    model, visible: filterGraph(model, filters), filters, onFilters: () => {}, includeArchived: false, onIncludeArchived: () => {},
    missingCount: 1, showMissing: false, onShowMissing: () => {}, pointerLimited: false, open: true, onOpen: () => {},
    size: { width: 260, height: null }, onSize: () => {}, onSizeDone: () => {}, ...extra,
  }));
}
const labels = (html: string) => [...html.matchAll(/data-filter="([^"]+)"/g)].map((m) => m[1].replace(/&quot;/g, '"'));
/** The opening tag of the first element matching `pattern`. */
const tag = (html: string, pattern: RegExp) => html.match(pattern)?.[0] ?? '';
const filtersButton = (html: string) => tag(html, /<button[^>]*class="graph-filters-btn"[^>]*>/);
const dialogStart = (html: string) => html.indexOf('role="dialog"');

describe('collapsed: the "Filters" button', () => {
  it('shows only the button, labelled and wired to the hidden panel', () => {
    const html = render(DEFAULT_FILTERS, { open: false });
    const button = filtersButton(html);
    expect(button).toContain('aria-expanded="false"');
    expect(button).not.toContain('hidden');
    const controls = button.match(/aria-controls="([^"]+)"/)?.[1];
    const panel = tag(html, new RegExp(`<section[^>]*id="${controls}"[^>]*>`));
    expect(panel).toContain('hidden=""');
    expect(panel).toContain('display:none');
    expect(html).toMatch(/class="graph-filters-btn"[^>]*>.*Filters/);
    expect(html).not.toContain('data-badge'); // the default map: no badge
    expect(html).not.toContain('Resize filters');
    expect(html).not.toContain('role="dialog"'); // no key popover while collapsed
  });

  it('carries a badge with the number of filters that differ from the default map', () => {
    const changed = { ...DEFAULT_FILTERS, hiddenCategories: new Set(['Travel']), showSources: true };
    const html = render(changed, { open: false, includeArchived: true });
    expect(html).toMatch(/<span data-badge="[^"]*"[^>]*>3 changed<\/span>/);
    expect(filtersButton(html)).toContain('title="Expand filters (3 changed from the default map)"');
    expect(html).not.toMatch(/>\s*(Show|Hide)\b/);
  });
});

describe('expanded: the filter panel', () => {
  it('has a header with "Filters", the key’s ⓘ button and "Collapse filters"', () => {
    const html = render();
    expect(filtersButton(html)).toContain('hidden=""');
    const panelId = filtersButton(html).match(/aria-controls="([^"]+)"/)?.[1];
    const panel = tag(html, new RegExp(`<section[^>]*id="${panelId}"[^>]*>`));
    expect(panel).not.toContain('hidden');
    const titleId = panel.match(/aria-labelledby="([^"]+)"/)?.[1];
    expect(html).toContain(`<h2 id="${titleId}"`);
    expect(html).toMatch(new RegExp(`<h2 id="${titleId}"[^>]*>\\s*Filters\\s*</h2>`));
    const close = tag(html, /<button[^>]*aria-label="Collapse filters"[^>]*>/);
    expect(close).toContain(`aria-controls="${panelId}"`);
    expect(html).toContain('aria-label="Resize filters"');
  });

  it('puts every filter in the panel as a checkbox with a noun label', () => {
    const html = render();
    expect(html.match(/<input type="checkbox"/g)?.length).toBe(labels(html).length);
    expect(labels(html)).toEqual(expect.arrayContaining(['Travel', 'Crypto', 'Entity', 'Source pages', 'Missing pages', 'Archived pages', 'Plain links']));
    for (const sub of ['>Topics<', '>Pages<', '>Lines<']) expect(html).toContain(sub);
    for (const label of labels(html)) expect(label).not.toMatch(/^show/i);
  });

  it('shows each state in the checkbox itself: checked = shown', () => {
    const off = render();
    const on = render({ ...DEFAULT_FILTERS, showSources: true, showPlain: true }, { showMissing: true });
    const checkedFor = (html: string, label: string) => {
      const at = html.indexOf(`data-filter="${label}"`);
      return /<input type="checkbox"[^>]*checked=""/.test(html.slice(at, html.indexOf('</label>', at)));
    };
    for (const label of ['Source pages', 'Plain links', 'Missing pages']) {
      expect(checkedFor(off, label)).toBe(false);
      expect(checkedFor(on, label)).toBe(true);
    }
    expect(checkedFor(off, 'Travel')).toBe(true); // topics show unless hidden
  });

  it('takes the size it is given', () => {
    const html = render(DEFAULT_FILTERS, { size: { width: 333, height: 480 } });
    expect(html).toMatch(/width:333px/);
    expect(html).toMatch(/height:480px/);
  });

  it('has no "How to read the map" section: the key lives only in the ⓘ popover', () => {
    const html = render();
    expect(html).not.toContain('data-legend="key"');
    expect(html).not.toContain('graph-disclosure');
    const at = dialogStart(html);
    expect(at).toBeGreaterThan(0);
    // Every key row is inside the popover, none in the filter list.
    for (const text of ['typed relation (arrow = how it reads)', 'dashed circle = missing page', 'size = how many sources']) {
      expect(html.indexOf(text)).toBeGreaterThan(at);
    }
    expect(html.indexOf('>How to read the map<')).toBeGreaterThan(at); // the popover's heading, nowhere else
    expect(html.match(/>How to read the map</g)?.length).toBe(1);
  });
});

describe('the ⓘ key popover', () => {
  it('is a button with aria-expanded and aria-controls pointing at a non-modal dialog named "How to read the map"', () => {
    const html = render();
    const info = tag(html, /<button[^>]*aria-label="How to read the map"[^>]*>/);
    expect(info).toContain('aria-haspopup="dialog"');
    expect(info).toContain('aria-expanded="false"');
    const popId = info.match(/aria-controls="([^"]+)"/)?.[1];
    const dialog = tag(html, new RegExp(`<div[^>]*id="${popId}"[^>]*>`));
    expect(dialog).toContain('role="dialog"');
    expect(dialog).not.toContain('aria-modal');
    expect(dialog).toContain('hidden=""'); // closed until hovered, focused or clicked
    const headingId = dialog.match(/aria-labelledby="([^"]+)"/)?.[1];
    expect(html).toMatch(new RegExp(`<h3 id="${headingId}"[^>]*>How to read the map</h3>`));
  });

  it('when open, shows the whole key where it was placed, above the legend', () => {
    const html = renderToString(createElement(KeyDialog, {
      id: 'k', headingId: 'h', open: true, place: { left: 12, top: 40, maxHeight: 500, side: 'below' },
      children: createElement(KeyBody, { opposed: true, missing: true }),
    }));
    const dialog = tag(html, /<div[^>]*role="dialog"[^>]*>/);
    expect(dialog).not.toContain('hidden');
    expect(dialog).toContain('data-side="below"');
    expect(dialog).toMatch(/left:12px;top:40px/);
    expect(dialog).toContain('z-index:30');
    expect(dialog).toContain('visibility:visible');
    for (const text of ['Dots', 'colour = topic', 'outer ring = overview or comparison', 'dashed circle = missing page', 'BRIDGE',
      'mint ring = selected page', 'competes / contradicts', '“related to”', 'plain link (wikilink only)', 'leads to a missing page',
      'Hover a line or zoom in to read relation names.']) expect(html).toContain(text);
    expect(html).not.toContain('<input'); // nothing to tick in the key
  });

  it('stays invisible until it has been placed, so it never flashes in the wrong spot', () => {
    const html = renderToString(createElement(KeyDialog, { id: 'k', headingId: 'h', open: true, place: null, children: 'x' }));
    expect(html).toContain('visibility:hidden');
  });
});
