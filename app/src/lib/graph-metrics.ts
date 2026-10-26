/**
 * Measures over the knowledge graph's pages and lines: betweenness
 * centrality (how often a page lies on the shortest way between two others)
 * and the "bridge" pages: those whose neighbours span two or more topics,
 * ranked by betweenness counted only over pairs of pages in two different
 * topics, so a hub that is busy inside its own topic does not outrank the
 * page that joins two. Pure, with no DOM or DB imports, so the graph page
 * and server code (the MCP wiki_status report) share it; the pass itself
 * (graph-betweenness.ts) can also run in a worker.
 */

import { crossTopicKernel, type BetweennessJob } from './graph-betweenness';

/**
 * Neighbours of every node. Edges are undirected: listing one from either
 * end is enough. Neighbours that are not keys are ignored, as are self-loops
 * and repeats. A VisibleGraph's `neighbours` fits.
 */
export type Adjacency = ReadonlyMap<string, Iterable<string>>;

/** Bridges shown on the map and listed by wiki_status. */
export const BRIDGE_LIMIT = 5;
/** Topics a page's neighbours must span to count as a bridge. */
export const BRIDGE_MIN_TOPICS = 2;

export interface Bridge {
  id: string;
  /** Its betweenness over pairs of pages in two different topics. */
  score: number;
  /** The topics its neighbours belong to, most neighbours first (then A-Z). */
  topics: string[];
}

const compareIds = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/** Nodes in id order with compact, symmetric, de-duplicated neighbour lists (CSR). */
function compact(adjacency: Adjacency): { ids: string[]; start: Int32Array; next: Int32Array } {
  const ids = [...adjacency.keys()].sort(compareIds);
  const index = new Map(ids.map((id, i) => [id, i]));
  const sets: Array<Set<number>> = ids.map(() => new Set());
  ids.forEach((id, i) => {
    for (const other of adjacency.get(id) ?? []) {
      const j = index.get(other);
      if (j === undefined || j === i) continue;
      sets[i].add(j);
      sets[j].add(i);
    }
  });
  const start = new Int32Array(ids.length + 1);
  sets.forEach((s, i) => {
    start[i + 1] = start[i] + s.size;
  });
  const next = new Int32Array(start[ids.length]);
  sets.forEach((s, i) => {
    next.set([...s].sort((x, y) => x - y), start[i]);
  });
  return { ids, start, next };
}

/**
 * Betweenness centrality (Brandes 2001), unweighted and undirected: for each
 * node, the sum over pairs of other nodes of the share of their shortest
 * paths that pass through it. Each unordered pair counts once, so the middle
 * of a three-node path scores 1 and the hub of a star with k leaves scores
 * k(k-1)/2. O(nodes x lines): the cross-topic pass with every node its own topic.
 */
export function betweenness(adjacency: Adjacency): Map<string, number> {
  const { ids, start, next } = compact(adjacency);
  return scoresById(ids, crossTopicKernel(start, next, Int32Array.from(ids, (_, i) => i)));
}

/** A cross-topic pass (graph-betweenness.ts) plus the page id of each node it numbers. */
export interface BridgeJob extends BetweennessJob {
  ids: string[];
}

/** The pass for a graph: its CSR arrays and topic numbers (-1 where topicOf gives null). */
export function bridgeJob(adjacency: Adjacency, topicOf: (id: string) => string | null): BridgeJob {
  const { ids, start, next } = compact(adjacency);
  const numbers = new Map<string, number>();
  const topic = Int32Array.from(ids, (id) => {
    const name = topicOf(id);
    if (name === null) return -1;
    if (!numbers.has(name)) numbers.set(name, numbers.size);
    return numbers.get(name) as number;
  });
  return { ids, start, next, topic };
}

/** A pass's scores keyed by page id. */
export function scoresById(ids: readonly string[], scores: Float64Array): Map<string, number> {
  return new Map(ids.map((id, i) => [id, scores[i]]));
}

/**
 * Betweenness over pairs of pages in two different topics only: a page
 * with no topic ends no counted pair, but shortest ways may pass through it.
 */
export function crossTopicBetweenness(adjacency: Adjacency, topicOf: (id: string) => string | null): Map<string, number> {
  const job = bridgeJob(adjacency, topicOf);
  return scoresById(job.ids, crossTopicKernel(job.start, job.next, job.topic));
}

/**
 * The bridge pages: the highest scores (above 0) among nodes whose
 * neighbours span at least BRIDGE_MIN_TOPICS topics. `topicOf` returns
 * null for a node with no topic (e.g. "Uncategorized"), which then counts
 * toward none. Ties go to the lower id.
 */
export function pickBridges(
  scores: ReadonlyMap<string, number>, adjacency: Adjacency, topicOf: (id: string) => string | null, limit = BRIDGE_LIMIT
): Bridge[] {
  // Both ends of every edge, as betweenness() reads them.
  const around = new Map<string, Set<string>>([...adjacency.keys()].map((id) => [id, new Set<string>()]));
  for (const [id, others] of adjacency) {
    for (const other of others) {
      if (other === id || !around.has(other)) continue;
      (around.get(id) as Set<string>).add(other);
      (around.get(other) as Set<string>).add(id);
    }
  }
  const found: Bridge[] = [];
  for (const [id, score] of scores) {
    if (!(score > 0)) continue;
    const counts = new Map<string, number>();
    for (const other of around.get(id) ?? []) {
      const topic = topicOf(other);
      if (topic !== null) counts.set(topic, (counts.get(topic) ?? 0) + 1);
    }
    if (counts.size < BRIDGE_MIN_TOPICS) continue;
    const topics = [...counts].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([t]) => t);
    found.push({ id, score, topics });
  }
  return found.sort((x, y) => y.score - x.score || compareIds(x.id, y.id)).slice(0, limit);
}

/** A bridge's topics as words: "AI", "AI and Crypto", "AI, Crypto and Travel". */
export function topicList(topics: readonly string[]): string {
  if (topics.length < 2) return topics[0] ?? '';
  return `${topics.slice(0, -1).join(', ')} and ${topics[topics.length - 1]}`;
}

/** crossTopicBetweenness() then pickBridges(): the bridge pages of a graph. */
export function findBridges(adjacency: Adjacency, topicOf: (id: string) => string | null, limit = BRIDGE_LIMIT): Bridge[] {
  return pickBridges(crossTopicBetweenness(adjacency, topicOf), adjacency, topicOf, limit);
}
