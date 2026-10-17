/**
 * The knowledge graph's bridge pages (graph-metrics.ts) as the map shows
 * them: worked out once per load on the default view (typed relations
 * only, source pages hidden), so the badges stay put while the legend is
 * toggled and a report over the same payload (the MCP wiki_status) can list
 * the same pages. "Uncategorized" is no topic. Pure; no DOM or DB imports.
 */

import { UNCATEGORIZED } from './graph-layout';
import { findBridges, type Bridge } from './graph-metrics';
import { DEFAULT_FILTERS, filterGraph, type GraphModel } from './graph-model';

export function mapBridges(model: GraphModel): Map<string, Bridge> {
  const base = filterGraph(model, DEFAULT_FILTERS);
  const topicOf = (id: string) => {
    const category = model.byId.get(id)?.category;
    return category === undefined || category === UNCATEGORIZED ? null : category;
  };
  return new Map(findBridges(base.neighbours, topicOf).map((b) => [b.id, b]));
}
