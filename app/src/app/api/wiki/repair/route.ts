/**
 * GET /api/wiki/repair — the wiki repair card in Settings > Wiki health
 * (lib/wiki-repair/run.ts): what a run would do and cost, and the current or
 * last run. Reads only; nothing changes.
 *
 * Query:    estimate=0 skips the plan and the cost estimate (progress polls
 *           while a run is going); the default includes them.
 * Response: RepairOverview { model, plan, nothing_to_do, estimate,
 *           estimate_error, budget, over_budget, busy, run, max_overspend }
 */

import { NextResponse } from 'next/server';

import { getRepairOverview } from '@/lib/wiki-repair/run';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const withPlan = new URL(request.url).searchParams.get('estimate') !== '0';
  try {
    return NextResponse.json(await getRepairOverview({ withPlan }));
  } catch (err) {
    console.error('[wiki-repair] status failed', err);
    return NextResponse.json(
      { error: 'wiki_repair_status_failed', message: 'Could not work out what the repair would do.' },
      { status: 500 },
    );
  }
}
