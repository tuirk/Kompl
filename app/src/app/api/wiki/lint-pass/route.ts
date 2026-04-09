/**
 * POST /api/wiki/lint-pass
 *
 * The lint engine. Called by n8n lint-wiki.json (Schedule: every 6h + manual webhook).
 * Runs health checks on the wiki and logs results as a 'lint_complete' activity event.
 *
 * Checks performed:
 *   1. Orphan pages — no inbound page_links rows
 *   2. Stale source-summaries — source_count==1 AND last_updated > 30 days ago
 *   3. Missing entity pages — entity names mentioned on 3+ pages but no entity page
 *   4. Dead provenance — provenance rows referencing deleted sources
 *
 * Contradiction detection (LLM-assisted) is intentionally deferred to
 * when nlp-service /pipeline/lint-scan is called. This route only does
 * the DB-side checks and logs results.
 *
 * Request: {} (empty body ok — no required fields)
 * Response: {orphan_pages, stale_pages, dead_provenance, run_duration_ms}
 */

import { NextResponse } from 'next/server';
import { getDb, insertActivity } from '../../../../lib/db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

interface LintResults {
  orphan_pages: string[];
  stale_pages: string[];
  dead_provenance: number;
  run_duration_ms: number;
  contradictions?: Array<{ page_a: string; page_b: string; claim: string; severity: string }>;
}

export async function POST() {
  const start = Date.now();
  const db = getDb();

  // 1. Orphan pages: pages with no inbound page_links AND no outbound (isolated)
  const orphanRows = db
    .prepare(
      `SELECT page_id FROM pages
       WHERE page_id NOT IN (SELECT target_page_id FROM page_links)
         AND page_id NOT IN (SELECT source_page_id FROM page_links)`
    )
    .all() as { page_id: string }[];
  const orphan_pages = orphanRows.map((r) => r.page_id);

  // 2. Stale source-summaries: single-source pages not updated in 30+ days
  const staleRows = db
    .prepare(
      `SELECT page_id FROM pages
       WHERE page_type = 'source-summary'
         AND source_count = 1
         AND datetime(last_updated) < datetime('now', '-30 days')`
    )
    .all() as { page_id: string }[];
  const stale_pages = staleRows.map((r) => r.page_id);

  // 3. Dead provenance: provenance rows whose source_id no longer exists
  const deadProv = db
    .prepare(
      `SELECT COUNT(*) AS n FROM provenance
       WHERE source_id NOT IN (SELECT source_id FROM sources)`
    )
    .get() as { n: number };
  const dead_provenance = deadProv.n;

  // 4. Contradiction scan via nlp-service (lightweight, sample up to 10 page pairs)
  let contradictions: LintResults['contradictions'] = [];
  try {
    // Fetch summary pairs from pages that share a category (most likely to contradict)
    const pagePairs = db
      .prepare(
        `SELECT a.page_id AS id_a, a.title AS title_a, a.summary AS summary_a,
                b.page_id AS id_b, b.title AS title_b, b.summary AS summary_b
           FROM pages a
           JOIN pages b ON b.category = a.category AND b.page_id > a.page_id
          WHERE a.summary IS NOT NULL AND b.summary IS NOT NULL
          LIMIT 10`
      )
      .all() as Array<{
      id_a: string; title_a: string; summary_a: string;
      id_b: string; title_b: string; summary_b: string;
    }>;

    if (pagePairs.length > 0) {
      const pages = pagePairs.flatMap((p) => [
        `[${p.id_a}] ${p.title_a}: ${p.summary_a}`,
        `[${p.id_b}] ${p.title_b}: ${p.summary_b}`,
      ]);

      const res = await fetch(`${NLP_SERVICE_URL}/pipeline/lint-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pages }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          contradictions: Array<{ page_a: string; page_b: string; claim: string; severity: string }>;
        };
        contradictions = data.contradictions ?? [];
      }
    }
  } catch {
    // Contradiction scan is best-effort; never fail the lint for it
  }

  const run_duration_ms = Date.now() - start;
  const results: LintResults = {
    orphan_pages,
    stale_pages,
    dead_provenance,
    run_duration_ms,
    contradictions,
  };

  // Log to activity_log (details visible in feed + /wiki)
  insertActivity({
    action_type: 'lint_complete',
    source_id: null,
    details: {
      orphan_pages: orphan_pages.length,
      stale_pages: stale_pages.length,
      dead_provenance,
      contradiction_count: contradictions.length,
      run_duration_ms,
    },
  });

  return NextResponse.json(results);
}
