/**
 * The knowledge graph's bridge pages (graph-metrics.ts) as the map shows
 * them: worked out once per load on the default view (typed relations
 * only, source pages hidden) and over live pages only, so the badges stay
 * put while the legend or "include archived" is toggled, and a report over
 * the same payload (the MCP wiki_status) lists the same pages.
 * "Uncategorized" is no topic. The betweenness pass can run elsewhere (a
 * worker): bridgeWork() hands it out and reads its scores back. Pure; no
 * DOM or DB imports.
 */

import { crossTopicKernel } from './graph-betweenness';
import { UNCATEGORIZED } from './graph-layout';
import { bridgeJob, pickBridges, scoresById, type Bridge, type BridgeJob } from './graph-metrics';
import { DEFAULT_FILTERS, filterGraph, type GraphModel } from './graph-model';

export interface BridgeWork {
  /** The betweenness pass to run. */
  job: BridgeJob;
  /** The bridges, from the pass's scores. */
  finish(scores: Float64Array): Map<string, Bridge>;
}

export function bridgeWork(model: GraphModel): BridgeWork {
  const base = filterGraph(model, DEFAULT_FILTERS);
  // Archived pages never take part: their ids drop out of every neighbour list too.
  const live = new Map([...base.neighbours].filter(([id]) => model.byId.get(id)?.archived !== true));
  const topicOf = (id: string) => {
    const category = model.byId.get(id)?.category;
    return category === undefined || category === UNCATEGORIZED ? null : category;
  };
  const job = bridgeJob(live, topicOf);
  return {
    job,
    finish: (scores) => new Map(pickBridges(scoresById(job.ids, scores), live, topicOf).map((b) => [b.id, b])),
  };
}

/** The bridges, worked out on this thread. */
export function mapBridges(model: GraphModel): Map<string, Bridge> {
  const { job, finish } = bridgeWork(model);
  return finish(crossTopicKernel(job.start, job.next, job.topic));
}
