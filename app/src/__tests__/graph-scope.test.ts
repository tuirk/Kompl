/**
 * Focus mode (lib/graph-scope.ts) and the missing pages (graph-missing.ts):
 * the URL form and the "See in graph" link, the focus subgraph at depth 1
 * and 2 under the line toggles, the legend change that reveals a hidden
 * focus page, and missing names added beside their pages.
 */

import { describe, expect, it } from 'vitest';
import { hoverCardText } from '../lib/graph-focus';
import { OVERVIEW_NAMES } from '../lib/graph-labels';
import { buildMissingLayer, isMissingLink, isMissingNode, missingId, placeMissing, withMissing } from '../lib/graph-missing';
import { buildGraphModel, DEFAULT_FILTERS, filterGraph, type GraphFilters } from '../lib/graph-model';
import {
  focusGraph, focusHint, focusHintAction, FULL_MAP, historyMode, hopsFrom, missingFocusAction, parseScope, revealFilters, sameScope,
  scopeQuery, seeInGraphHref,
} from '../lib/graph-scope';
import type { RelationEdge } from '../lib/relation-edges';
import type { WikiGraph, WikiGraphNode } from '../lib/wiki-graph';

function page(id: string, category = 'Travel', group = 'entity'): WikiGraphNode {
  return { id, label: id.toUpperCase(), group, category, source_count: 1, summary: null, last_updated: null, degree: 0 };
}
const typed = (source: string, target: string): RelationEdge =>
  ({ source, target, relations: [{ type: 'part_of', direction: 'out', source_count: 1 }], wikilink: false, weight: 1 });
const related = (source: string, target: string): RelationEdge =>
  ({ source, target, relations: [{ type: 'related_to', direction: 'out', source_count: 1 }], wikilink: false, weight: 1 });
const plain = (source: string, target: string): RelationEdge => ({ source, target, relations: [], wikilink: true, weight: 0 });
const withFilters = (f: Partial<GraphFilters>): GraphFilters => ({ ...DEFAULT_FILTERS, ...f });
const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id).sort();

// vilnius - oldtown - gate (typed chain), vilnius ~ kaunas (plain), kaunas ~ trakai (related),
// gate - summary (typed, a source page).
const DATA: WikiGraph = {
  nodes: [page('vilnius'), page('oldtown'), page('gate'), page('kaunas'), page('trakai'), page('summary', 'Travel', 'source-summary'), page('far', 'AI')],
  links: [typed('vilnius', 'oldtown'), typed('oldtown', 'gate'), plain('vilnius', 'kaunas'), related('kaunas', 'trakai'), typed('gate', 'summary')],
  missing: [
    { name: 'Gediminas', source_count: 3, page_ids: ['vilnius', 'gate'] },
    { name: 'Nobody', source_count: 2, page_ids: ['not-loaded'] },
  ],
};
const model = buildGraphModel(DATA);

describe('scope URL', () => {
  it('reads and writes ?focus= and ?depth=', () => {
    expect(parseScope('')).toEqual(FULL_MAP);
    expect(parseScope('?focus=vilnius-1a2b')).toEqual({ focus: 'vilnius-1a2b', depth: 1 });
    expect(parseScope('?focus=vilnius-1a2b&depth=2')).toEqual({ focus: 'vilnius-1a2b', depth: 2 });
    expect(parseScope('?focus=vilnius&depth=7')).toEqual({ focus: 'vilnius', depth: 1 });
    expect(parseScope('?depth=2')).toEqual(FULL_MAP);
    expect(parseScope('?focus=%20')).toEqual(FULL_MAP);
    // As read back on Back / Forward: other parameters and their order do not matter.
    expect(parseScope('?depth=2&utm=x&focus=gate-1')).toEqual({ focus: 'gate-1', depth: 2 });
    expect(parseScope('focus=gate-1')).toEqual({ focus: 'gate-1', depth: 1 });
    expect(scopeQuery(FULL_MAP)).toBe('');
    expect(scopeQuery({ focus: 'vilnius', depth: 1 })).toBe('?focus=vilnius');
    expect(scopeQuery({ focus: 'vilnius', depth: 2 })).toBe('?focus=vilnius&depth=2');
    expect(parseScope(scopeQuery({ focus: 'a b&c', depth: 2 }))).toEqual({ focus: 'a b&c', depth: 2 });
    expect(sameScope({ focus: 'a', depth: 1 }, { focus: 'a', depth: 1 })).toBe(true);
    expect(sameScope({ focus: 'a', depth: 1 }, { focus: 'a', depth: 2 })).toBe(false);
  });

  it('links a page to the graph focused on it', () => {
    expect(seeInGraphHref('bitcoin-network-1c140c9e')).toBe('/wiki/graph?focus=bitcoin-network-1c140c9e');
    expect(seeInGraphHref('a&b')).toBe('/wiki/graph?focus=a%26b');
  });

  it('adds a history entry when the focus changes, and replaces it when only the depth does', () => {
    expect(historyMode(FULL_MAP, { focus: 'vilnius', depth: 1 })).toBe('push'); // Focus
    expect(historyMode({ focus: 'vilnius', depth: 1 }, { focus: 'gate', depth: 1 })).toBe('push'); // another page
    expect(historyMode({ focus: 'vilnius', depth: 2 }, FULL_MAP)).toBe('push'); // Full map
    expect(historyMode({ focus: 'vilnius', depth: 1 }, { focus: 'vilnius', depth: 2 })).toBe('replace'); // 1 / 2 hops
  });

  it('turns archived pages on once for a focused page the map has not loaded, then gives up', () => {
    // "See in graph" from an archived page's article: the map loads without archived pages first.
    expect(missingFocusAction(true, false, false)).toBe('show-archived');
    // Not there with archived pages either (a deleted page): leave, and turn them off again.
    expect(missingFocusAction(false, true, true)).toBe('leave-hide-archived');
    // Archived pages were already on, or the viewer turned them off later: just leave.
    expect(missingFocusAction(true, true, false)).toBe('leave');
    expect(missingFocusAction(false, false, false)).toBe('leave');
  });
});

describe('focus subgraph', () => {
  it('keeps the page and its neighbours at depth 1, and their neighbours at depth 2', () => {
    const full = filterGraph(model, DEFAULT_FILTERS);
    expect([...hopsFrom(full, 'vilnius', 1)].sort()).toEqual(['oldtown', 'vilnius']);
    expect([...hopsFrom(full, 'vilnius', 2)].sort()).toEqual(['gate', 'oldtown', 'vilnius']);
    expect(hopsFrom(full, 'summary', 1).size).toBe(0); // hidden source page
    const focused = focusGraph(model, DEFAULT_FILTERS, full, 'vilnius', 2);
    expect(ids(focused.nodes)).toEqual(['gate', 'oldtown', 'vilnius']);
    expect(focused.links.map((l) => `${l.a}-${l.b}`).sort()).toEqual(['oldtown-gate', 'vilnius-oldtown']);
    expect(focused.categoryCounts.get('Travel')).toBe(3);
  });

  it('walks plain and "related to" lines only when their toggles are on', () => {
    const plainOn = withFilters({ showPlain: true });
    expect(ids(focusGraph(model, plainOn, filterGraph(model, plainOn), 'vilnius', 2).nodes)).toEqual(['gate', 'kaunas', 'oldtown', 'vilnius']);
    const allOn = withFilters({ showPlain: true, showRelated: true, showSources: true });
    const all = focusGraph(model, allOn, filterGraph(model, allOn), 'vilnius', 2);
    expect(ids(all.nodes)).toEqual(['gate', 'kaunas', 'oldtown', 'trakai', 'vilnius']);
    expect(ids(focusGraph(model, allOn, filterGraph(model, allOn), 'gate', 1).nodes)).toEqual(['gate', 'oldtown', 'summary']);
  });

  it('reveals a focused page the legend hides, and leaves the filters alone otherwise', () => {
    const summary = model.byId.get('summary') as NonNullable<ReturnType<typeof model.byId.get>>;
    const vilnius = model.byId.get('vilnius') as typeof summary;
    expect(revealFilters(DEFAULT_FILTERS, vilnius)).toBe(DEFAULT_FILTERS);
    expect(revealFilters(DEFAULT_FILTERS, summary).showSources).toBe(true);
    const hidden = withFilters({ hiddenCategories: new Set(['Travel', 'AI']), hiddenTypes: new Set(['entity', 'concept']) });
    const shown = revealFilters(hidden, vilnius);
    expect([...shown.hiddenCategories]).toEqual(['AI']);
    expect([...shown.hiddenTypes]).toEqual(['concept']);
    expect(filterGraph(model, shown).neighbours.has('vilnius')).toBe(true);
  });
});

describe('missing pages', () => {
  const layer = buildMissingLayer(model);

  it('builds a dashed node for each name whose pages are loaded, joined to those pages', () => {
    expect(layer.nodes.map((n) => n.label)).toEqual(['Gediminas']);
    const node = layer.byId.get(missingId('Gediminas'));
    expect(node && isMissingNode(node)).toBe(true);
    expect(node?.sourceCount).toBe(3);
    expect(node?.homeId).toBe('vilnius');
    expect(layer.linksOf.get(missingId('Gediminas'))?.map((l) => (l.a === missingId('Gediminas') ? l.b : l.a))).toEqual(['vilnius', 'gate']);
    expect(layer.linksOf.get(missingId('Gediminas'))?.every(isMissingLink)).toBe(true);
    expect(isMissingNode(model.byId.get('vilnius') as never)).toBe(false);
  });

  it('adds names to the visible graph only for visible pages, without changing it', () => {
    const full = filterGraph(model, DEFAULT_FILTERS);
    const before = { nodes: full.nodes.length, links: full.links.length, vilnius: full.neighbours.get('vilnius')?.size };
    const shown = withMissing(full, layer);
    const id = missingId('Gediminas');
    expect(shown.neighbours.get(id)).toEqual(new Set(['vilnius', 'gate']));
    expect(shown.neighbours.get('vilnius')?.has(id)).toBe(true);
    expect(shown.linksOf.get('gate')?.some(isMissingLink)).toBe(true);
    expect(shown.labelRank.get(id)).toBe(OVERVIEW_NAMES);
    expect(shown.nodes.length).toBe(before.nodes + 1);
    expect(shown.links.length).toBe(before.links + 2);
    expect({ nodes: full.nodes.length, links: full.links.length, vilnius: full.neighbours.get('vilnius')?.size }).toEqual(before);
    expect(full.neighbours.has(id)).toBe(false);
    // Focused on a part without its pages: no missing name.
    const far = focusGraph(model, DEFAULT_FILTERS, full, 'far', 1);
    expect(withMissing(far, layer).nodes.some(isMissingNode)).toBe(false);
  });

  it('starts a name beside its home page where that page is now', () => {
    const home = model.byId.get('vilnius') as NonNullable<ReturnType<typeof model.byId.get>>;
    home.x += 500;
    placeMissing(layer, model.byId);
    const node = layer.nodes[0];
    expect(Math.hypot(node.x - home.x, node.y - home.y)).toBeLessThan(home.radius + node.radius + 40);
  });

  it('says in the hover card how many sources name it', () => {
    const lookup = new Map([...model.byId, ...layer.byId]);
    expect(hoverCardText({ kind: 'node', id: missingId('Gediminas') }, lookup)).toEqual({
      title: 'Gediminas', detail: 'Named in 3 sources, no page yet',
    });
  });
});

describe('focusHint', () => {
  const hintFor = (id: string, filters: GraphFilters = DEFAULT_FILTERS) => {
    const full = filterGraph(model, filters);
    return focusHint(model, full, focusGraph(model, filters, full, id, 1), id, filters);
  };

  it('names the hidden kinds that join a lone focused page to the map', () => {
    expect(hintFor('kaunas')).toEqual({ plain: true, related: true }); // a plain link to Vilnius, "related to" Trakai
    expect(hintFor('trakai')).toEqual({ plain: false, related: true });
    expect(focusHintAction({ plain: true, related: true })).toBe('Show plain links and “related to”');
    expect(focusHintAction({ plain: false, related: true })).toBe('Show “related to”');
    expect(focusHintAction({ plain: true, related: false })).toBe('Show plain links');
  });

  it('gives no hint when the view has lines, nothing is focused or no hidden line helps', () => {
    expect(hintFor('vilnius')).toBeNull(); // typed lines
    expect(hintFor('far')).toBeNull(); // no lines at all
    expect(hintFor('kaunas', withFilters({ showPlain: true }))).toBeNull(); // now joined to Vilnius
    const full = filterGraph(model, DEFAULT_FILTERS);
    expect(focusHint(model, full, full, null, DEFAULT_FILTERS)).toBeNull();
  });
});
