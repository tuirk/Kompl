/**
 * Scale gate for the knowledge graph: a heavy wiki (helpers/heavy-wiki.ts:
 * ~800 sources, ~1,500 pages, 8,000 relation rows, 6,000 wikilinks) must keep
 * the boot backfill, the page view's connections, the graph payload and the
 * graph model fast. Budgets sit far above the measured local times (slow CI
 * runners), so only an order-of-magnitude regression fails; each assertion
 * message carries the measured time, and afterAll prints one summary line.
 *
 * "cold" = the first call after the archived-pages cache (db.ts, 30 s) is
 * dropped, as a request pays it after a quiet spell; p50/p95 = 20 warm calls.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as getConnectionsRoute } from '../app/api/wiki/[page_id]/connections/route';
import { GET as getDataRoute } from '../app/api/wiki/[page_id]/data/route';
import { setSourceStatus } from '../lib/db';
import { findBridges } from '../lib/graph-metrics';
import { buildMissingLayer, withMissing } from '../lib/graph-missing';
import { buildGraphModel, DEFAULT_FILTERS, filterGraph, type GraphFilters } from '../lib/graph-model';
import { shortestPath } from '../lib/graph-path';
import { focusGraph } from '../lib/graph-scope';
import { backfillRelationDescriptions } from '../lib/relation-backfill';
import { getPageConnections, getRelationEdges } from '../lib/relations';
import { getWikiGraph } from '../lib/wiki-graph';
import { HEAVY, seedHeavyWiki, type HeavyWiki } from './helpers/heavy-wiki';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

/**
 * Budgets in ms: about 10x the local time inside the full parallel suite,
 * where runs are 2-3x slower than this file alone (2026-10-16; alone /
 * full suite, worst run, in comments). Payload sizes are deterministic, so
 * their budgets are tighter (~1.5x).
 */
const BUDGET = {
  backfill: 3000, // ~95 / ~320
  backfillRerun: 3000, // ~70 / ~220
  pageViewCold: 750, // <= ~35 / ~75
  pageViewP95: 750, // <= ~31 / ~85
  pageBytes: 300_000, // ~197 KB (data route), ~178 KB (connections)
  graphCold: 2500, // ~290 / ~120
  graphP95: 2500, // ~190 / ~170
  graphBytes: 2_700_000, // ~1.64 MB, ~1.81 MB with archived pages
  edgesP95: 1500, // ~130 / ~150
  modelP95: 500, // ~55 / ~21
  filterP95: 150, // <= ~12 / ~4
  bridges: 3000, // ~340 alone: betweenness + bridges with every toggle on (1,490 pages, 8,782 lines)
  explore: 300, // ~18 alone: a path across the map, a 2-hop focus on the busiest page, the missing names
} as const;
/** Warm runs for the slower explore measures (betweenness is O(pages x lines)). */
const EXPLORE_RUNS = 5;
const RUNS = 20;

let handle: TestDbHandle;
let wiki: HeavyWiki;
let archivedSourceId: string;
const summary: string[] = [];

/** Drop db.ts's archived-pages cache: setting an archived source archived again resets it. */
const dropArchivedCache = () => setSourceStatus(archivedSourceId, 'archived');

function timed<T>(fn: () => T): { ms: number; value: T } {
  const t0 = performance.now();
  const value = fn();
  return { ms: performance.now() - t0, value };
}

async function timedAsync<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = performance.now();
  const value = await fn();
  return { ms: performance.now() - t0, value };
}

function percentiles(samples: number[]): { p50: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return { p50: at(0.5), p95: at(0.95) };
}

/** cold call, then RUNS warm calls; records and returns the numbers. */
function profile(label: string, fn: () => unknown): { cold: number; p50: number; p95: number } {
  dropArchivedCache();
  const cold = timed(fn).ms;
  const samples = Array.from({ length: RUNS }, () => timed(fn).ms);
  const { p50, p95 } = percentiles(samples);
  summary.push(`${label} cold=${cold.toFixed(1)} p50=${p50.toFixed(1)} p95=${p95.toFixed(1)}`);
  return { cold, p50, p95 };
}

const fmt = (label: string, ms: number, budget: number) => `${label}: ${ms.toFixed(1)} ms (budget ${budget} ms)`;

beforeAll(() => {
  handle = setupTestDb();
  const seeded = timed(() => seedHeavyWiki(handle.db));
  wiki = seeded.value;
  archivedSourceId = (handle.db.prepare(`SELECT source_id FROM sources WHERE status = 'archived' LIMIT 1`).get() as { source_id: string }).source_id;
  summary.push(`seed=${seeded.ms.toFixed(0)}ms busiest=${wiki.busiestRows}rows median=${wiki.medianRows}rows`);
}, 120_000);

afterAll(() => {
  console.log(`[scale-heavy-wiki] ${summary.join(' | ')}`);
  handle?.cleanup();
});

// beforeAll seeds once; each test then makes many timed calls. CI runners are
// slower than a dev machine, so the per-test timeout sits well above vitest's
// 5 s default (the budgets inside are what guard performance).
describe('heavy wiki scale', { timeout: 60_000 }, () => {
  it('seeds the intended shape', () => {
    const count = (sql: string) => (handle.db.prepare(sql).get() as { n: number }).n;
    expect(count('SELECT COUNT(*) AS n FROM sources')).toBe(HEAVY.sources);
    expect(count(`SELECT COUNT(*) AS n FROM sources WHERE status = 'archived'`)).toBe(40);
    expect(count('SELECT COUNT(*) AS n FROM pages')).toBeGreaterThanOrEqual(1490);
    expect(count(`SELECT COUNT(DISTINCT page_type) AS n FROM pages`)).toBe(7);
    expect(count(`SELECT COUNT(DISTINCT category) AS n FROM pages`)).toBe(12);
    expect(count('SELECT COUNT(*) AS n FROM relationship_mentions')).toBe(HEAVY.relations);
    expect(count(`SELECT COUNT(*) AS n FROM page_links WHERE link_type = 'wikilink' AND source_page_id != 'saved-links'`)).toBe(HEAVY.wikilinks);
    expect(count('SELECT COUNT(*) AS n FROM aliases')).toBe(400);
    expect(count('SELECT COUNT(*) AS n FROM extractions')).toBe(HEAVY.sources);
    const nulls = count('SELECT COUNT(*) AS n FROM relationship_mentions WHERE description IS NULL');
    expect(nulls / HEAVY.relations).toBeGreaterThan(0.35);
    expect(nulls / HEAVY.relations).toBeLessThan(0.45);
    expect(wiki.busiestRows).toBeGreaterThan(200);
  });

  it('backfills descriptions once, then fills nothing', () => {
    const first = timed(() => backfillRelationDescriptions(handle.db));
    const second = timed(() => backfillRelationDescriptions(handle.db));
    summary.push(`backfill=${first.ms.toFixed(1)}ms filled=${first.value.filled}/${wiki.fillable} unmatched=${first.value.unmatched} rerun=${second.ms.toFixed(1)}ms`);
    expect(first.value.filled).toBeGreaterThanOrEqual(Math.floor(wiki.fillable * 0.95));
    expect(first.value.filled).toBeLessThanOrEqual(wiki.fillable);
    expect(second.value).toEqual({ filled: 0, unmatched: first.value.unmatched });
    expect(first.ms, fmt('backfill', first.ms, BUDGET.backfill)).toBeLessThan(BUDGET.backfill);
    expect(second.ms, fmt('backfill rerun', second.ms, BUDGET.backfillRerun)).toBeLessThan(BUDGET.backfillRerun);
  });

  it('builds the connections of the busiest and the median page fast', () => {
    for (const [label, pageId] of [['connections.busiest', wiki.busiestPageId], ['connections.median', wiki.medianPageId]] as const) {
      const result = getPageConnections(pageId);
      expect(result.groups.length).toBeGreaterThan(0);
      const { cold, p95 } = profile(label, () => getPageConnections(pageId));
      expect(cold, fmt(`${label} cold`, cold, BUDGET.pageViewCold)).toBeLessThan(BUDGET.pageViewCold);
      expect(p95, fmt(`${label} p95`, p95, BUDGET.pageViewP95)).toBeLessThan(BUDGET.pageViewP95);
    }
  });

  it('serves the data and connections routes for the busiest page fast', async () => {
    const params = () => ({ params: Promise.resolve({ page_id: wiki.busiestPageId }) });
    const routes = [
      ['route.data', () => getDataRoute(new Request('http://test/data'), params())],
      ['route.connections', () => getConnectionsRoute(new Request('http://test/connections'), params())],
    ] as const;
    for (const [label, call] of routes) {
      dropArchivedCache();
      const cold = await timedAsync(async () => (await call()).text());
      const samples: number[] = [];
      for (let k = 0; k < RUNS; k++) samples.push((await timedAsync(async () => (await call()).text())).ms);
      const { p50, p95 } = percentiles(samples);
      summary.push(`${label} cold=${cold.ms.toFixed(1)} p50=${p50.toFixed(1)} p95=${p95.toFixed(1)} bytes=${cold.value.length}`);
      expect(JSON.parse(cold.value)).toHaveProperty(label === 'route.data' ? 'connections.groups' : 'groups');
      expect(cold.ms, fmt(`${label} cold`, cold.ms, BUDGET.pageViewCold)).toBeLessThan(BUDGET.pageViewCold);
      expect(p95, fmt(`${label} p95`, p95, BUDGET.pageViewP95)).toBeLessThan(BUDGET.pageViewP95);
      expect(cold.value.length, `${label}: ${cold.value.length} bytes (budget ${BUDGET.pageBytes})`).toBeLessThan(BUDGET.pageBytes);
    }
  });

  it('builds the relation edges fast', () => {
    const { value } = timed(() => getRelationEdges());
    expect(value.edges.length).toBeGreaterThan(1000);
    expect(value.missing.length).toBeLessThanOrEqual(40);
    const { p95 } = profile('edges', () => getRelationEdges());
    expect(p95, fmt('getRelationEdges p95', p95, BUDGET.edgesP95)).toBeLessThan(BUDGET.edgesP95);
  });

  it('builds the graph payload fast and keeps it small, default and with archived pages', () => {
    for (const includeArchived of [false, true]) {
      const label = includeArchived ? 'graph.archived' : 'graph.default';
      const bytes = JSON.stringify(getWikiGraph(includeArchived)).length;
      const { cold, p95 } = profile(`${label} bytes=${bytes}`, () => getWikiGraph(includeArchived));
      expect(cold, fmt(`${label} cold`, cold, BUDGET.graphCold)).toBeLessThan(BUDGET.graphCold);
      expect(p95, fmt(`${label} p95`, p95, BUDGET.graphP95)).toBeLessThan(BUDGET.graphP95);
      expect(bytes, `${label}: ${bytes} bytes (budget ${BUDGET.graphBytes})`).toBeLessThan(BUDGET.graphBytes);
    }
  });

  it('builds and filters the graph model fast, default toggles and all on', () => {
    const allOn: GraphFilters = { ...DEFAULT_FILTERS, showSources: true, showRelated: true, showPlain: true };
    for (const includeArchived of [false, true]) {
      // The page parses the JSON it fetched; build from the same shape.
      const payload = JSON.parse(JSON.stringify(getWikiGraph(includeArchived)));
      const tag = includeArchived ? 'archived' : 'default';
      const build = profile(`model.build.${tag}`, () => buildGraphModel(payload));
      expect(build.p95, fmt(`buildGraphModel ${tag} p95`, build.p95, BUDGET.modelP95)).toBeLessThan(BUDGET.modelP95);
      const model = buildGraphModel(payload);
      for (const [name, filters] of [['default', DEFAULT_FILTERS], ['allOn', allOn]] as const) {
        const visible = filterGraph(model, filters);
        expect(visible.nodes.length).toBeGreaterThan(0);
        const run = profile(`model.filter.${tag}.${name} nodes=${visible.nodes.length} links=${visible.links.length}`, () => filterGraph(model, filters));
        expect(run.p95, fmt(`filterGraph ${tag}/${name} p95`, run.p95, BUDGET.filterP95)).toBeLessThan(BUDGET.filterP95);
      }
    }
  });

  it('finds bridges, paths and focus views fast with every toggle on', () => {
    const allOn: GraphFilters = { ...DEFAULT_FILTERS, showSources: true, showRelated: true, showPlain: true };
    const model = buildGraphModel(JSON.parse(JSON.stringify(getWikiGraph(true))));
    const visible = filterGraph(model, allOn);
    const topicOf = (id: string) => model.byId.get(id)?.category ?? null;
    const runs = (fn: () => unknown) => Array.from({ length: EXPLORE_RUNS }, () => timed(fn).ms);
    const worst = (fn: () => unknown) => Math.max(...runs(fn));

    const bridges = findBridges(visible.neighbours, topicOf);
    expect(bridges.length).toBeGreaterThan(0);
    const bridgeRuns = runs(() => findBridges(visible.neighbours, topicOf));
    const bridgeMs = Math.max(...bridgeRuns);
    summary.push(`bridges nodes=${visible.nodes.length} links=${visible.links.length} best=${Math.min(...bridgeRuns).toFixed(1)} worst=${bridgeMs.toFixed(1)}`);
    expect(bridgeMs, fmt('findBridges all-on worst', bridgeMs, BUDGET.bridges)).toBeLessThan(BUDGET.bridges);

    const busiest = [...visible.linksOf].sort((x, y) => y[1].length - x[1].length)[0][0];
    const far = visible.nodes[visible.nodes.length - 1].id;
    const layer = buildMissingLayer(model);
    const exploreMs = worst(() => {
      shortestPath(visible, busiest, far);
      withMissing(focusGraph(model, allOn, visible, busiest, 2), layer);
    });
    summary.push(`explore busiest=${visible.linksOf.get(busiest)?.length}lines worst=${exploreMs.toFixed(1)}`);
    expect(exploreMs, fmt('path + focus + missing worst', exploreMs, BUDGET.explore)).toBeLessThan(BUDGET.explore);
  });
});
