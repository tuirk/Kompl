/**
 * GET /api/wiki/page-upgrade — status of the update to the current writing
 * rules (Settings > Wiki health, lib/writing-rules.ts, lib/page-upgrade.ts).
 *
 * Query:    estimate=0 skips the cost estimate (progress polls while a run
 *           is going); the default includes it.
 * Response: { rules, candidates, set_aside: [{ page_id, title, reason }],
 *             model: { id, label }, estimate: { pages,
 *             cost_usd_low, cost_usd_high, minutes_low, minutes_high } | null,
 *             estimate_error, budget: { daily_cap_usd, spent_today_usd,
 *             remaining_usd } | null, over_budget, compile_running,
 *             run: PageUpgradeRunView | null, max_overspend }
 */

import { NextResponse } from 'next/server';

import { getPageUpgradeOverview } from '@/lib/page-upgrade';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const withEstimate = new URL(request.url).searchParams.get('estimate') !== '0';
  try {
    return NextResponse.json(await getPageUpgradeOverview({ withEstimate }));
  } catch (err) {
    console.error('[page-upgrade] status failed', err);
    return NextResponse.json(
      { error: 'page_upgrade_status_failed', message: 'Could not read which pages need updating.' },
      { status: 500 },
    );
  }
}
