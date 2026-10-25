/**
 * The whole-wiki check (plan 3.6, owner decision D3): the claim check over
 * every candidate pair in the wiki, on demand from Settings > Wiki health.
 *
 * The card first shows how many claim pairs are not checked yet, how many
 * the next run checks (at most MAX_WIKI_CHECK_PAIRS_PER_RUN) and what that
 * costs and takes with the current model; nothing runs until the owner
 * confirms. A run judges the best-ranked pairs (lib/claim-check/run.ts,
 * found_by 'wiki_check'); every verdict is saved, so the next run goes on
 * where this one stopped, and successive runs cover every candidate pair.
 * Only entity and concept pages anchor pairs, never source summaries.
 *
 * CLAUDE.md rule 7: the hard cap above, and the wiki_check_enabled flag,
 * '0' by default, armed only by the owner's confirmation for one run and
 * disarmed when it ends or is stopped. Never exported to or imported from
 * backups.
 *
 * In-process state on globalThis, like the page update (lib/page-upgrade-
 * state.ts): an app restart ends a run, and the saved verdicts keep what it
 * had judged.
 */

import { randomUUID } from 'node:crypto';

import { getCompileModel, getDb, getRunningCompileSession, getSetting, setSetting } from '../db';
import { WIKI_CHECK_FLAG } from './flag';
import { LLM_MODEL_INFO, type LlmModel } from '../llm-models';
import { exceedsBudget } from '../page-upgrade-estimate';
import { fetchLlmUsage, type LlmUsage } from '../page-upgrade';
import { isPageUpgradeRunning } from '../page-upgrade-state';
import { isWikiRepairRunning } from '../wiki-repair/state';
import type { CandidatePair } from './candidates';
import { estimateWikiCheck, type JudgePricing, type WikiCheckEstimate } from './estimate';
import { MAX_WIKI_CHECK_PAIRS_PER_RUN } from './limits';
import type { JudgeStop } from './judge';
import { pendingClaimPairs, runClaimCheck } from './run';
import { lastWikiCheckAt } from './verdicts';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

export type WikiCheckStopReason = JudgeStop | 'user' | 'error';

export interface WikiCheckRun {
  run_id: string;
  status: 'running' | 'finished' | 'stopped';
  stop_requested: boolean;
  /** Locked at confirmation. */
  model: LlmModel;
  model_label: string;
  /** Pairs this run judges at most: its fixed iteration bound. */
  total: number;
  judged: number;
  findings: number;
  stop_reason: WikiCheckStopReason | null;
  started_at: string;
  finished_at: string | null;
}

interface WikiCheckState {
  starting: boolean;
  run: WikiCheckRun | null;
}

const STATE_KEY = '__komplWikiCheck';

function state(): WikiCheckState {
  const g = globalThis as { [STATE_KEY]?: WikiCheckState };
  return (g[STATE_KEY] ??= { starting: false, run: null });
}

export function isWikiCheckRunning(): boolean {
  const s = state();
  return s.starting || s.run?.status === 'running';
}

export class WikiCheckError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'WikiCheckError';
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** GET /llm/pricing, the fields the estimate reads (nlp-service routers/llm.py). */
export async function fetchJudgePricing(model: LlmModel): Promise<JudgePricing> {
  const res = await fetch(`${NLP_SERVICE_URL}/llm/pricing?model=${encodeURIComponent(model)}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`llm_pricing_failed: ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  for (const key of ['input_usd_per_m', 'output_usd_per_m', 'claim_judge_thinking_budget', 'claim_judge_max_output_tokens'] as const) {
    if (!isFiniteNumber(body[key])) throw new Error(`llm_pricing_invalid: ${key}`);
  }
  if (typeof body.draft_thinking_budget_is_cap !== 'boolean') throw new Error('llm_pricing_invalid: draft_thinking_budget_is_cap');
  return {
    input_usd_per_m: body.input_usd_per_m as number,
    output_usd_per_m: body.output_usd_per_m as number,
    claim_judge_thinking_budget: body.claim_judge_thinking_budget as number,
    claim_judge_max_output_tokens: body.claim_judge_max_output_tokens as number,
    draft_thinking_budget_is_cap: body.draft_thinking_budget_is_cap,
  };
}

/** What one pair sends: both claims and their quotes, in characters. */
function pairChars(pair: CandidatePair): number {
  return [pair.first, pair.second].reduce((sum, c) => sum + c.text.length + (c.quote?.length ?? 0), pair.subject.length);
}

export interface WikiCheckOverview {
  /** Candidate pairs not judged yet; null on a progress poll (not counted then). */
  pairs_left: number | null;
  /** Pairs the next run checks: min(pairs_left, max_pairs_per_run). */
  next_run_pairs: number | null;
  max_pairs_per_run: number;
  /** Pairs judged so far, by any run or compile. */
  checked_pairs: number;
  last_checked_at: string | null;
  model: { id: LlmModel; label: string };
  estimate: WikiCheckEstimate | null;
  /** Why there is no estimate (nlp-service unreachable); null otherwise. */
  estimate_error: string | null;
  budget: { daily_cap_usd: number | null; spent_today_usd: number; remaining_usd: number | null } | null;
  /** The high estimate is more than today's remaining spending limit. */
  over_budget: boolean;
  compile_running: boolean;
  page_upgrade_running: boolean;
  run: WikiCheckRun | null;
}

function budgetOf(usage: LlmUsage): NonNullable<WikiCheckOverview['budget']> {
  return {
    daily_cap_usd: usage.daily_cap_usd > 0 ? usage.daily_cap_usd : null,
    spent_today_usd: usage.total_usd,
    remaining_usd: usage.remaining_usd >= 0 ? usage.remaining_usd : null,
  };
}

/** What Settings > Wiki health shows. `withEstimate: false` skips counting pairs and the nlp-service reads (progress polls). */
export async function getWikiCheckOverview(opts: { withEstimate: boolean }): Promise<WikiCheckOverview> {
  const db = getDb();
  const model = getCompileModel();
  const run = state().run;
  const overview: WikiCheckOverview = {
    pairs_left: null,
    next_run_pairs: null,
    max_pairs_per_run: MAX_WIKI_CHECK_PAIRS_PER_RUN,
    checked_pairs: (db.prepare('SELECT COUNT(*) AS n FROM claim_verdicts').get() as { n: number }).n,
    last_checked_at: lastWikiCheckAt(db),
    model: { id: model, label: LLM_MODEL_INFO[model].label },
    estimate: null,
    estimate_error: null,
    budget: null,
    over_budget: false,
    compile_running: Boolean(getRunningCompileSession()),
    page_upgrade_running: isPageUpgradeRunning(),
    run: run ? { ...run } : null,
  };
  if (!opts.withEstimate) return overview;

  const pairs = pendingClaimPairs(db);
  const next = pairs.slice(0, MAX_WIKI_CHECK_PAIRS_PER_RUN);
  overview.pairs_left = pairs.length;
  overview.next_run_pairs = next.length;
  if (next.length === 0) return overview;
  try {
    overview.estimate = estimateWikiCheck(next.map(pairChars), await fetchJudgePricing(model));
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

/**
 * The owner's confirmation of the numbers shown: refuses when they no longer
 * hold (another model, more pairs), when nothing is left, or while a compile
 * or a page update runs. Arms the flag and starts the run in the
 * background; `finished` settles when it ends.
 */
export async function startWikiCheck(input: { expectedPairs: number; model: string }): Promise<{ run: WikiCheckRun; finished: Promise<void> }> {
  const s = state();
  if (s.starting || s.run?.status === 'running') {
    throw new WikiCheckError('already_running', 409, 'The wiki check is already running.');
  }
  s.starting = true;
  try {
    if (getRunningCompileSession()) {
      throw new WikiCheckError('session_in_progress', 409, 'A compile is running. Check the wiki once it finishes.');
    }
    if (isPageUpgradeRunning()) {
      throw new WikiCheckError('page_upgrade_in_progress', 409, 'Pages are being updated. Check the wiki once the update finishes.');
    }
    if (isWikiRepairRunning()) {
      throw new WikiCheckError('wiki_repair_in_progress', 409, 'The wiki is being repaired. Check the wiki once the repair finishes.');
    }
    const model = getCompileModel();
    if (input.model !== model) {
      throw new WikiCheckError(
        'model_changed',
        409,
        `The compile model is now ${LLM_MODEL_INFO[model].label}. Review the new estimate and confirm again.`,
      );
    }
    const pairs = pendingClaimPairs(getDb()).length;
    const next = Math.min(pairs, MAX_WIKI_CHECK_PAIRS_PER_RUN);
    if (next === 0) throw new WikiCheckError('no_pairs', 409, 'Every claim pair has been checked.');
    if (next > input.expectedPairs) {
      throw new WikiCheckError(
        'pairs_changed',
        409,
        `The next run would check ${next} claim pairs, not ${input.expectedPairs}. Review the new estimate and confirm again.`,
        { next_run_pairs: next },
      );
    }

    setSetting(WIKI_CHECK_FLAG, '1');
    const run: WikiCheckRun = {
      run_id: randomUUID(),
      status: 'running',
      stop_requested: false,
      model,
      model_label: LLM_MODEL_INFO[model].label,
      total: next,
      judged: 0,
      findings: 0,
      stop_reason: null,
      started_at: new Date().toISOString(),
      finished_at: null,
    };
    s.run = run;
    return { run: { ...run }, finished: checkWiki(run) };
  } finally {
    s.starting = false;
  }
}

/** Stop before the next batch (calls in flight finish and are saved). */
export function requestWikiCheckStop(): WikiCheckRun | null {
  const run = state().run;
  if (!run || run.status !== 'running') return null;
  run.stop_requested = true;
  setSetting(WIKI_CHECK_FLAG, '0');
  return { ...run };
}

async function checkWiki(run: WikiCheckRun): Promise<void> {
  let reason: WikiCheckStopReason | null = null;
  try {
    const summary = await runClaimCheck({
      found_by: 'wiki_check',
      model: run.model,
      maxPairs: run.total,
      shouldStop: () => (run.stop_requested || getSetting(WIKI_CHECK_FLAG) !== '1' ? 'stopped' : null),
      onProgress: ({ judged, findings }) => {
        run.judged = judged;
        run.findings = findings;
      },
    });
    run.judged = summary.judged;
    run.findings = summary.findings;
    reason = summary.stopped === 'stopped' ? 'user' : summary.stopped;
  } catch (err) {
    console.error('[wiki-check] run failed', run.run_id, err);
    reason = 'error';
  } finally {
    run.status = reason ? 'stopped' : 'finished';
    run.stop_reason = reason;
    run.finished_at = new Date().toISOString();
    try {
      setSetting(WIKI_CHECK_FLAG, '0');
    } catch (err) {
      console.error('[wiki-check] could not disarm', run.run_id, err);
    }
  }
}

/** Test-only: forget any run (state is process-global). */
export function __resetWikiCheckStateForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__resetWikiCheckStateForTesting may only be called when NODE_ENV=test');
  }
  state().starting = false;
  state().run = null;
}
