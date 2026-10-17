/**
 * "Connect two pages" (lib/graph-path.ts): Dijkstra over the visible lines
 * with typed 1 / plain 2 / "related to" 3, no path, stable ties, the steps
 * read from the start, the title pickers and map clicks filling them.
 */

import { describe, expect, it } from 'vitest';
import { buildGraphModel, DEFAULT_FILTERS, filterGraph, type GraphFilters } from '../lib/graph-model';
import {
  EDGE_COST, fillPath, findByTitle, pathHighlight, pathSteps, pickerLabel, shortestPath,
} from '../lib/graph-path';
import { buildMissingLayer, withMissing } from '../lib/graph-missing';
import type { RelationEdge } from '../lib/relation-edges';
import type { WikiGraph, WikiGraphNode } from '../lib/wiki-graph';

function page(id: string, extra: Partial<WikiGraphNode> = {}): WikiGraphNode {
  return { id, label: id.charAt(0).toUpperCase() + id.slice(1), group: 'entity', category: 'AI', source_count: 1, summary: null, last_updated: null, degree: 0, ...extra };
}
const typed = (source: string, target: string, type = 'uses', direction: 'out' | 'in' = 'out'): RelationEdge =>
  ({ source, target, relations: [{ type, direction, source_count: 1 }], wikilink: false, weight: 1 });
const related = (source: string, target: string): RelationEdge =>
  ({ source, target, relations: [{ type: 'related_to', direction: 'out', source_count: 1 }], wikilink: false, weight: 1 });
const plain = (source: string, target: string): RelationEdge => ({ source, target, relations: [], wikilink: true, weight: 0 });
const ALL: GraphFilters = { ...DEFAULT_FILTERS, showPlain: true, showRelated: true };

function visibleOf(data: WikiGraph, filters: GraphFilters = ALL) {
  const model = buildGraphModel(data);
  return { model, visible: filterGraph(model, filters) };
}

describe('shortestPath', () => {
  it('costs typed 1, plain 2 and "related to" 3', () => {
    expect(EDGE_COST).toEqual({ typed: 1, plain: 2, related: 3 });
    // claude -> anthropic -> ef costs 2 typed; the direct "related to" line costs 3.
    const { visible } = visibleOf({
      nodes: ['claude', 'anthropic', 'ef'].map((id) => page(id)),
      links: [typed('anthropic', 'claude', 'created_by', 'in'), typed('anthropic', 'ef'), related('claude', 'ef')],
      missing: [],
    });
    const path = shortestPath(visible, 'claude', 'ef');
    expect(path?.nodes).toEqual(['claude', 'anthropic', 'ef']);
    expect(path?.cost).toBe(2);
    expect(path?.links.map((l) => l.kind)).toEqual(['typed', 'typed']);
  });

  it('takes a plain link over three typed lines, and a related line over four', () => {
    const { visible } = visibleOf({
      nodes: ['a', 'b', 'c', 'd', 'z'].map((id) => page(id)),
      links: [typed('a', 'b'), typed('b', 'c'), typed('c', 'z'), plain('a', 'z'), typed('a', 'd')],
      missing: [],
    });
    expect(shortestPath(visible, 'a', 'z')?.nodes).toEqual(['a', 'z']);
  });

  it('prefers the chain of typed lines at equal cost', () => {
    // a-b-z typed (cost 2) against the plain a-z (cost 2): the typed chain explains more.
    const { visible } = visibleOf({
      nodes: ['a', 'b', 'z'].map((id) => page(id)),
      links: [plain('a', 'z'), typed('a', 'b'), typed('b', 'z')],
      missing: [],
    });
    expect(shortestPath(visible, 'a', 'z')?.nodes).toEqual(['a', 'b', 'z']);
  });

  it('breaks ties the same way whatever the order of the lines', () => {
    const nodes = ['s', 'm1', 'm2', 'm3', 't'].map((id) => page(id));
    const links = [typed('s', 'm3'), typed('m3', 't'), typed('s', 'm1'), typed('m1', 't'), typed('s', 'm2'), typed('m2', 't')];
    const forward = shortestPath(visibleOf({ nodes, links, missing: [] }).visible, 's', 't');
    const backward = shortestPath(visibleOf({ nodes: [...nodes].reverse(), links: [...links].reverse(), missing: [] }).visible, 's', 't');
    expect(forward?.nodes).toEqual(['s', 'm1', 't']);
    expect(backward?.nodes).toEqual(forward?.nodes);
  });

  it('says there is no path between parts the visible lines do not join', () => {
    const data: WikiGraph = {
      nodes: ['a', 'b', 'c'].map((id) => page(id)),
      links: [typed('a', 'b'), plain('b', 'c')],
      missing: [],
    };
    expect(shortestPath(visibleOf(data).visible, 'a', 'c')?.nodes).toEqual(['a', 'b', 'c']);
    // Plain links hidden: only the typed line shows, so c is cut off.
    expect(shortestPath(visibleOf(data, DEFAULT_FILTERS).visible, 'a', 'c')).toBeNull();
    // A page that is not visible, or not loaded, has no path.
    expect(shortestPath(visibleOf(data).visible, 'a', 'ghost')).toBeNull();
  });

  it('returns the page itself for the same page', () => {
    const { visible } = visibleOf({ nodes: [page('a')], links: [], missing: [] });
    expect(shortestPath(visible, 'a', 'a')).toEqual({ nodes: ['a'], links: [], cost: 0 });
  });

  it('lights the path', () => {
    const { visible } = visibleOf({ nodes: ['a', 'b', 'c'].map((id) => page(id)), links: [typed('a', 'b'), typed('b', 'c')], missing: [] });
    const path = shortestPath(visible, 'a', 'c');
    expect(path).not.toBeNull();
    const lit = pathHighlight(path as NonNullable<typeof path>);
    expect([...lit.nodes].sort()).toEqual(['a', 'b', 'c']);
    expect(lit.links.size).toBe(2);
  });
});

describe('pathSteps', () => {
  it('reads each relation from the page before it', () => {
    // Stored: anthropic created_by... from the a end; "claude" is `a` of the pair (anthropic < claude).
    const { visible } = visibleOf({
      nodes: ['claude', 'anthropic', 'openai'].map((id) => page(id)),
      links: [typed('anthropic', 'claude', 'created_by', 'in'), typed('anthropic', 'openai', 'competes_with'), plain('claude', 'openai')],
      missing: [],
    }, DEFAULT_FILTERS);
    const path = shortestPath(visible, 'claude', 'openai');
    expect(path?.nodes).toEqual(['claude', 'anthropic', 'openai']);
    const steps = pathSteps(path as NonNullable<typeof path>);
    expect(steps.map((s) => [s.from, s.label, s.to])).toEqual([
      ['claude', 'Created by', 'anthropic'],
      ['anthropic', 'Competes with', 'openai'],
    ]);
  });

  it('names no relation for a plain link', () => {
    const { visible } = visibleOf({ nodes: ['a', 'b'].map((id) => page(id)), links: [plain('a', 'b')], missing: [] });
    const path = shortestPath(visible, 'b', 'a');
    expect(pathSteps(path as NonNullable<typeof path>)).toEqual([expect.objectContaining({ from: 'b', to: 'a', type: null, label: null })]);
  });
});

describe('title pickers', () => {
  const { model } = visibleOf({
    nodes: [page('vilnius', { label: 'Vilnius' }), page('old', { label: 'Kaunas', archived: true })],
    links: [],
    missing: [],
  });

  it('finds a page by its title or picker label, any case', () => {
    expect(pickerLabel(model.byId.get('old') as never)).toBe('Kaunas (archived)');
    expect(findByTitle(model.nodes, ' vilnius ')).toBe('vilnius');
    expect(findByTitle(model.nodes, 'KAUNAS (ARCHIVED)')).toBe('old');
    expect(findByTitle(model.nodes, 'Kaunas')).toBe('old');
    expect(findByTitle(model.nodes, 'Vil')).toBeNull();
    expect(findByTitle(model.nodes, '')).toBeNull();
  });

  it('fills the start, then the end, then replaces the end on map clicks', () => {
    let q = fillPath({ from: null, to: null }, 'a');
    expect(q).toEqual({ from: 'a', to: null });
    expect(fillPath(q, 'a')).toBe(q);
    q = fillPath(q, 'b');
    expect(q).toEqual({ from: 'a', to: 'b' });
    expect(fillPath(q, 'c')).toEqual({ from: 'a', to: 'c' });
    expect(fillPath({ from: null, to: 'b' }, 'b')).toEqual({ from: 'b', to: null });
  });
});

describe('what a path may pass through', () => {
  it('never goes through a page the legend hides, taking a detour or finding none', () => {
    const data: WikiGraph = {
      nodes: [page('a'), page('s', { group: 'source-summary' }), page('b'), page('c'), page('d')],
      links: [typed('a', 's'), typed('s', 'b')],
      missing: [],
    };
    // Sources hidden: s is not on the map, so a and b are not joined.
    expect(shortestPath(visibleOf(data, DEFAULT_FILTERS).visible, 'a', 'b')).toBeNull();
    expect(shortestPath(visibleOf(data, { ...DEFAULT_FILTERS, showSources: true }).visible, 'a', 'b')?.nodes).toEqual(['a', 's', 'b']);
    // With a longer typed detour, the hidden source page is simply walked around.
    const detour = { ...data, links: [...data.links, typed('a', 'c'), typed('c', 'd'), typed('d', 'b')] };
    expect(shortestPath(visibleOf(detour, DEFAULT_FILTERS).visible, 'a', 'b')?.nodes).toEqual(['a', 'c', 'd', 'b']);
  });

  it('never steps through a missing name, even when the missing pages are shown', () => {
    const data: WikiGraph = {
      nodes: [page('a'), page('b')],
      links: [],
      missing: [{ name: 'Satoshi', source_count: 3, page_ids: ['a', 'b'] }],
    };
    const { model, visible } = visibleOf(data, DEFAULT_FILTERS);
    const shown = withMissing(visible, buildMissingLayer(model));
    expect(shown.neighbours.get('a')?.size).toBe(1); // joined to the missing name only
    expect(shortestPath(shown, 'a', 'b')).toBeNull();
  });
});
