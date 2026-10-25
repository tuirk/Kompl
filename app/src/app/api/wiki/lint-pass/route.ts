/**
 * POST /api/wiki/lint-pass
 *
 * The lint engine behind Settings > Wiki health "Run check".
 *
 * Checks performed:
 *   1. Orphan pages — no inbound or outbound page_links
 *   2. Stale source-summaries — source_count==1 AND last_updated > 30 days ago
 *   3. Missing cross-refs — names the extraction found in 3+ sources that no
 *      page title or alias covers (lib/missing-pages.ts, the same names as
 *      the graph's missing pages; dates, amounts and numbers are not names)
 *   4. Dead provenance — provenance rows referencing deleted sources
 *   5. Contradiction detection (LLM-assisted, best-effort) via nlp-service
 *
 * Check 5 calls the LLM, so the pass runs only when the user asks for it
 * ({ manual: true }). The scheduled run that `kompl start` used to fire (at
 * most once per 36 hours, only from the CLI) was retired in v0.4; older CLIs
 * still call without `manual` and get { skipped: true }, which they report as
 * skipped. The lint_enabled setting is kept for old clients and backups but no
 * longer starts anything.
 *
 * Request: { manual: true } (anything else is skipped)
 * Response: LintResult, or { skipped: true }
 */

import { NextResponse } from 'next/server';
import { getCompileModel, getDb, logActivity, setLastLintAt } from '../../../../lib/db';
import { regenerateSavedLinksPage } from '../../../../lib/saved-links';
import type { LintContradiction, LintResult } from '../../../../lib/lint-result';
import { runHealthChecks } from '../../../../lib/wiki-health';

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

  // Only the Run check button starts a pass (see the header comment).
  if (!isManual) {
    return NextResponse.json({ skipped: true } satisfies Partial<LintResults>);
  }

  const start = Date.now();
  const db = getDb();

  // Checks 1-4 are plain reads, shared with GET /api/wiki/status.
  const { orphan_pages, stale_pages, missing_cross_refs, dead_provenance } = runHealthChecks(db);

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
