/**
 * What the knowledge graph lights up on hover or selection, and how a line
 * reads in its hover card and panel (lib/graph-focus.ts).
 */

import { describe, expect, it } from 'vitest';
import {
  acceptHover, cardHover, closesPanelOnEscape, focusKey, focusHighlight, hoverCardText, limitsLinePointer, linkSummary, nodeHighlight, POINTER_LINES_MAX,
  readingOrder, relationsBetween, takesPointer,
} from '../lib/graph-focus';
import { buildMissingLayer } from '../lib/graph-missing';
import { buildGraphModel, DEFAULT_FILTERS, filterGraph, type ModelLink } from '../lib/graph-model';
import type { PageConnections } from '../lib/relations';
import type { WikiGraph, WikiGraphNode } from '../lib/wiki-graph';

const page = (id: string, label: string): WikiGraphNode => ({
  id, label, group: 'entity', category: 'Crypto', source_count: 1, summary: null, last_updated: null, degree: 0,
});

const DATA: WikiGraph = {
  nodes: [page('a-pow', 'Proof of work'), page('b-bitcoin', 'Bitcoin'), page('c-eth', 'Ethereum'), page('d-vilnius', 'Vilnius')],
  links: [
    // Stored from the "a" end: proof of work is used by Bitcoin.
    { source: 'a-pow', target: 'b-bitcoin', relations: [{ type: 'uses', direction: 'in', source_count: 3, direction_disputed: false, outdated: false }, { type: 'related_to', direction: 'out', source_count: 1, direction_disputed: false, outdated: false }], wikilink: true, weight: 3 },
    { source: 'b-bitcoin', target: 'c-eth', relations: [{ type: 'competes_with', direction: 'out', source_count: 2, direction_disputed: false, outdated: false }], wikilink: false, weight: 2 },
    { source: 'c-eth', target: 'd-vilnius', relations: [], wikilink: true, weight: 0 },
  ],
  missing: [],
};

const model = buildGraphModel(DATA);
const visible = filterGraph(model, DEFAULT_FILTERS);
const lineOf = (a: string, b: string) => model.links.find((l) => l.a === a && l.b === b) as ModelLink;

describe('readingOrder', () => {
  it('reads a one-way relation forwards, from its `from` page', () => {
    expect(readingOrder(lineOf('a-pow', 'b-bitcoin'))).toEqual(['b-bitcoin', 'a-pow']);
  });

  it('reads a two-way relation from the preferred end, else from `a`', () => {
    const line = lineOf('b-bitcoin', 'c-eth');
    expect(readingOrder(line)).toEqual(['b-bitcoin', 'c-eth']);
    expect(readingOrder(line, 'c-eth')).toEqual(['c-eth', 'b-bitcoin']);
    expect(readingOrder(line, 'd-vilnius')).toEqual(['b-bitcoin', 'c-eth']);
  });
});

describe('linkSummary', () => {
  it('names both pages and the strongest relation, read forwards', () => {
    expect(linkSummary(lineOf('a-pow', 'b-bitcoin'), model.byId)).toBe('Bitcoin — Uses → Proof of work (+1 more)');
    expect(linkSummary(lineOf('b-bitcoin', 'c-eth'), model.byId)).toBe('Bitcoin — Competes with → Ethereum');
    expect(linkSummary(lineOf('c-eth', 'd-vilnius'), model.byId)).toBe('Plain link: Ethereum — Vilnius');
  });
});

describe('focusHighlight', () => {
  it('lights a page, its visible neighbours and their lines', () => {
    const lit = nodeHighlight(visible, 'b-bitcoin');
    expect([...lit.nodes].sort()).toEqual(['a-pow', 'b-bitcoin', 'c-eth']);
    expect(lit.links.size).toBe(2);
  });

  it('prefers the hover over the selection and ignores a focus that is not shown', () => {
    const plain = lineOf('c-eth', 'd-vilnius'); // plain links are hidden by default
    expect(focusHighlight(visible, { kind: 'node', id: 'd-vilnius' }, null)?.nodes).toEqual(new Set(['d-vilnius']));
    expect(focusHighlight(visible, { kind: 'link', link: plain }, null)).toBeNull();
    const hovered = focusHighlight(visible, { kind: 'link', link: lineOf('b-bitcoin', 'c-eth') }, { kind: 'node', id: 'a-pow' });
    expect(hovered?.nodes).toEqual(new Set(['b-bitcoin', 'c-eth']));
    expect(focusHighlight(visible, null, { kind: 'node', id: 'a-pow' })?.nodes).toEqual(new Set(['a-pow', 'b-bitcoin']));
    expect(focusHighlight(visible, null, { kind: 'node', id: 'gone' })).toBeNull();
  });
});

describe('relationsBetween', () => {
  it('keeps the connections whose other end is the given page, with their group label', () => {
    const connections: PageConnections = {
      groups: [
        { label: 'Uses', items: [
          { page_id: 'a-pow', title: 'Proof of work', type: 'uses', direction: 'out', source_count: 3, evidence: [], direction_dispute: null, outdated: null },
          { page_id: null, title: 'SHA-256', type: 'uses', direction: 'out', source_count: 1, evidence: [], direction_dispute: null, outdated: null },
        ] },
        { label: 'Related to', items: [
          { page_id: 'a-pow', title: 'Proof of work', type: 'related_to', direction: 'out', source_count: 1, evidence: [], direction_dispute: null, outdated: null },
        ] },
      ],
      linked_only: [{ page_id: 'd-vilnius', title: 'Vilnius' }],
    };
    expect(relationsBetween(connections, 'a-pow').map((r) => `${r.label}:${r.item.type}`)).toEqual(['Uses:uses', 'Related to:related_to']);
    expect(relationsBetween(connections, 'd-vilnius')).toEqual([]);
  });
});

describe('hoverCardText', () => {
  it('describes a page by category, type and sources', () => {
    const id = 'd-vilnius';
    expect(hoverCardText({ kind: 'node', id }, model.byId)).toEqual({ title: 'Vilnius', detail: 'Crypto · entity · 1 source' });
    expect(hoverCardText(null, model.byId)).toBeNull();
  });

  it('counts the sources of the relation it names, not the line weight', () => {
    // uses(1) + related_to(3): the card names "Uses", so it says 1 source though the weight is 3.
    const data: WikiGraph = {
      nodes: [page('x', 'Bitcoin'), page('y', 'Proof of work')],
      links: [{ source: 'x', target: 'y', relations: [
        { type: 'related_to', direction: 'out', source_count: 3, direction_disputed: false, outdated: false }, { type: 'uses', direction: 'out', source_count: 1, direction_disputed: false, outdated: false },
      ], wikilink: true, weight: 3 }],
      missing: [],
    };
    const m = buildGraphModel(data);
    expect(hoverCardText({ kind: 'link', link: m.links[0] }, m.byId)).toEqual({
      title: 'Bitcoin — Uses → Proof of work (+1 more)', detail: 'Click for the evidence · 1 source',
    });
    expect(hoverCardText({ kind: 'link', link: lineOf('c-eth', 'd-vilnius') }, model.byId)?.detail).toBe('Click for the evidence');
  });
});

describe('closesPanelOnEscape', () => {
  const key = (target: unknown, extra: Partial<{ key: string; defaultPrevented: boolean }> = {}) => ({
    key: 'Escape', defaultPrevented: false, target, ...extra,
  });

  it('closes on Escape over the page or the canvas', () => {
    expect(closesPanelOnEscape(key(null))).toBe(true);
    expect(closesPanelOnEscape(key({ tagName: 'CANVAS', isContentEditable: false }))).toBe(true);
    expect(closesPanelOnEscape(key({ tagName: 'BUTTON' }))).toBe(true);
  });

  it('leaves typing fields, handled events and other keys alone', () => {
    for (const tagName of ['INPUT', 'textarea', 'SELECT']) expect(closesPanelOnEscape(key({ tagName }))).toBe(false);
    expect(closesPanelOnEscape(key({ tagName: 'DIV', isContentEditable: true }))).toBe(false);
    expect(closesPanelOnEscape(key(null, { defaultPrevented: true }))).toBe(false);
    expect(closesPanelOnEscape(key(null, { key: 'Enter' }))).toBe(false);
  });
});

describe('line pointer areas', () => {
  it('limits pointer areas to typed lines past ~3,000 visible lines', () => {
    expect(POINTER_LINES_MAX).toBe(3000);
    expect(limitsLinePointer(3000)).toBe(false);
    expect(limitsLinePointer(3001)).toBe(true);
    const [typedLine, relatedLine, plainLine] = [lineOf('a-pow', 'b-bitcoin'), lineOf('b-bitcoin', 'c-eth'), lineOf('c-eth', 'd-vilnius')];
    expect(typedLine.kind).toBe('typed');
    expect(plainLine.kind).toBe('plain');
    for (const l of [typedLine, relatedLine, plainLine]) expect(takesPointer(l, false)).toBe(true);
    expect(takesPointer(typedLine, true)).toBe(true);
    expect(takesPointer(plainLine, true)).toBe(false);
  });

  it("never gives a missing name's line a pointer area", () => {
    const layer = buildMissingLayer({ missing: [{ name: 'Satoshi', source_count: 2, page_ids: ['b-bitcoin'] }], byId: model.byId });
    const line = [...layer.linksOf.values()][0][0];
    expect(takesPointer(line, false)).toBe(false);
    expect(hoverCardText({ kind: 'link', link: line }, model.byId)).toBeNull();
  });
});

describe('acceptHover', () => {
  it('shows what force-graph hovers only while the pointer is over the canvas', () => {
    const a = { kind: 'node', id: 'a' } as const;
    const b = { kind: 'node', id: 'b' } as const;
    // Over the canvas: the page under the pointer lights up.
    expect(acceptHover(true, a)).toBe(a);
    // Off onto the side panel: force-graph keeps testing its last point as the map glides under it.
    expect(acceptHover(false, b)).toBeNull();
    expect(acceptHover(false, null)).toBeNull();
    // Back over the canvas: what force-graph holds there now.
    expect(acceptHover(true, b)).toBe(b);
    expect(acceptHover(true, null)).toBeNull();
  });
});

describe('the hover card after a click', () => {
  const node = { kind: 'node', id: 'b-bitcoin' } as const;
  const line = { kind: 'link', link: lineOf('a-pow', 'b-bitcoin') } as const;

  it('tells pages and lines apart by key', () => {
    expect(focusKey(node)).not.toEqual(focusKey({ kind: 'node', id: 'c-eth' }));
    expect(focusKey(line)).toEqual(focusKey({ kind: 'link', link: lineOf('a-pow', 'b-bitcoin') }));
    expect(focusKey(line)).not.toEqual(focusKey(node));
    expect(focusKey(null)).toBeNull();
  });

  it('hides the card for the page or line just clicked (it would cover the panel), and shows it for anything else', () => {
    expect(cardHover(node, focusKey(node))).toBeNull();
    expect(cardHover(line, focusKey(line))).toBeNull();
    expect(cardHover(node, focusKey(line))).toBe(node);
    expect(cardHover(node, null)).toBe(node);
    expect(cardHover(null, focusKey(node))).toBeNull();
  });
});
