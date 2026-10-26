/**
 * GET /api/wiki/status — one read-only snapshot for MCP wiki_status:
 *   - size (getWikiStats) and whether a compile is running;
 *   - what waits for the user: drafts to review, links that failed to import;
 *   - gaps from the plain-read health checks (lib/wiki-health.ts): names
 *     with no page, pages resting on one source, unlinked pages, sources
 *     older than the Settings stale threshold;
 *   - the last health check: since plan 3.6 that is the whole-wiki check's
 *     open findings, two sources disagreeing on a page (lib/claim-check/);
 *     before any run of it, the contradictions an older lint pass logged;
 *   - the knowledge graph's topic clusters and bridge pages, as the map's
 *     default view shows them (lib/graph-report.ts; cached, report-only,
 *     betweenness in a worker thread; left out, and logged, if building it
 *     fails).
 *
 * Never writes, and never calls the LLM or the NLP service.
 */

import { NextResponse } from 'next/server';
import {
  countPendingDrafts,
  getDb,
  getLastLintAt,
  getLastLintResult,
  getRunningCompileSession,
  getStaleSources,
  getStaleThresholdDays,
  getUnresolvedLinks,
  getVectorBacklogCount,
  getWikiStats,
} from '@/lib/db';
import { graphReportCached, type GraphReport } from '@/lib/graph-report';
import { lastWikiCheckAt, wikiCheckFindings } from '@/lib/claim-check/verdicts';
import { normalizeLintResult } from '@/lib/lint-result';
import { getThinPages, MISSING_NAMES_LIMIT, runHealthChecksCached } from '@/lib/wiki-health';

export const dynamic = 'force-dynamic';

/** Items listed per finding; the rest are counted. */
const TOP = 5;

function summary<T, U>(items: T[], pick: (item: T) => U): { count: number; top: U[] } {
  return { count: items.length, top: items.slice(0, TOP).map(pick) };
}

export async function GET() {
  const db = getDb();
  const checks = runHealthChecksCached(db);
  const thresholdDays = getStaleThresholdDays();
  const lastCheck = normalizeLintResult(getLastLintResult());
  const wikiCheckAt = lastWikiCheckAt(db);
  const running = getRunningCompileSession();
  const graph = await graphReport(db);

  return NextResponse.json({
    stats: getWikiStats(),
    compile_running: running,
    pending_drafts: countPendingDrafts(),
    failed_links: summary(getUnresolvedLinks(), (l) => ({
      url: l.source_url,
      title: l.title,
      error: l.error,
      date_attempted: l.date_attempted,
    })),
    vector_backlog: getVectorBacklogCount(),
    stale_sources: {
      threshold_days: thresholdDays,
      ...summary(getStaleSources(thresholdDays), (s) => ({
        source_id: s.source_id,
        title: s.title,
        date_ingested: s.date_ingested,
      })),
    },
    gaps: {
      missing_pages: {
        ...summary(checks.missing_cross_refs, (m) => ({ name: m.entity_text, mentions: m.mention_count })),
        // The check stops counting at its limit: there may be more.
        capped: checks.missing_cross_refs.length >= MISSING_NAMES_LIMIT,
      },
      thin_pages: summary(getThinPages(db), (p) => p),
      orphan_pages: summary(checks.orphan_pages, (p) => p),
      dead_provenance: { count: checks.dead_provenance.length },
    },
    last_health_check: wikiCheckAt
      ? { at: wikiCheckAt, contradictions: summary(wikiCheckFindings(db), (c) => c) }
      : lastCheck
        ? {
            at: getLastLintAt(),
            contradictions: summary(lastCheck.contradictions, (c) => ({
              page_a: c.page_a_title,
              page_b: c.page_b_title,
              claim: c.claim,
            })),
          }
        : null,
    // Left out if the graph report failed: the MCP then reads it as an older app.
    ...(graph ? { clusters: graph.clusters, bridges: graph.bridges } : {}),
  });
}

/** The graph part is an extra: if it fails, the rest of the snapshot still answers. */
async function graphReport(db: ReturnType<typeof getDb>): Promise<GraphReport | null> {
  try {
    return await graphReportCached(db);
  } catch (err) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'wiki_status_graph_report_failed',
        error: err instanceof Error ? err.message : String(err),
      })
    );
    return null;
  }
}
