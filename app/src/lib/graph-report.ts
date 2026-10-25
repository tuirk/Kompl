/**
 * The knowledge graph as MCP wiki_status reports it: topic clusters (the
 * categories on the map's default view, with their pages and the typed
 * lines inside each) and the bridge pages the map badges (graph-bridges.ts).
 * Built from the same payload and model as the graph page, so the report
 * names the same pages. The bridges' betweenness pass runs in a worker
 * thread (graph-worker-node.ts); the database reads stay on this one, the
 * only one holding the database. Reads only; report-only.
 */

import type Database from 'better-sqlite3';
import { crossTopicKernel, type BetweennessJob, type BetweennessRunner } from './graph-betweenness';
import { bridgeWork } from './graph-bridges';
import { UNCATEGORIZED } from './graph-layout';
import { buildGraphModel, DEFAULT_FILTERS, filterGraph } from './graph-model';
import { runInWorkerThread } from './graph-worker-node';
import { getWikiGraph } from './wiki-graph';

/** Clusters listed; the rest are counted. */
export const CLUSTERS_SHOWN = 6;

export interface TopicCluster {
  name: string;
  /** Pages on the default view: no source pages, no archived pages. */
  pages: number;
  /** Default-view lines (typed relations) with both ends in the topic. */
  connections: number;
}

export interface BridgePage {
  page_id: string;
  title: string;
  category: string;
  /** The topics its neighbours belong to, most neighbours first. */
  joins: string[];
}

export interface GraphReport {
  /** "Uncategorized" is no topic and is left out. */
  clusters: { count: number; top: TopicCluster[] };
  bridges: BridgePage[];
}

/** The report read from the database, waiting on the bridges' betweenness pass. */
function readGraphReport(): { job: BetweennessJob; finish(scores: Float64Array): GraphReport } {
  const model = buildGraphModel(getWikiGraph(false));
  const visible = filterGraph(model, DEFAULT_FILTERS);
  const clusters = new Map<string, TopicCluster>();
  for (const n of visible.nodes) {
    if (n.category === UNCATEGORIZED) continue;
    const cluster = clusters.get(n.category) ?? { name: n.category, pages: 0, connections: 0 };
    cluster.pages += 1;
    clusters.set(n.category, cluster);
  }
  for (const l of visible.links) {
    if (!l.sameCategory) continue;
    const cluster = clusters.get(model.byId.get(l.a)?.category ?? UNCATEGORIZED);
    if (cluster) cluster.connections += 1;
  }
  const ranked = [...clusters.values()].sort(
    (x, y) => y.pages - x.pages || y.connections - x.connections || x.name.localeCompare(y.name)
  );
  const work = bridgeWork(model);
  const clusterList = { count: ranked.length, top: ranked.slice(0, CLUSTERS_SHOWN) };
  return {
    job: work.job,
    finish: (scores) => {
      const bridges = [...work.finish(scores).values()].map((b): BridgePage => {
        const node = model.byId.get(b.id);
        return { page_id: b.id, title: node?.label ?? b.id, category: node?.category ?? UNCATEGORIZED, joins: b.topics };
      });
      return { clusters: clusterList, bridges };
    },
  };
}

/** The report with the betweenness pass on this thread (tests and the scale gate). */
export function buildGraphReport(): GraphReport {
  const { job, finish } = readGraphReport();
  return finish(crossTopicKernel(job.start, job.next, job.topic));
}

/** The report with the betweenness pass handed to `run`. */
export async function buildGraphReportWith(run: BetweennessRunner): Promise<GraphReport> {
  const { job, finish } = readGraphReport();
  return finish(await run(job));
}

/**
 * The stamp catches every compile, import and archive; the timer only bounds
 * what it cannot see (an alias re-pinned in place).
 */
const CACHE_MS = 5 * 60_000;
const cache = new WeakMap<Database.Database, { key: string; at: number; report: GraphReport }>();
/** The build under way for a stamp: callers who ask meanwhile wait for it instead of starting another. */
const building = new WeakMap<Database.Database, { key: string; report: Promise<GraphReport> }>();

/**
 * The report for frequent readers (wiki_status): betweenness takes seconds
 * on a large wiki, so it runs in a worker thread (`run`; the app's default),
 * and a result is reused while the rows the graph reads keep their counts
 * and the pages their newest update, as in runHealthChecksCached
 * (wiki-health.ts). A failed build is not kept: the next call tries again.
 */
export async function graphReportCached(
  db: Database.Database, run: BetweennessRunner = runInWorkerThread
): Promise<GraphReport> {
  const { key } = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM pages) || ':' || (SELECT COUNT(*) FROM pages WHERE page_type = 'archived') || ':' ||
              COALESCE((SELECT MAX(last_updated) FROM pages), '') || ':' || (SELECT COUNT(*) FROM page_links) || ':' ||
              (SELECT COUNT(*) FROM relationship_mentions) || ':' || (SELECT COUNT(*) FROM aliases) || ':' ||
              (SELECT COUNT(*) FROM aliases WHERE COALESCE(status, 'active') = 'active') || ':' ||
              (SELECT COUNT(*) FROM provenance) || ':' || (SELECT COUNT(*) FROM sources) || ':' ||
              (SELECT COUNT(*) FROM sources WHERE status = 'archived') AS key`
    )
    .get() as { key: string };
  const hit = cache.get(db);
  if (hit && hit.key === key && Date.now() - hit.at < CACHE_MS) return hit.report;
  const pending = building.get(db);
  if (pending && pending.key === key) return pending.report;
  const report = buildGraphReportWith(run).then((built) => {
    cache.set(db, { key, at: Date.now(), report: built });
    return built;
  });
  building.set(db, { key, report });
  try {
    return await report;
  } finally {
    if (building.get(db)?.report === report) building.delete(db);
  }
}
