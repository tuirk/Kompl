/**
 * The knowledge graph page's model (lib/graph-model.ts, graph-layout.ts):
 * lines built from the API pairs, the legend's filters, category colours,
 * seeded positions, island order and the cost of a large graph.
 */

import { describe, expect, it } from 'vitest';
import { buildGraphModel, DEFAULT_FILTERS, filterGraph, plainLinksHint, type GraphFilters } from '../lib/graph-model';
import {
  categoryAnchors, centerFor, clusterRadius, edgeWidth, fitView, rankCategories, ringOrder, seedPosition, UNCATEGORIZED,
  zoomAnchor, zoomAround, ZOOM_MAX,
} from '../lib/graph-layout';
import { CATEGORY_HEX, LINE_ALPHA, LINE_HEX, LINE_LIT_HEX, NEUTRAL_HEX, NO_TOPIC_HEX, withAlpha } from '../lib/graph-palette';
import type { RelationEdge } from '../lib/relation-edges';
import type { WikiGraph, WikiGraphNode } from '../lib/wiki-graph';

function page(id: string, category: string, group = 'entity', extra: Partial<WikiGraphNode> = {}): WikiGraphNode {
  return { id, label: id.toUpperCase(), group, category, source_count: 1, summary: null, last_updated: null, degree: 0, ...extra };
}
function line(source: string, target: string, relations: RelationEdge['relations'], wikilink = true): RelationEdge {
  return { source, target, relations, wikilink, weight: relations.reduce((m, r) => Math.max(m, r.source_count), 0) };
}

const DATA: WikiGraph = {
  nodes: [
    page('bitcoin', 'Crypto', 'entity', { source_count: 4 }),
    page('pow', 'Crypto', 'concept'),
    page('eth', 'Crypto'),
    page('btc-summary', 'Crypto', 'source-summary'),
    page('vilnius', 'Travel'),
    page('kaunas', 'Travel'),
    page('travel-overview', 'Travel', 'overview'),
    page('misc', UNCATEGORIZED),
  ],
  links: [
    line('bitcoin', 'pow', [{ type: 'uses', direction: 'out', source_count: 3 }, { type: 'part_of', direction: 'in', source_count: 1 }]),
    line('bitcoin', 'eth', [{ type: 'related_to', direction: 'out', source_count: 3 }, { type: 'competes_with', direction: 'out', source_count: 1 }]),
    line('eth', 'pow', [{ type: 'related_to', direction: 'out', source_count: 2 }]),
    line('bitcoin', 'btc-summary', []),
    line('kaunas', 'vilnius', [{ type: 'competes_with', direction: 'out', source_count: 3 }]),
    line('travel-overview', 'vilnius', []),
    line('bitcoin', 'ghost', [{ type: 'uses', direction: 'out', source_count: 1 }]),
  ],
  missing: [{ name: 'Satoshi', source_count: 2, page_ids: ['bitcoin'] }],
};

const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id).sort();
const pairs = (xs: Array<{ a: string; b: string }>) => xs.map((x) => `${x.a}-${x.b}`).sort();
const withFilters = (f: Partial<GraphFilters>) => ({ ...DEFAULT_FILTERS, ...f });

describe('buildGraphModel', () => {
  it('keeps one line per API pair between known pages, typed by its relations', () => {
    const model = buildGraphModel(DATA);
    expect(model.links).toHaveLength(6); // the line to an unknown page is dropped
    const byPair = new Map(model.links.map((l) => [`${l.a}-${l.b}`, l]));
    expect(byPair.get('bitcoin-pow')).toMatchObject({ kind: 'typed', colorType: 'uses', weight: 3, width: 3, sameCategory: true });
    // A specific relation names the line even when "related to" has more sources.
    expect(byPair.get('bitcoin-eth')).toMatchObject({ kind: 'typed', colorType: 'competes_with' });
    expect(byPair.get('eth-pow')).toMatchObject({ kind: 'related', colorType: 'related_to', width: edgeWidth(2) });
    expect(byPair.get('bitcoin-btc-summary')).toMatchObject({ kind: 'plain', colorType: null, width: 1 });
    // Lines are grey, never topic- or relation-coloured: brightness by kind, lit when in focus.
    expect(byPair.get('bitcoin-pow')).toMatchObject({ color: withAlpha(LINE_HEX, LINE_ALPHA.typed), bright: LINE_LIT_HEX });
    expect(byPair.get('eth-pow')?.color).toBe(withAlpha(LINE_HEX, LINE_ALPHA.related));
    expect(byPair.get('bitcoin-btc-summary')?.color).toBe(withAlpha(LINE_HEX, LINE_ALPHA.plain));
    expect(model.missing).toEqual(DATA.missing);
  });

  it('orders lines for drawing: plain first, then "related to", then typed, lighter first', () => {
    const kinds = buildGraphModel(DATA).links.map((l) => `${l.kind}:${l.weight}`);
    expect(kinds).toEqual(['plain:0', 'plain:0', 'related:2', 'typed:3', 'typed:3', 'typed:3']);
  });

  it('marks source pages and ringed page types, and sizes pages by sources', () => {
    const model = buildGraphModel(DATA);
    expect(model.byId.get('btc-summary')).toMatchObject({ isSource: true, ring: false });
    expect(model.byId.get('travel-overview')).toMatchObject({ isSource: false, ring: true });
    expect(model.byId.get('bitcoin')?.radius).toBe(Math.sqrt(4) * 4 + 2);
  });

  it('starts every page at the same spot on every build', () => {
    const a = buildGraphModel(DATA);
    const b = buildGraphModel({ ...DATA, nodes: [...DATA.nodes].reverse() });
    for (const n of a.nodes) {
      expect(b.byId.get(n.id)).toMatchObject({ x: n.x, y: n.y, anchorX: n.anchorX, anchorY: n.anchorY });
    }
    const vilnius = a.byId.get('vilnius')!;
    const travel = a.categories.find((c) => c.name === 'Travel')!;
    expect(Math.hypot(vilnius.x - travel.anchorX, vilnius.y - travel.anchorY)).toBeLessThanOrEqual(clusterRadius(travel.total));
    expect(a.byId.get('kaunas')!.x).not.toBe(vilnius.x);
  });
});

describe('filterGraph', () => {
  const model = buildGraphModel(DATA);

  it('by default hides source pages, "related to"-only lines and plain links', () => {
    const v = filterGraph(model, DEFAULT_FILTERS);
    expect(ids(v.nodes)).toEqual(['bitcoin', 'eth', 'kaunas', 'misc', 'pow', 'travel-overview', 'vilnius']);
    expect(pairs(v.links)).toEqual(['bitcoin-eth', 'bitcoin-pow', 'kaunas-vilnius']);
  });

  it('shows each hidden kind behind its toggle', () => {
    expect(pairs(filterGraph(model, withFilters({ showRelated: true })).links)).toContain('eth-pow');
    const plain = filterGraph(model, withFilters({ showPlain: true }));
    expect(pairs(plain.links)).toContain('travel-overview-vilnius');
    expect(pairs(plain.links)).not.toContain('bitcoin-btc-summary'); // its source page is still hidden
    const sources = filterGraph(model, withFilters({ showPlain: true, showSources: true }));
    expect(pairs(sources.links)).toContain('bitcoin-btc-summary');
  });

  it('hides categories and page types with their lines, and counts what each would show', () => {
    const v = filterGraph(model, withFilters({ hiddenCategories: new Set(['Travel']), hiddenTypes: new Set(['concept']) }));
    expect(ids(v.nodes)).toEqual(['bitcoin', 'eth', 'misc']);
    expect(pairs(v.links)).toEqual(['bitcoin-eth']);
    expect(v.categoryCounts.get('Travel')).toBe(3); // still counted, so the legend can offer it back
    expect(v.categoryCounts.get('Crypto')).toBe(2);
    expect(v.typeCounts.get('concept')).toBe(1);
    expect(v.typeCounts.get('overview')).toBeUndefined(); // only in the hidden category
  });

  it('keeps neighbours and lines per page for the visible graph only', () => {
    const v = filterGraph(model, DEFAULT_FILTERS);
    expect([...v.neighbours.get('bitcoin')!].sort()).toEqual(['eth', 'pow']);
    expect(v.linksOf.get('pow')!.map((l) => l.a + '-' + l.b)).toEqual(['bitcoin-pow']);
    expect(v.neighbours.get('misc')!.size).toBe(0);
    expect(v.neighbours.has('btc-summary')).toBe(false);
  });

  it('ranks pages within their island for overview labels', () => {
    const v = filterGraph(model, DEFAULT_FILTERS);
    expect(v.labelRank.get('bitcoin')).toBe(0);
    expect(v.labelRank.get('misc')).toBe(0);
    expect(new Set(['vilnius', 'kaunas', 'travel-overview'].map((id) => v.labelRank.get(id)))).toEqual(new Set([0, 1, 2]));
  });
});

describe('category colours', () => {
  const counts = (pairsIn: Array<[string, number, number?]>) =>
    pairsIn.map(([name, live, total]) => ({ name, live, total: total ?? live }));

  it('gives the eight biggest categories the palette in order, the rest grey and Uncategorized its own neutral', () => {
    const names = Array.from({ length: 10 }, (_, i) => [`C${i}`, 20 - i] as [string, number]);
    const ranked = rankCategories(counts([[UNCATEGORIZED, 50], ...names]));
    expect(ranked.map((c) => c.name)).toEqual([...names.map(([n]) => n), UNCATEGORIZED]);
    expect(ranked.slice(0, 8).map((c) => c.color)).toEqual([...CATEGORY_HEX]);
    expect(ranked.slice(8).map((c) => c.color)).toEqual([NEUTRAL_HEX, NEUTRAL_HEX, NO_TOPIC_HEX]);
    expect(ranked.filter((c) => c.overflow).map((c) => c.name)).toEqual(['C8', 'C9']);
  });

  it('is stable: the input order never matters, ties go by name, archived pages do not reorder', () => {
    const a = rankCategories(counts([['Travel', 5], ['Crypto', 5], ['AI', 3, 9]]));
    const b = rankCategories(counts([['AI', 3, 9], ['Travel', 5], ['Crypto', 5]]));
    expect(a).toEqual(b);
    expect(a.map((c) => c.name)).toEqual(['Crypto', 'Travel', 'AI']);
  });
});

describe('layout helpers', () => {
  it('edge width is 1 + log2(1 + weight)', () => {
    expect([0, 1, 3, 7].map(edgeWidth)).toEqual([1, 2, 3, 4]);
  });

  it('seeds the same position for the same id', () => {
    const anchor = { x: 100, y: -50 };
    expect(seedPosition('vilnius', anchor, 80)).toEqual(seedPosition('vilnius', anchor, 80));
    expect(seedPosition('vilnius', anchor, 80)).not.toEqual(seedPosition('kaunas', anchor, 80));
  });

  it('puts one category in the middle and several on a ring', () => {
    expect(categoryAnchors([5])).toEqual([{ x: 0, y: 0 }]);
    const ring = categoryAnchors([25, 9, 4]);
    const radii = ring.map((p) => Math.hypot(p.x, p.y));
    expect(radii[1]).toBeCloseTo(radii[0]);
    expect(ring[0].y).toBeLessThan(0); // the first island sits at the top
  });

  it('seats islands that share lines side by side', () => {
    const links: Record<string, number> = { 'A-D': 5, 'B-C': 4, 'C-D': 1 };
    const affinity = (x: string, y: string) => links[`${x}-${y}`] ?? links[`${y}-${x}`] ?? 0;
    const order = ringOrder(['A', 'B', 'C', 'D'], affinity);
    expect(order).toHaveLength(4);
    const next = (x: string, y: string) => [1, order.length - 1].includes(Math.abs(order.indexOf(x) - order.indexOf(y)));
    expect(next('A', 'D') && next('B', 'C') && next('C', 'D')).toBe(true);
    expect(ringOrder(['A', 'B', 'C', 'D'], affinity)).toEqual(order);
  });
});

describe('large graph', () => {
  it('builds and filters 2,000 pages and 10,000 lines within the budget', () => {
    const categories = Array.from({ length: 30 }, (_, i) => `Topic ${i}`);
    const nodes = Array.from({ length: 2000 }, (_, i) =>
      page(`p${i}`, categories[i % 30], i % 7 === 0 ? 'source-summary' : 'entity', { source_count: 1 + (i % 9) })
    );
    const types = ['uses', 'part_of', 'related_to', 'created_by'];
    // Five lines per page, to the pages 37, 74, ... 185 places on: 10,000 distinct pairs.
    const links: RelationEdge[] = [];
    for (let i = 0; i < 2000; i++) {
      for (let d = 1; d <= 5; d++) {
        const [x, y] = [`p${i}`, `p${(i + 37 * d) % 2000}`];
        const [s, t] = x < y ? [x, y] : [y, x];
        const k = i * 5 + d;
        links.push(line(s, t, k % 3 === 0 ? [] : [{ type: types[k % 4], direction: 'out', source_count: 1 + (k % 4) }]));
      }
    }
    const started = performance.now();
    const model = buildGraphModel({ nodes, links, missing: [] });
    const all = filterGraph(model, withFilters({ showSources: true, showRelated: true, showPlain: true }));
    filterGraph(model, DEFAULT_FILTERS);
    const elapsed = performance.now() - started;
    expect(all.nodes).toHaveLength(2000);
    expect(all.links).toHaveLength(10000);
    expect(elapsed).toBeLessThan(1500);
  });
});

describe('empty and sparse data', () => {
  it('builds an empty model from an empty wiki', () => {
    const model = buildGraphModel({ nodes: [], links: [], missing: [] });
    expect(model).toMatchObject({ nodes: [], links: [], categories: [], missing: [] });
    const v = filterGraph(model, DEFAULT_FILTERS);
    expect(v.nodes).toEqual([]);
    expect(v.labelOrder).toEqual([]);
    expect(plainLinksHint(model, v, DEFAULT_FILTERS)).toBe(false);
  });

  it('offers plain links only when nothing is drawn and plain links join shown pages', () => {
    const data: WikiGraph = {
      nodes: [page('a', 'Travel'), page('b', 'Travel'), page('src', 'Travel', 'source-summary')],
      links: [line('a', 'b', []), line('a', 'src', [])],
      missing: [],
    };
    const model = buildGraphModel(data);
    const v = filterGraph(model, DEFAULT_FILTERS);
    expect(v.links).toHaveLength(0);
    expect(plainLinksHint(model, v, DEFAULT_FILTERS)).toBe(true);
    const on = withFilters({ showPlain: true });
    expect(plainLinksHint(model, filterGraph(model, on), on)).toBe(false);
    // The only plain link left goes to a hidden source page: nothing to offer.
    const onlySource = buildGraphModel({ ...data, links: [line('a', 'src', [])] });
    expect(plainLinksHint(onlySource, filterGraph(onlySource, DEFAULT_FILTERS), DEFAULT_FILTERS)).toBe(false);
    // A typed line is drawn: no hint.
    expect(plainLinksHint(buildGraphModel(DATA), filterGraph(buildGraphModel(DATA), DEFAULT_FILTERS), DEFAULT_FILTERS)).toBe(false);
  });
});

describe('fitting into the free area', () => {
  const insets = { left: 268, right: 64, top: 44, bottom: 40 };

  it('fits the box between the legend and the right edge, centred there', () => {
    const view = fitView({ x: [-400, 400], y: [-200, 200] }, 1268, 884, insets);
    expect(view.k).toBeCloseTo(Math.min((1268 - 332) / 800, (884 - 84) / 400));
    // Graph point (0, 0) lands in the middle of the free area, not of the canvas.
    const screenX = 1268 / 2 + (0 - view.x) * view.k;
    const screenY = 884 / 2 + (0 - view.y) * view.k;
    expect(screenX).toBeCloseTo(268 + (1268 - 332) / 2);
    expect(screenY).toBeCloseTo(44 + (884 - 84) / 2);
  });

  it('centres a page in the free area at a given zoom, and caps the zoom', () => {
    const at = centerFor(50, 20, 2, 1000, 800, { left: 0, right: 400, top: 0, bottom: 0 });
    expect(1000 / 2 + (50 - at.x) * 2).toBeCloseTo(300);
    expect(fitView({ x: [0, 1], y: [0, 1] }, 1000, 800, insets).k).toBe(4);
  });
});

describe('zoom buttons', () => {
  const insets = { left: 268, right: 384, top: 44, bottom: 40 };
  const [W, H] = [1600, 900];
  const view = { x: 10, y: -20, k: 1.5 };
  const screen = (v: { x: number; y: number; k: number }, p: { x: number; y: number }) =>
    ({ x: W / 2 + (p.x - v.x) * v.k, y: H / 2 + (p.y - v.y) * v.k });

  it('zooms about the selection while it shows in the free area', () => {
    const selected = { x: 60, y: 0 };
    const about = zoomAnchor(view, W, H, insets, selected);
    expect(about).toBe(selected);
    const next = zoomAround(view, about, view.k * 1.3);
    expect(next.k).toBeCloseTo(1.95);
    const [before, after] = [screen(view, selected), screen(next, selected)];
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("zooms about the free area's middle with no selection, or one off in a covered edge", () => {
    const middle = { x: insets.left + (W - insets.left - insets.right) / 2, y: insets.top + (H - insets.top - insets.bottom) / 2 };
    for (const about of [null, { x: 10 + (1550 - W / 2) / 1.5, y: -20 }]) {
      const p = zoomAnchor(view, W, H, insets, about);
      expect(screen(view, p).x).toBeCloseTo(middle.x);
      expect(screen(view, p).y).toBeCloseTo(middle.y);
      const next = zoomAround(view, p, view.k * 0.77);
      expect(screen(next, p).x).toBeCloseTo(middle.x);
      expect(screen(next, p).y).toBeCloseTo(middle.y);
    }
  });

  it("keeps to force-graph's zoom limits", () => {
    expect(zoomAround(view, { x: 0, y: 0 }, 1e6).k).toBe(ZOOM_MAX);
  });
});
