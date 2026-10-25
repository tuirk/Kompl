/**
 * POST /api/wiki/lint-pass
 *
 * The lint engine behind Settings > Wiki health "Run check".
 *
 * Checks performed (plain reads, no LLM):
 *   1. Orphan pages — no inbound or outbound page_links
 *   2. Stale source-summaries — source_count==1 AND last_updated > 30 days ago
 *   3. Missing cross-refs — names the extraction found in 3+ sources that no
 *      page title or alias covers (lib/missing-pages.ts, the same names as
 *      the graph's missing pages; dates, amounts and numbers are not names)
 *   4. Dead provenance — provenance rows referencing deleted sources
 *
 * Disagreements between sources are no longer looked for here. The old
 * check 5 asked the LLM about pairs of page summaries in one category (at
 * most 10, source summaries included); the whole-wiki check replaced it
 * (plan 3.6, lib/claim-check/wiki-check.ts): it judges claim pairs from
 * different sources on a shared subject, with the cost shown first, and
 * records its findings on the pages. `contradictions` stays in the result,
 * always empty, so older clients and logged results still read it.
 *
 * The pass runs only when the user asks for it ({ manual: true }). The
 * scheduled run that `kompl start` used to fire (at most once per 36 hours,
 * only from the CLI) was retired in v0.4; older CLIs still call without
 * `manual` and get { skipped: true }, which they report as skipped. The
 * lint_enabled setting is kept for old clients and backups but no longer
 * starts anything.
 *
 * Request: { manual: true } (anything else is skipped)
 * Response: LintResult, or { skipped: true }
 */

import { NextResponse } from 'next/server';
import { getDb, logActivity, setLastLintAt } from '../../../../lib/db';
import { regenerateSavedLinksPage } from '../../../../lib/saved-links';
import type { LintResult } from '../../../../lib/lint-result';
import { runHealthChecks } from '../../../../lib/wiki-health';

type LintResults = LintResult & { skipped?: true };

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

  const run_duration_ms = Date.now() - start;
  const results: LintResults = {
    orphan_pages,
    stale_pages,
    missing_cross_refs,
    dead_provenance,
    contradictions: [],
    run_duration_ms,
  };

  logActivity('lint_complete', {
    source_id: null,
    details: {
      orphan_pages,
      stale_pages,
      missing_cross_refs,
      dead_provenance,
      contradictions: [],
      run_duration_ms,
    },
  });

  setLastLintAt(new Date().toISOString());

  void regenerateSavedLinksPage().catch(() => {});

  return NextResponse.json(results);
}
