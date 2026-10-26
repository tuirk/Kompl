/**
 * Repair wiki (plan Phase 4, owner decisions D1, D2, D7): one wiki-level
 * run from Settings > Wiki health that puts right what earlier name matching
 * got wrong, all or none, after a backup:
 *   1. a full backup on the data volume (lib/wiki-repair/backup.ts); no
 *      backup, no run
 *   2. set-aside name matches confirmed or retired by the AI (./aliases.ts)
 *   3. every source's mentions credited again (./mentions.ts)
 *   4. links written through name matches no longer used corrected, no
 *      AI call (./links.ts)
 *      links to the wrong sense of a one-word name turned back into words
 *      (./senses.ts) and source titles put on one line (./titles.ts), no AI
 *   5. the pages whose sources changed rebuilt from them, through the
 *      outbox, previous versions kept (lib/redraft.ts)
 *   6. labels that mean the same thing merged (./labels.ts)
 * Steps 2–6 run in ./steps.ts.
 *
 * The owner first sees the plan (./plan.ts): how many name matches the AI
 * checks, how many pages may be rebuilt, the AI calls, cost and time on the
 * compile model; nothing runs until she confirms those numbers.
 *
 * CLAUDE.md rule 7: the hard caps in ./limits.ts; the wiki_repair_enabled
 * flag, '0' by default, armed only by the confirmation for one run, disarmed
 * by its end, Stop and an app restart; fixed bounds (the name matches and
 * the page count confirmed); the spend guard (REPAIR_MAX_OVERSPEND × the
 * confirmed high estimate, measured from GET /llm/usage); and the daily
 * spending limit, which stops the run cleanly. Compiles, the page update and
 * the whole-wiki check wait while it runs, so the measured spend is its own.
 */

import { randomUUID } from 'node:crypto';

import { getCompileModel, getDb, getRunningCompileSession, setSetting } from '../db';
import { isWikiCheckRunning } from '../claim-check/wiki-check';
import { LLM_MODEL_INFO, type LlmModel } from '../llm-models';
import { fetchLlmUsage, type LlmUsage } from '../page-upgrade';
import { exceedsBudget } from '../page-upgrade-estimate';
import { isPageUpgradeRunning } from '../page-upgrade-state';
import { saveRepairBackup } from './backup';
import { fetchRepairPricing } from './calls';
import { estimateRepair, type RepairEstimate } from './estimate';
import { REPAIR_MAX_OVERSPEND, WIKI_REPAIR_FLAG } from './limits';
import { computeRepairPlan, type RepairPlan } from './plan';
import { currentRun, isWikiRepairRunning, repairState, saveRun, type RepairRun } from './state';
import { finishStep, runRepairSteps } from './steps';

export class WikiRepairError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'WikiRepairError';
  }
}


// ── Views ──────────────────────────────────────────────────────────────────

export interface RepairRunView extends Omit<RepairRun, 'pending_pages'> {
  /** Pages still to rebuild, and the first titles. */
  pages_waiting: number;
  waiting_titles: string[];
}

function viewOf(run: RepairRun): RepairRunView {
  const { pending_pages, ...rest } = run;
  return {
    ...structuredClone(rest),
    pages_waiting: pending_pages.length,
    waiting_titles: pending_pages.slice(0, 20).map((p) => p.title),
  };
}

export function getRepairRunView(): RepairRunView | null {
  const run = currentRun();
  return run ? viewOf(run) : null;
}

export interface RepairOverview {
  model: { id: LlmModel; label: string };
  /** What the next run does; null while one runs or on a progress poll. */
  plan: {
    aliases: number;
    aliases_over_cap: number;
    name_check_calls: number;
    sources: number;
    pages_low: number;
    pages_high: number;
    pages_over_cap: number;
    pages_waiting: number;
    link_pages_low: number;
    link_pages_high: number;
    sense_pages: number;
    sense_links: number;
    title_sources: number;
    labels: number;
  } | null;
  nothing_to_do: boolean;
  estimate: Omit<RepairEstimate, 'raw_cost_usd_high'> | null;
  estimate_error: string | null;
  budget: { daily_cap_usd: number | null; spent_today_usd: number; remaining_usd: number | null } | null;
  over_budget: boolean;
  /** Something else that must finish first; null when the repair may start. */
  busy: 'compile' | 'page_upgrade' | 'wiki_check' | null;
  run: RepairRunView | null;
  max_overspend: number;
}

/** No name pair to ask about, no page to rewrite, no link to correct and no title to clean. */
function nothingToRepair(plan: RepairPlan): boolean {
  return (
    plan.aliases.length === 0 && plan.pages_high === 0 && plan.link_pages_high === 0 && plan.sense_pages === 0 && plan.title_sources === 0
  );
}

function busyWith(): RepairOverview['busy'] {
  if (getRunningCompileSession()) return 'compile';
  if (isPageUpgradeRunning()) return 'page_upgrade';
  if (isWikiCheckRunning()) return 'wiki_check';
  return null;
}

function budgetOf(usage: LlmUsage): NonNullable<RepairOverview['budget']> {
  return {
    daily_cap_usd: usage.daily_cap_usd > 0 ? usage.daily_cap_usd : null,
    spent_today_usd: usage.total_usd,
    remaining_usd: usage.remaining_usd >= 0 ? usage.remaining_usd : null,
  };
}

/** What Settings > Wiki health shows. `withPlan: false` skips the plan and the nlp-service reads (progress polls). */
export async function getRepairOverview(opts: { withPlan: boolean }): Promise<RepairOverview> {
  const model = getCompileModel();
  const overview: RepairOverview = {
    model: { id: model, label: LLM_MODEL_INFO[model].label },
    plan: null,
    nothing_to_do: false,
    estimate: null,
    estimate_error: null,
    budget: null,
    over_budget: false,
    busy: busyWith(),
    run: getRepairRunView(),
    max_overspend: REPAIR_MAX_OVERSPEND,
  };
  if (!opts.withPlan || isWikiRepairRunning()) return overview;

  const plan = computeRepairPlan(getDb());
  overview.plan = {
    aliases: plan.aliases.length,
    aliases_over_cap: plan.aliases_over_cap,
    name_check_calls: plan.name_check_calls,
    sources: plan.sources,
    pages_low: plan.pages_low,
    pages_high: plan.pages_high,
    pages_over_cap: plan.pages_over_cap,
    pages_waiting: plan.pages_waiting,
    link_pages_low: plan.link_pages_low,
    link_pages_high: plan.link_pages_high,
    sense_pages: plan.sense_pages,
    sense_links: plan.sense_links,
    title_sources: plan.title_sources,
    labels: plan.labels.length,
  };
  overview.nothing_to_do = nothingToRepair(plan);
  if (overview.nothing_to_do) return overview;

  try {
    const { raw_cost_usd_high: _raw, ...estimate } = estimateRepair(plan.estimate_input, await fetchRepairPricing(model), model);
    overview.estimate = estimate;
  } catch {
    overview.estimate_error = "Kompl's NLP service did not respond, so the cost cannot be estimated right now.";
    return overview;
  }
  try {
    overview.budget = budgetOf(await fetchLlmUsage());
    overview.over_budget = exceedsBudget(overview.estimate.cost_usd_high, overview.budget.remaining_usd);
  } catch {
    // Spending unknown: the card shows the estimate without the budget line.
  }
  return overview;
}

// ── Start and stop ─────────────────────────────────────────────────────────

const BUSY_TEXT = {
  compile: 'A compile is running. Repair the wiki once it finishes.',
  page_upgrade: 'Pages are being updated. Repair the wiki once the update finishes.',
  wiki_check: 'The whole-wiki check is running. Repair the wiki once it finishes.',
} as const;

function refuseIfBusy(): void {
  const busy = busyWith();
  if (busy) throw new WikiRepairError(`${busy === 'compile' ? 'session' : busy}_in_progress`, 409, BUSY_TEXT[busy]);
}

/**
 * The owner's confirmation of the numbers shown. Refuses when they no longer
 * hold (another model, more name matches or pages), when there is nothing to
 * do or something else runs; then takes the backup (no backup, no run), arms
 * the flag and starts steps 2–6 in the background.
 */
export async function startWikiRepair(input: {
  expectedAliases: number;
  expectedPages: number;
  model: string;
}): Promise<{ run: RepairRunView; finished: Promise<void> }> {
  const s = repairState();
  if (s.starting || s.run?.status === 'running') {
    throw new WikiRepairError('already_running', 409, 'The wiki is already being repaired.');
  }
  s.starting = true;
  try {
    refuseIfBusy();
    const model = getCompileModel();
    if (input.model !== model) {
      throw new WikiRepairError(
        'model_changed',
        409,
        `The compile model is now ${LLM_MODEL_INFO[model].label}. Review the new plan and confirm again.`,
      );
    }
    const plan = computeRepairPlan(getDb());
    if (nothingToRepair(plan)) {
      throw new WikiRepairError('nothing_to_repair', 409, 'There is nothing to repair.');
    }
    if (plan.aliases.length > input.expectedAliases || plan.pages_high > input.expectedPages) {
      throw new WikiRepairError(
        'plan_changed',
        409,
        'The wiki changed since the plan was shown. Review the new plan and confirm again.',
        { aliases: plan.aliases.length, pages_high: plan.pages_high },
      );
    }
    let estimate: RepairEstimate;
    let usage: LlmUsage;
    try {
      estimate = estimateRepair(plan.estimate_input, await fetchRepairPricing(model), model);
    } catch {
      throw new WikiRepairError('estimate_unavailable', 503, "Kompl's NLP service did not respond, so the cost cannot be estimated. Try again in a moment.");
    }
    try {
      usage = await fetchLlmUsage();
    } catch {
      throw new WikiRepairError('usage_unavailable', 503, "Kompl cannot read today's AI spending, so it cannot keep the repair within its estimate. Try again in a moment.");
    }
    refuseIfBusy(); // the awaits above gave something else time to start

    // Step 1: the backup. Nothing has changed yet; without it nothing will.
    let backup;
    try {
      backup = await saveRepairBackup();
    } catch (err) {
      console.error('[wiki-repair] backup failed; the repair did not start', err);
      throw new WikiRepairError('backup_failed', 500, 'Kompl could not save a backup of your wiki, so the repair did not start. Nothing was changed.');
    }

    setSetting(WIKI_REPAIR_FLAG, '1');
    const earlier = currentRun();
    const run: RepairRun = {
      run_id: randomUUID(),
      status: 'running',
      stop_requested: false,
      model,
      model_label: LLM_MODEL_INFO[model].label,
      step: 'backup',
      steps_done: [],
      backup,
      aliases: { total: plan.aliases.length, judged: 0, confirmed: 0, retired: 0, undecided: 0 },
      mentions: null,
      pages: { total: 0, done: 0, rebuilt: 0, skipped: 0, failed: 0, consecutive_failures: 0, current_title: null },
      labels: null,
      confirmed: {
        aliases: plan.aliases.length,
        max_pages: plan.pages_high,
        cost_usd_low: estimate.cost_usd_low,
        cost_usd_high: estimate.cost_usd_high,
        minutes_low: estimate.minutes_low,
        minutes_high: estimate.minutes_high,
      },
      spend_limit_usd: REPAIR_MAX_OVERSPEND * estimate.cost_usd_high,
      spent_usd: 0,
      stop_reason: null,
      last_error: null,
      issues: [],
      // Pages an earlier run left waiting: this run continues with them.
      pending_pages: earlier?.pending_pages ?? [],
      started_at: new Date().toISOString(),
      finished_at: null,
    };
    s.run = run;
    finishStep(run, 'backup');
    const finished = runRepairSteps(run, {
      aliasIds: plan.aliases.map((a) => a.id),
      usage,
      perCallHighUsd: estimate.raw_cost_usd_high / Math.max(1, estimate.calls_high),
    });
    return { run: viewOf(run), finished };
  } finally {
    s.starting = false;
  }
}

/** Stop before the next AI call (one in flight finishes and is kept). */
export function requestWikiRepairStop(): RepairRunView | null {
  const run = repairState().run;
  if (!run || run.status !== 'running') return null;
  run.stop_requested = true;
  setSetting(WIKI_REPAIR_FLAG, '0');
  saveRun(run);
  return viewOf(run);
}
