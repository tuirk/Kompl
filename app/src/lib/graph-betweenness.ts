/**
 * The betweenness pass behind the knowledge graph's bridge pages
 * (graph-metrics.ts), over compact neighbour lists (CSR). Kept apart and
 * self-contained so it can run off the main thread: the map hands it to a
 * Web Worker and wiki_status to a worker thread, both built from its source
 * text (graph-worker-browser.ts, graph-worker-node.ts). No imports.
 */

/** One betweenness pass: neighbours as CSR (node i's are next[start[i] .. start[i + 1])) and each node's topic. */
export interface BetweennessJob {
  start: Int32Array;
  next: Int32Array;
  /** A topic number per node; -1 for none. */
  topic: Int32Array;
}

/** Runs a pass, here or in a worker. */
export type BetweennessRunner = (job: BetweennessJob) => Promise<Float64Array>;

/**
 * Betweenness restricted to pairs whose two ends have different topics
 * (source-target restricted, Brandes 2008): for each node, the sum over
 * such pairs of the share of their shortest paths that pass through it.
 * Pairs with a topic-less end count for nothing, but paths may run through
 * topic-less nodes. Each unordered pair counts once. Giving every node a
 * topic of its own counts every pair: plain betweenness (Brandes 2001).
 * O(topic nodes x lines); nothing is allocated per source.
 *
 * Reads nothing outside itself: the workers run it from its source text.
 */
export function crossTopicKernel(start: Int32Array, next: Int32Array, topic: Int32Array): Float64Array {
  const n = topic.length;
  const score = new Float64Array(n);
  const sigma = new Float64Array(n);
  const delta = new Float64Array(n);
  const dist = new Int32Array(n).fill(-1);
  const order = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    const own = topic[s];
    if (own < 0) continue; // no pair starts here
    sigma[s] = 1;
    dist[s] = 0;
    order[0] = s;
    // Breadth-first from s; `order` doubles as the queue and, read backwards, the stack.
    let head = 0;
    let tail = 1;
    while (head < tail) {
      const v = order[head++];
      for (let e = start[v]; e < start[v + 1]; e++) {
        const w = next[e];
        if (dist[w] < 0) {
          dist[w] = dist[v] + 1;
          order[tail++] = w;
        }
        if (dist[w] === dist[v] + 1) sigma[w] += sigma[v];
      }
    }
    for (let i = tail - 1; i > 0; i--) {
      const w = order[i];
      const target = topic[w] >= 0 && topic[w] !== own ? 1 : 0;
      const share = (target + delta[w]) / sigma[w];
      for (let e = start[w]; e < start[w + 1]; e++) {
        const v = next[e];
        if (dist[v] === dist[w] - 1) delta[v] += sigma[v] * share;
      }
      score[w] += delta[w];
    }
    // Reset only what this source reached, ready for the next.
    for (let i = 0; i < tail; i++) {
      const v = order[i];
      sigma[v] = 0;
      delta[v] = 0;
      dist[v] = -1;
    }
  }
  // Every pair was counted from both of its ends.
  for (let i = 0; i < n; i++) score[i] /= 2;
  return score;
}

/** Runs the pass on this thread: tests, and wherever no worker can start. */
export const runHere: BetweennessRunner = (job) => Promise.resolve(crossTopicKernel(job.start, job.next, job.topic));

/** The pass as a function expression, for a worker to evaluate. */
export const KERNEL_SOURCE = `(${crossTopicKernel.toString()})`;
