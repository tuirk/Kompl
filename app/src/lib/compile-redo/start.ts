/**
 * Offer, preview and start a redo of the last compile (GitHub #140).
 *
 * Offered only on the most recent compile, once it finished, failed or was
 * cancelled (FR-2), and only while nothing else runs: no compile, Repair
 * wiki, Update pages or whole-wiki check (FR-10). Those refuse in turn while
 * the redo runs, because its session is queued or running
 * (getRunningCompileSession).
 *
 * Like Repair wiki, the owner confirms the numbers she saw (the most pages
 * and the model); the start refuses if the plan grew or the model changed
 * since (FR-5). The redo then resets the session in one transaction
 * (./reset.ts) and hands it to n8n, which forwards only the session id to
 * /api/compile/run (CLAUDE.md rule 3).
 */

import { isWikiCheckRunning } from '../claim-check/wiki-check';
import { isCompileRunLive } from '../compile/compile-run';
import { getCompileModel, getDb, getRunningCompileSession } from '../db';
import { LLM_MODEL_INFO, type LlmModel } from '../llm-models';
import { fetchLlmUsage, type LlmUsage } from '../page-upgrade';
import { exceedsBudget } from '../page-upgrade-estimate';
import { isPageUpgradeRunning } from '../page-upgrade-state';
import { pageTextVersionToken } from '../page-rewrite';
import { triggerSessionCompile } from '../trigger-n8n';
import { fetchRepairPricing } from '../wiki-repair/calls';
import { isWikiRepairRunning } from '../wiki-repair/state';
import { compilePages } from './baseline';
import { estimateRedo, type RedoEstimate } from './estimate';
import { computeRedoPlan, type RedoPlan } from './plan';
import { applyRedoReset } from './reset';
import { MAX_REDO_PAGES, type RedoPoint, type RedoRecord } from './state';

export class RedoError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'RedoError';
  }
}

const NOT_OFFERED: Record<string, string> = {
  no_progress_record: 'This compile was not found.',
  not_latest: 'Only the most recent compile can be redone.',
  compile_running: 'A compile is running. Redo once it finishes.',
  still_stopping: 'This compile is still stopping. Try again in a minute.',
  wiki_repair_in_progress: 'The wiki is being repaired. Redo once the repair finishes.',
  page_upgrade_in_progress: 'Pages are being updated. Redo once the update finishes.',
  wiki_check_in_progress: 'The whole-wiki check is running. Redo once it finishes.',
};

/** Why this session can't be redone now, or null when it can. */
export function redoRefusal(sessionId: string): string | null {
  const db = getDb();
  const latest = db
    .prepare('SELECT session_id FROM compile_progress ORDER BY created_at DESC, rowid DESC LIMIT 1')
    .get() as { session_id: string } | undefined;
  const row = db.prepare('SELECT status FROM compile_progress WHERE session_id = ?').get(sessionId) as
    | { status: string }
    | undefined;
  if (!row) return 'no_progress_record';
  if (latest?.session_id !== sessionId) return 'not_latest';
  if (row.status === 'queued' || row.status === 'running' || getRunningCompileSession()) return 'compile_running';
  if (isCompileRunLive(sessionId)) return 'still_stopping';
  if (isWikiRepairRunning()) return 'wiki_repair_in_progress';
  if (isPageUpgradeRunning()) return 'page_upgrade_in_progress';
  if (isWikiCheckRunning()) return 'wiki_check_in_progress';
  return null;
}

function refuseIfNotOffered(sessionId: string): void {
  const code = redoRefusal(sessionId);
  if (code) throw new RedoError(code, code === 'no_progress_record' ? 404 : 409, NOT_OFFERED[code]);
}

/** Nothing for this point to do. */
function nothingToDo(plan: RedoPlan): boolean {
  return plan.point === 'plan' ? plan.sources === 0 : plan.plan_ids.length === 0;
}

export interface RedoPreview {
  point: RedoPoint;
  model: { id: LlmModel; label: string };
  nothing_to_do: boolean;
  pages: number;
  max_pages: number;
  page_titles: string[];
  may_archive: RedoPlan['may_archive'];
  skipped: RedoPlan['skipped'];
  waiting_drafts: number;
  sources: number;
  estimate: RedoEstimate | null;
  estimate_error: string | null;
  budget: { remaining_usd: number | null } | null;
  over_budget: boolean;
}

async function estimateOf(plan: RedoPlan, model: LlmModel): Promise<RedoEstimate> {
  if (plan.point === 'save') return estimateRedo({ draftsLow: [], draftsHigh: [], checkSources: 0 }, ZERO_PRICING, model);
  return estimateRedo(plan.estimate_input, await fetchRepairPricing(model), model);
}

const ZERO_PRICING = {
  input_usd_per_m: 0, output_usd_per_m: 0, cached_input_usd_per_m: 0, draft_thinking_budget: 0,
  draft_thinking_budget_is_cap: true, draft_max_output_tokens: 0, draft_prompt_char_cap: 0,
  disambiguate_thinking_budget: 0, disambiguate_max_output_tokens: 0,
  label_merge_thinking_budget: 0, label_merge_max_output_tokens: 0,
};

/** What a redo from `point` would do and cost (FR-4). Reads only. */
export async function previewRedo(sessionId: string, point: RedoPoint): Promise<RedoPreview> {
  refuseIfNotOffered(sessionId);
  const model = getCompileModel();
  const plan = computeRedoPlan(getDb(), sessionId, point);
  const preview: RedoPreview = {
    point,
    model: { id: model, label: LLM_MODEL_INFO[model].label },
    nothing_to_do: nothingToDo(plan),
    pages: plan.point === 'plan' ? plan.pages.length : plan.plan_ids.length,
    max_pages: plan.max_pages,
    page_titles: plan.pages.slice(0, 30).map((p) => p.title),
    may_archive: plan.may_archive.slice(0, 50),
    skipped: plan.skipped.slice(0, 50),
    waiting_drafts: plan.waiting_drafts,
    sources: plan.sources,
    estimate: null,
    estimate_error: null,
    budget: null,
    over_budget: false,
  };
  if (preview.nothing_to_do) return preview;
  try {
    preview.estimate = await estimateOf(plan, model);
  } catch {
    preview.estimate_error = "Kompl's NLP service did not respond, so the cost cannot be estimated right now.";
    return preview;
  }
  try {
    const usage = await fetchLlmUsage();
    preview.budget = { remaining_usd: usage.remaining_usd >= 0 ? usage.remaining_usd : null };
    preview.over_budget = exceedsBudget(preview.estimate.cost_usd_high, preview.budget.remaining_usd);
  } catch {
    // Spending unknown: the preview shows the estimate without the budget line.
  }
  return preview;
}

const STARTING_KEY = '__komplCompileRedoStarting';

function starting(): { on: boolean } {
  const g = globalThis as { [STARTING_KEY]?: { on: boolean } };
  return (g[STARTING_KEY] ??= { on: false });
}

/** The owner's confirmation: reset the session for the point and start the pipeline. */
export async function startRedo(input: {
  sessionId: string;
  point: RedoPoint;
  expectedPages: number;
  model: string;
}): Promise<RedoRecord> {
  const s = starting();
  if (s.on) throw new RedoError('already_starting', 409, 'A redo is already starting.');
  s.on = true;
  try {
    refuseIfNotOffered(input.sessionId);
    const model = getCompileModel();
    if (input.model !== model) {
      throw new RedoError('model_changed', 409, `The compile model is now ${LLM_MODEL_INFO[model].label}. Review the new numbers and confirm again.`);
    }
    const db = getDb();
    let plan = computeRedoPlan(db, input.sessionId, input.point);
    if (nothingToDo(plan)) throw new RedoError('nothing_to_redo', 409, 'There is nothing to redo from this point.');
    if (plan.max_pages > input.expectedPages) {
      throw new RedoError('plan_changed', 409, 'The compile changed since you saw the numbers. Review them and confirm again.', {
        max_pages: plan.max_pages,
      });
    }
    if (plan.pages.length > MAX_REDO_PAGES) {
      throw new RedoError('too_large', 409, `A redo writes at most ${MAX_REDO_PAGES} pages; this compile has ${plan.pages.length}.`);
    }
    let estimate: RedoEstimate;
    try {
      estimate = await estimateOf(plan, model);
    } catch {
      throw new RedoError('estimate_unavailable', 503, "Kompl's NLP service did not respond, so the cost cannot be estimated. Try again in a moment.");
    }
    let usage: LlmUsage | null = null;
    try {
      usage = await fetchLlmUsage();
    } catch {
      usage = null; // the spend is then not reported; the daily limit still applies in nlp-service
    }

    // The awaits above gave something else time to start or change.
    refuseIfNotOffered(input.sessionId);
    plan = computeRedoPlan(db, input.sessionId, input.point);
    if (plan.max_pages > input.expectedPages) {
      throw new RedoError('plan_changed', 409, 'The compile changed since you saw the numbers. Review them and confirm again.', {
        max_pages: plan.max_pages,
      });
    }

    const written = compilePages(db, input.sessionId);
    const record: RedoRecord = {
      session_id: input.sessionId,
      point: input.point,
      status: 'running',
      model,
      model_label: LLM_MODEL_INFO[model].label,
      confirmed: {
        pages: input.point === 'plan' ? plan.pages.length : plan.plan_ids.length,
        max_pages: plan.max_pages,
        calls_low: estimate.calls_low,
        calls_high: estimate.calls_high,
        cost_usd_low: estimate.cost_usd_low,
        cost_usd_high: estimate.cost_usd_high,
        minutes_low: estimate.minutes_low,
        minutes_high: estimate.minutes_high,
      },
      own_pages:
        input.point === 'plan'
          ? written
              .filter((p) => p.action === 'create' && !p.changed)
              .map((p) => ({ page_id: p.page_id, title: p.title, version: pageTextVersionToken(p.page_id) }))
          : [],
      skipped: plan.skipped,
      usage_at_start: usage ? { date: usage.date, total_usd: usage.total_usd } : null,
      outcome: null,
      started_at: new Date().toISOString(),
      finished_at: null,
    };
    applyRedoReset(db, plan, record);

    const trigger = await triggerSessionCompile(input.sessionId);
    if (!trigger.ok) {
      // Left queued, like a Retry whose trigger failed: the stuck-session sweep
      // fails it after a few minutes, and Retry then continues the redo.
      throw new RedoError(trigger.reason, trigger.reason === 'n8n_timeout' ? 504 : 502, 'The background worker (n8n) could not be reached. Check Docker, then press Retry.');
    }
    return record;
  } finally {
    s.on = false;
  }
}
