/**
 * GET /api/wiki/repair/plan — the dry run: everything a wiki repair run
 * would do, computed without changing anything (lib/wiki-repair/plan.ts)
 * and priced on the compile model when the NLP service answers.
 *
 * Response: { model, aliases: [{ id, alias, canonical }], aliases_over_cap,
 *             aliases_undecided, name_check_calls, sources,
 *             pages: [{ page_id, title, certain, remove: [{ source_id,
 *             title }], add: [...] }] (remove/add: the change when no
 *             set-aside match is confirmed), pages_low,
 *             pages_high, pages_over_cap, pages_waiting, labels,
 *             estimate | null, estimate_error }
 *           409 { error: 'wiki_repair_running' } while a run is going.
 */

import { NextResponse } from 'next/server';

import { getCompileModel, getDb } from '@/lib/db';
import { LLM_MODEL_INFO } from '@/lib/llm-models';
import { estimateRepair } from '@/lib/wiki-repair/estimate';
import { computeRepairPlan } from '@/lib/wiki-repair/plan';
import { fetchRepairPricing } from '@/lib/wiki-repair/calls';
import { isWikiRepairRunning } from '@/lib/wiki-repair/state';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (isWikiRepairRunning()) {
    return NextResponse.json(
      { error: 'wiki_repair_running', message: 'The wiki is being repaired; the plan is shown again once it ends.' },
      { status: 409 },
    );
  }
  try {
    const model = getCompileModel();
    const db = getDb();
    const { estimate_input, pages, ...rest } = computeRepairPlan(db);
    const sourceTitle = db.prepare('SELECT title FROM sources WHERE source_id = ?');
    const named = (ids: string[]) =>
      ids.map((source_id) => ({ source_id, title: (sourceTitle.get(source_id) as { title: string | null } | undefined)?.title ?? null }));
    const plan = { ...rest, pages: pages.map((p) => ({ ...p, remove: named(p.remove), add: named(p.add) })) };
    let estimate = null;
    let estimate_error: string | null = null;
    try {
      const { raw_cost_usd_high: _raw, ...rounded } = estimateRepair(estimate_input, await fetchRepairPricing(model), model);
      estimate = rounded;
    } catch {
      estimate_error = "Kompl's NLP service did not respond, so the cost cannot be estimated right now.";
    }
    return NextResponse.json({ model: { id: model, label: LLM_MODEL_INFO[model].label }, ...plan, estimate, estimate_error });
  } catch (err) {
    console.error('[wiki-repair] plan failed', err);
    return NextResponse.json(
      { error: 'wiki_repair_plan_failed', message: 'Could not work out what the repair would do.' },
      { status: 500 },
    );
  }
}
