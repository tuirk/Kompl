/**
 * Graph measures (lib/graph-metrics.ts): Brandes betweenness on small graphs
 * with known values, and the bridge pages picked from it (two or more
 * topics among the neighbours, top 5, stable ties), worked out once per
 * load on the default view (graph-bridges.ts).
 */

import { describe, expect, it } from 'vitest';
import { mapBridges } from '../lib/graph-bridges';
import {
  betweenness, BRIDGE_LIMIT, crossTopicBetweenness, findBridges, pickBridges, topicList, type Adjacency,
} from '../lib/graph-metrics';
import { buildGraphModel, DEFAULT_FILTERS, filterGraph } from '../lib/graph-model';
import type { RelationEdge } from '../lib/relation-edges';
import type { WikiGraph, WikiGraphNode } from '../lib/wiki-graph';

/** An adjacency from undirected edges "a-b", each listed from one end only. */
function graph(nodes: string[], edges: string[]): Map<string, string[]> {
  const adj = new Map(nodes.map((n) => [n, [] as string[]]));
  for (const e of edges) {
    const [a, b] = e.split('-');
    (adj.get(a) as string[]).push(b);
  }
  return adj;
}

const scoresOf = (adj: Adjacency) => Object.fromEntries([...betweenness(adj)].map(([k, v]) => [k, +v.toFixed(6)]));

describe('betweenness', () => {
  it('scores the middle of a path by the pairs it joins', () => {
    // a - b - c - d: b lies between a-c and a-d, c between a-d and b-d.
    expect(scoresOf(graph(['a', 'b', 'c', 'd'], ['a-b', 'b-c', 'c-d']))).toEqual({ a: 0, b: 2, c: 2, d: 0 });
  });

  it('gives a star hub every pair of its leaves', () => {
    const scores = scoresOf(graph(['hub', 'l1', 'l2', 'l3', 'l4'], ['hub-l1', 'hub-l2', 'hub-l3', 'hub-l4']));
    expect(scores.hub).toBe(6); // 4 leaves: C(4,2)
    expect([scores.l1, scores.l2, scores.l3, scores.l4]).toEqual([0, 0, 0, 0]);
  });

  it('finds the bridge between two clusters', () => {
    // Two triangles {a,b,c} and {x,y,z} joined by the path c - m - x.
    const adj = graph(['a', 'b', 'c', 'm', 'x', 'y', 'z'], ['a-b', 'b-c', 'a-c', 'x-y', 'y-z', 'x-z', 'c-m', 'm-x']);
    const scores = scoresOf(adj);
    // m joins each of a,b,c (3) with each of x,y,z (3): 9 pairs; c adds the pairs from a and b to m, x, y, z.
    expect(scores.m).toBe(9);
    expect(scores.c).toBe(8);
    expect(scores.x).toBe(8);
    expect(scores.a).toBe(0);
    expect(scores.y).toBe(0);
  });

  it('splits a pair between equally short routes', () => {
    // A square: a-b-d and a-c-d are both shortest from a to d.
    const scores = scoresOf(graph(['a', 'b', 'c', 'd'], ['a-b', 'a-c', 'b-d', 'c-d']));
    expect(scores).toEqual({ a: 0.5, b: 0.5, c: 0.5, d: 0.5 });
  });

  it('ignores self-loops, repeats, unknown neighbours and listing direction', () => {
    const messy = new Map<string, string[]>([
      ['a', ['b', 'b', 'a', 'ghost']],
      ['b', ['a', 'c']],
      ['c', ['b']],
    ]);
    expect(scoresOf(messy)).toEqual({ a: 0, b: 1, c: 0 });
    expect(scoresOf(new Map())).toEqual({});
    // Disconnected parts score nothing across.
    expect(scoresOf(graph(['a', 'b', 'c', 'd'], ['a-b', 'c-d']))).toEqual({ a: 0, b: 0, c: 0, d: 0 });
  });

  it('scores a 1,500-page graph (3,489 lines) in about half a second', { timeout: 30_000 }, () => {
    const nodes = Array.from({ length: 1500 }, (_, i) => `p${i}`);
    const adj = new Map(nodes.map((n) => [n, [] as string[]]));
    for (let i = 0; i < 1500; i++) {
      for (const j of [i + 1, i + 7, i * 3 + 11]) if (j < 1500) (adj.get(`p${i}`) as string[]).push(`p${j}`);
    }
    // Best of 3, as in scale-heavy-wiki.test.ts: a busy machine stretches single runs, not the best.
    // ~330-500 ms locally (2026-10-23); the budget fails a 3x slowdown, not a slow runner.
    const best = Math.min(
      ...[0, 1, 2].map(() => {
        const start = performance.now();
        betweenness(adj);
        return performance.now() - start;
      })
    );
    expect(best, `best of 3: ${best.toFixed(0)} ms (budget 1500 ms)`).toBeLessThan(1500);
  });
});

describe('bridges', () => {
  const topics: Record<string, string | null> = { a: 'AI', b: 'AI', c: 'AI', m: 'Crypto', x: 'Travel', y: 'Travel', z: 'Travel' };
  const adj = graph(['a', 'b', 'c', 'm', 'x', 'y', 'z'], ['a-b', 'b-c', 'a-c', 'x-y', 'y-z', 'x-z', 'c-m', 'm-x']);
  const topicOf = (id: string) => topics[id] ?? null;

  it('keeps pages whose neighbours span two or more topics, most between first', () => {
    const found = findBridges(adj, topicOf);
    // c's neighbours: a, b (AI) and m (Crypto); m's: c (AI) and x (Travel); x's: y, z (Travel) and m (Crypto).
    expect(found.map((b) => b.id)).toEqual(['m', 'c', 'x']);
    expect(found[0]).toEqual({ id: 'm', score: 9, topics: ['AI', 'Travel'] });
    expect(found[1].topics).toEqual(['AI', 'Crypto']);
  });

  it('leaves out pages whose neighbours share one topic, and topic-less neighbours', () => {
    const allAi = (id: string) => (id === 'x' || id === 'y' || id === 'z' ? null : 'AI');
    // m's neighbours: c (AI) and x (no topic): one topic only.
    expect(findBridges(adj, allAi)).toEqual([]);
  });

  it('skips pages with no betweenness, caps the list and breaks ties by id', () => {
    const scores = new Map([['p1', 3], ['p0', 3], ['p2', 0], ...Array.from({ length: 6 }, (_, i) => [`q${i}`, 1] as [string, number])]);
    const mixed = new Map([...[...scores.keys()].map((id) => [id, ['t1', 't2']] as [string, string[]]), ['t1', []], ['t2', []]]);
    const topicOfMixed = (id: string) => (id === 't1' ? 'One' : id === 't2' ? 'Two' : null);
    const found = pickBridges(scores, mixed, topicOfMixed);
    expect(found).toHaveLength(BRIDGE_LIMIT);
    expect(found.map((b) => b.id)).toEqual(['p0', 'p1', 'q0', 'q1', 'q2']);
    expect(found.some((b) => b.id === 'p2')).toBe(false);
  });

  it('ranks the one page joining two islands above a big hub with one line out', () => {
    // Crypto: "hub" with 20 leaves and one line to "fin" (Finance), which leads nowhere else.
    // Travel and AI: two islands of 6 pages each, joined only through "p" (Travel).
    const leaves = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const travel = Array.from({ length: 6 }, (_, i) => `t${i}`);
    const ai = Array.from({ length: 6 }, (_, i) => `a${i}`);
    const clique = (ids: string[]) => ids.flatMap((x, i) => ids.slice(i + 1).map((y) => `${x}-${y}`));
    const adj = graph(
      ['hub', 'fin', 'p', ...leaves, ...travel, ...ai],
      [...leaves.map((c) => `hub-${c}`), 'hub-fin', ...clique(travel), ...clique(ai), 'p-t0', 'p-a0']
    );
    const topicOf = (id: string) =>
      id === 'fin' ? 'Finance' : id === 'hub' || id.startsWith('c') ? 'Crypto' : id === 'p' || id.startsWith('t') ? 'Travel' : 'AI';
    // Plain betweenness puts the hub far ahead: its leaves' 190 pairs all pass through it.
    const plain = betweenness(adj);
    expect(plain.get('hub')).toBe(210);
    expect(plain.get('p')).toBe(36);
    // Counting only pairs from two different topics: the hub joins 20 (each leaf with fin), p joins 36.
    const found = findBridges(adj, topicOf);
    expect(found.map((b) => [b.id, b.score])).toEqual([['p', 36], ['a0', 35], ['hub', 20]]);
    expect(found[0].topics).toEqual(['AI', 'Travel']);
  });

  it('counts no pair with a topic-less end, but lets paths run through topic-less pages', () => {
    // a (AI) - u (no topic) - x (Travel) - y (no topic)
    const adj = graph(['a', 'u', 'x', 'y'], ['a-u', 'u-x', 'x-y']);
    const topicOf = (id: string) => (id === 'a' ? 'AI' : id === 'x' ? 'Travel' : null);
    expect(Object.fromEntries(crossTopicBetweenness(adj, topicOf))).toEqual({ a: 0, u: 1, x: 0, y: 0 });
  });

  it('lists topics as words', () => {
    expect(topicList([])).toBe('');
    expect(topicList(['AI'])).toBe('AI');
    expect(topicList(['AI', 'Crypto'])).toBe('AI and Crypto');
    expect(topicList(['AI', 'Crypto', 'Travel'])).toBe('AI, Crypto and Travel');
  });
});

describe('mapBridges', () => {
  const node = (id: string, category: string, group = 'entity'): WikiGraphNode =>
    ({ id, label: id, group, category, source_count: 1, summary: null, last_updated: null, degree: 0 });
  const typedLine = (source: string, target: string): RelationEdge =>
    ({ source, target, relations: [{ type: 'uses', direction: 'out', source_count: 1, direction_disputed: false, outdated: false }], wikilink: false, weight: 1 });
  const plainLine = (source: string, target: string): RelationEdge => ({ source, target, relations: [], wikilink: true, weight: 0 });
  // AI triangle and Travel triangle joined by "m" with typed lines; "hub" joins everything with plain links only,
  // and the source page "src" with typed lines (source pages are hidden on the default view).
  const data: WikiGraph = {
    nodes: [
      node('a1', 'AI'), node('a2', 'AI'), node('a3', 'AI'), node('m', 'Crypto'),
      node('t1', 'Travel'), node('t2', 'Travel'), node('t3', 'Travel'), node('hub', 'Misc'), node('src', 'Misc', 'source-summary'),
    ],
    links: [
      typedLine('a1', 'a2'), typedLine('a2', 'a3'), typedLine('a1', 'a3'), typedLine('a3', 'm'), typedLine('m', 't1'),
      typedLine('t1', 't2'), typedLine('t2', 't3'), typedLine('t1', 't3'),
      ...['a1', 'a2', 't2', 't3'].map((id) => plainLine('hub', id)),
      ...['a1', 't3'].map((id) => typedLine('src', id)),
    ],
    missing: [],
  };

  it('comes from the default view: typed lines, source pages hidden', () => {
    const bridges = mapBridges(buildGraphModel(data));
    expect([...bridges.keys()]).toEqual(['m', 'a3', 't1']);
    expect(bridges.has('hub')).toBe(false);
    expect(bridges.has('src')).toBe(false);
    expect(bridges.get('m')?.topics).toEqual(['AI', 'Travel']);
  });

  it('leaves archived pages out, so "include archived" changes no badge', () => {
    // "old" (archived) would join the AI and Travel triangles a second time.
    const withArchived: WikiGraph = {
      ...data,
      nodes: [...data.nodes, { ...node('old', 'Crypto'), archived: true }],
      links: [...data.links, typedLine('a1', 'old'), typedLine('old', 't3')],
    };
    const bridges = mapBridges(buildGraphModel(withArchived));
    expect(bridges.has('old')).toBe(false);
    expect([...bridges.values()]).toEqual([...mapBridges(buildGraphModel(data)).values()]);
  });

  it('is the same whatever the legend later shows', () => {
    const model = buildGraphModel(data);
    const first = mapBridges(model);
    const allOn = filterGraph(model, { ...DEFAULT_FILTERS, showPlain: true, showRelated: true, showSources: true });
    expect(allOn.neighbours.get('hub')?.size).toBe(4); // the legend would change betweenness...
    expect([...mapBridges(model).keys()]).toEqual([...first.keys()]); // ...but the badges come from the default view
  });
});
