/**
 * GET /api/wiki/claim-check — the whole-wiki check (plan 3.6,
 * lib/claim-check/wiki-check.ts) as Settings > Wiki health shows it.
 *
 * Query:    estimate=0 skips counting the pairs left and the cost estimate
 *           (progress polls while a run is going); the default includes them.
 * Response: { pairs_left, next_run_pairs, max_pairs_per_run, checked_pairs,
 *             last_checked_at, model: { id, label }, estimate: { pairs,
 *             calls, cost_usd_low, cost_usd_high, minutes_low,
 *             minutes_high } | null, estimate_error, budget, over_budget,
 *             compile_running, page_upgrade_running, run }
 */

import { NextResponse } from 'next/server';

import { getWikiCheckOverview } from '@/lib/claim-check/wiki-check';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const withEstimate = new URL(request.url).searchParams.get('estimate') !== '0';
  try {
    return NextResponse.json(await getWikiCheckOverview({ withEstimate }));
  } catch (err) {
    console.error('[wiki-check] status failed', err);
    return NextResponse.json(
      { error: 'wiki_check_status_failed', message: 'Could not read the wiki check.' },
      { status: 500 },
    );
  }
}
