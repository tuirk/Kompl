/**
 * POST /api/wiki/lint-pass
 *
 * The lint engine. Callable from /settings "Run Now" and the 36h kompl start
 * startup hook (cli/src/startup-tasks.ts).
 *
 * Checks performed:
 *   1. Orphan pages — no inbound or outbound page_links
 *   2. Stale source-summaries — source_count==1 AND last_updated > 30 days ago
 *   3. Missing cross-refs — entity names in extractions.ner_output mentioned across
 *      3+ sources but with no entity page in pages and no alias in aliases
 *   4. Dead provenance — provenance rows referencing deleted sources
 *   5. Contradiction detection (LLM-assisted, best-effort) via nlp-service
 *
 * Scheduled callers respect the lint_enabled setting.
 * Pass { manual: true } in the request body to bypass that guard.
 *
 * Request: {} | { manual?: boolean }
 * Response: LintResult (+ skipped?: true when lint_enabled=false and manual≠true)
 */

import { NextResponse } from 'next/server';
import { getCompileModel, getDb, logActivity, getLintEnabled, setLastLintAt } from '../../../../lib/db';
import { regenerateSavedLinksPage } from '../../../../lib/saved-links';
import type {
  LintContradiction,
  LintDeadProvenance,
  LintMissingCrossRef,
  LintOrphanPage,
  LintResult,
  LintStalePage,
} from '../../../../lib/lint-result';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

type LintResults = LintResult & { skipped?: true };

function enrichContradictions(
  raw: Array<{ page_a: string; page_b: string; claim: string; severity: string }>,
  titleById: Map<string, string>,
  db: ReturnType<typeof getDb>,
): LintContradiction[] {
  const missing = new Set<string>();
  for (const c of raw) {
    if (c.page_a && !titleById.has(c.page_a)) missing.add(c.page_a);
    if (c.page_b && !titleById.has(c.page_b)) missing.add(c.page_b);
  }
  if (missing.size > 0) {
    const placeholders = [...missing].map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT page_id, title FROM pages WHERE page_id IN (${placeholders})`)
      .all(...missing) as Array<{ page_id: string; title: string }>;
    for (const row of rows) {
      titleById.set(row.page_id, row.title);
    }
  }

  const out: LintContradiction[] = [];
  for (const c of raw) {
    if (!c.page_a || !c.page_b || !c.claim) continue;
    const page_a_title = titleById.get(c.page_a) ?? c.page_a;
    const page_b_title = titleById.get(c.page_b) ?? c.page_b;
    out.push({
      page_a_id: c.page_a,
      page_a_title,
      page_b_id: c.page_b,
      page_b_title,
      claim: c.claim,
      severity: c.severity ?? 'minor',
    });
  }
  return out;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { manual?: boolean };
  const isManual = body.manual === true;

  if (!isManual && !getLintEnabled()) {
    return NextResponse.json({ skipped: true } satisfies Partial<LintResults>);
  }

  const start = Date.now();
  const db = getDb();

  const orphan_pages = db
    .prepare(
      `SELECT p.page_id, p.title
         FROM pages p
        WHERE p.page_id NOT IN (SELECT target_page_id FROM page_links)
          AND p.page_id NOT IN (SELECT source_page_id FROM page_links)
        ORDER BY p.title COLLATE NOCASE`,
    )
    .all() as LintOrphanPage[];

  const stale_pages = db
    .prepare(
      `SELECT page_id, title, last_updated
         FROM pages
        WHERE page_type = 'source-summary'
          AND source_count = 1
          AND datetime(last_updated) < datetime('now', '-30 days')
        ORDER BY last_updated ASC`,
    )
    .all() as LintStalePage[];

  const missing_cross_refs = db
    .prepare(
      `SELECT json_extract(value, '$.text') AS entity_text,
              COUNT(DISTINCT e.source_id) AS mention_count
         FROM extractions e, json_each(json_extract(e.ner_output, '$.entities'))
        WHERE json_extract(value, '$.text') NOT IN (
                SELECT title FROM pages WHERE page_type = 'entity'
              )
          AND json_extract(value, '$.text') NOT IN (
                SELECT alias FROM aliases WHERE canonical_page_id IS NOT NULL
              )
        GROUP BY entity_text
       HAVING COUNT(DISTINCT e.source_id) >= 3
        ORDER BY mention_count DESC
        LIMIT 50`,
    )
    .all() as LintMissingCrossRef[];

  const dead_provenance = db
    .prepare(
      `SELECT pr.id AS provenance_id,
              pr.source_id,
              pr.page_id,
              COALESCE(pg.title, pr.page_id) AS page_title
         FROM provenance pr
         LEFT JOIN pages pg ON pg.page_id = pr.page_id
        WHERE pr.source_id NOT IN (SELECT source_id FROM sources)
        ORDER BY page_title COLLATE NOCASE, pr.source_id`,
    )
    .all() as LintDeadProvenance[];

  let contradictions: LintContradiction[] = [];
  try {
    const pagePairs = db
      .prepare(
        `SELECT a.page_id AS id_a, a.title AS title_a, a.summary AS summary_a,
                b.page_id AS id_b, b.title AS title_b, b.summary AS summary_b
           FROM pages a
           JOIN pages b ON b.category = a.category AND b.page_id > a.page_id
          WHERE a.summary IS NOT NULL AND b.summary IS NOT NULL
          LIMIT 10`,
      )
      .all() as Array<{
      id_a: string; title_a: string; summary_a: string;
      id_b: string; title_b: string; summary_b: string;
    }>;

    if (pagePairs.length > 0) {
      const titleById = new Map<string, string>();
      for (const p of pagePairs) {
        titleById.set(p.id_a, p.title_a);
        titleById.set(p.id_b, p.title_b);
      }

      const pages = pagePairs.flatMap((p) => [
        `[${p.id_a}] ${p.title_a}: ${p.summary_a}`,
        `[${p.id_b}] ${p.title_b}: ${p.summary_b}`,
      ]);

      const res = await fetch(`${NLP_SERVICE_URL}/pipeline/lint-scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pages, compile_model: getCompileModel() }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          contradictions: Array<{ page_a: string; page_b: string; claim: string; severity: string }>;
        };
        contradictions = enrichContradictions(data.contradictions ?? [], titleById, db);
      }
    }
  } catch {
    // Contradiction scan is best-effort; never fail the lint for it
  }

  const run_duration_ms = Date.now() - start;
  const results: LintResults = {
    orphan_pages,
    stale_pages,
    missing_cross_refs,
    dead_provenance,
    contradictions,
    run_duration_ms,
  };

  logActivity('lint_complete', {
    source_id: null,
    details: {
      orphan_pages,
      stale_pages,
      missing_cross_refs,
      dead_provenance,
      contradictions,
      run_duration_ms,
    },
  });

  setLastLintAt(new Date().toISOString());

  void regenerateSavedLinksPage().catch(() => {});

  return NextResponse.json(results);
}
