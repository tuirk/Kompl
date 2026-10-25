/**
 * Update older pages to the current writing rules, in bulk, from Settings >
 * Wiki health.
 *
 * Each release can change the writing rules (lib/writing-rules.ts); pages
 * remember the rules they were written under (lib/draft-rules.ts). A compile
 * only adds to a page, so pages written under earlier rules keep their text
 * until they are rebuilt from their sources. This module counts those pages,
 * estimates what rebuilding them costs and how long it takes, and, only
 * after the user confirms those numbers, rebuilds them one at a time with
 * redraftPage (lib/redraft.ts). Every rebuild archives the page's previous
 * version, which "Restore this version" on the page puts back.
 *
 * CLAUDE.md rule 7 (an LLM-per-item loop needs a hard iteration cap and a
 * default-off flag), as approved for this feature:
 *   - Fixed iteration bound: a run processes exactly the pages counted when
 *     the user confirmed, oldest first, never more. It refuses to start if
 *     more pages need updating than the user was shown, and pages that
 *     appear mid-run wait for the next run.
 *   - Spend guard: the run stops once its measured spend (GET /llm/usage
 *     deltas; new compiles are refused while it runs, see
 *     lib/page-upgrade-state.ts) passes PAGE_UPGRADE_MAX_OVERSPEND × the
 *     confirmed high estimate.
 *   - Default-off flag: the setting page_upgrade_enabled stays '0' until the
 *     user's confirmation (POST /api/wiki/page-upgrade/start) sets it. The
 *     loop refuses to start without it and re-checks it before every page;
 *     Stop, the end of every run and an app restart (instrumentation.ts) set
 *     it back to '0', so each run needs its own confirmation. Backups never
 *     carry it.
 *   - It also stops at the daily LLM ceiling (nlp-service 503
 *     daily_cost_ceiling), on Stop, after PAGE_UPGRADE_MAX_CONSECUTIVE_FAILURES
 *     failures in a row, or when a compile session starts.
 * Page-level refusals skip that page and continue. A page its sources can't
 * rebuild (no readable sources, a draft too short to commit) is also set
 * aside: listed on the card and neither offered nor charged again until it
 * changes. A page that changed or was busy meanwhile is simply retried by the
 * next run.
 *
 * The run lives in the Next.js process: the browser talks only to the
 * /api/wiki/page-upgrade routes, never to nlp-service or n8n. An app restart
 * ends it. Updated pages carry the current marker, so "Update all" again
 * continues with the pages that are left and no page is charged twice.
 */

import { randomUUID } from 'node:crypto';

import {
  getCompileModel,
  getPage,
  getRunningCompileSession,
  getSetting,
  logActivity,
  readPageMarkdown,
  readRawMarkdown,
  setSetting,
} from './db';
import {
  CURRENT_DRAFT_RULES,
  SET_ASIDE_REASONS,
  countCurrentPages,
  getCandidateSourceIds,
  isUpgradeCandidate,
  listSetAsidePages,
  listUpgradeCandidates,
  setPageAside,
  type SetAsidePage,
  type UpgradeCandidate,
} from './draft-rules';
import { LLM_MODEL_INFO, isLlmModel, type LlmModel } from './llm-models';
import {
  estimateUpgrade,
  exceedsBudget,
  formatSpent,
  formatUsd,
  type DraftPricing,
  type PageEstimateInput,
  type UpgradeEstimate,
} from './page-upgrade-estimate';
import {
  PAGE_UPGRADE_FLAG,
  PAGE_UPGRADE_NOTICE_DISMISSED,
  pageUpgradeState,
  type PageUpgradeIssue,
  type PageUpgradeRun,
  type PageUpgradeStopReason,
} from './page-upgrade-state';
import { listHeldPageIds } from './page-hold';
import { RedraftError, redraftPage } from './redraft';
import { isWikiRepairRunning } from './wiki-repair/state';

export { PAGE_UPGRADE_FLAG, PAGE_UPGRADE_NOTICE_DISMISSED } from './page-upgrade-state';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

/** Rule 7 spend guard: stop once a run spends more than this × its confirmed high estimate. */
export const PAGE_UPGRADE_MAX_OVERSPEND = 1.5;
/** Stop after this many failed pages in a row (skips don't reset the count). */
export const PAGE_UPGRADE_MAX_CONSECUTIVE_FAILURES = 3;

const MAX_LISTED_ISSUES = 50;

/** redraftPage refusals about the page itself: skip it and go on. */
const SKIP_CODES: ReadonlySet<string> = new Set([
  'no_readable_sources',
  'draft_too_thin',
  'page_not_found',
  'page_not_redraftable',
  'page_changed',
  'page_flush_pending',
  'page_action_in_progress',
]);

export class PageUpgradeError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

// ── nlp-service reads ──────────────────────────────────────────────────────

/** GET /llm/usage on the nlp-service (routers/llm.py LLMUsageResponse). */
export interface LlmUsage {
  date: string;
  total_usd: number;
  daily_cap_usd: number;
  /** -1 when no daily cap is set. */
  remaining_usd: number;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export async function fetchDraftPricing(model: LlmModel): Promise<DraftPricing> {
  const res = await fetch(`${NLP_SERVICE_URL}/llm/pricing?model=${encodeURIComponent(model)}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`llm_pricing_failed: ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  const numeric = [
    'input_usd_per_m',
    'output_usd_per_m',
    'cached_input_usd_per_m',
    'draft_thinking_budget',
    'draft_max_output_tokens',
    'draft_prompt_char_cap',
  ] as const;
  for (const key of numeric) {
    if (!isFiniteNumber(body[key])) throw new Error(`llm_pricing_invalid: ${key}`);
  }
  if (typeof body.draft_thinking_budget_is_cap !== 'boolean') {
    throw new Error('llm_pricing_invalid: draft_thinking_budget_is_cap');
  }
  return {
    input_usd_per_m: body.input_usd_per_m as number,
    output_usd_per_m: body.output_usd_per_m as number,
    cached_input_usd_per_m: body.cached_input_usd_per_m as number,
    draft_thinking_budget: body.draft_thinking_budget as number,
    draft_thinking_budget_is_cap: body.draft_thinking_budget_is_cap,
    draft_max_output_tokens: body.draft_max_output_tokens as number,
    draft_prompt_char_cap: body.draft_prompt_char_cap as number,
  };
}

export async function fetchLlmUsage(): Promise<LlmUsage> {
  const res = await fetch(`${NLP_SERVICE_URL}/llm/usage`, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`llm_usage_failed: ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  if (
    typeof body.date !== 'string' ||
    !isFiniteNumber(body.total_usd) ||
    !isFiniteNumber(body.daily_cap_usd) ||
    !isFiniteNumber(body.remaining_usd)
  ) {
    throw new Error('llm_usage_invalid');
  }
  return {
    date: body.date,
    total_usd: body.total_usd,
    daily_cap_usd: body.daily_cap_usd,
    remaining_usd: body.remaining_usd,
  };
}

async function readUsageQuietly(): Promise<LlmUsage | null> {
  try {
    return await fetchLlmUsage();
  } catch {
    return null;
  }
}

/**
 * Spend between two /llm/usage readings. The counter restarts at midnight
 * UTC, so on a new day the new total is all spend since then.
 */
export function spendDelta(previous: LlmUsage, next: LlmUsage): number {
  if (next.date !== previous.date) return Math.max(0, next.total_usd);
  return Math.max(0, next.total_usd - previous.total_usd);
}

// ── Estimate inputs ────────────────────────────────────────────────────────

interface SizeCache {
  /** source_id → characters. Raw sources never change once stored. */
  sources: Map<string, number>;
  /** page_id → characters at a given last_updated. */
  pages: Map<string, { stamp: string; chars: number }>;
}

const SIZE_CACHE_KEY = '__komplPageUpgradeSizes';

function sizeCache(): SizeCache {
  const g = globalThis as { [SIZE_CACHE_KEY]?: SizeCache };
  return (g[SIZE_CACHE_KEY] ??= { sources: new Map(), pages: new Map() });
}

function sourceChars(sourceId: string): number {
  const cache = sizeCache().sources;
  const hit = cache.get(sourceId);
  if (hit !== undefined) return hit;
  let chars = 0;
  try {
    chars = readRawMarkdown(sourceId)?.length ?? 0;
  } catch {
    chars = 0;
  }
  cache.set(sourceId, chars);
  return chars;
}

function pageChars(pageId: string, stamp: string): number {
  const cache = sizeCache().pages;
  const hit = cache.get(pageId);
  if (hit && hit.stamp === stamp) return hit.chars;
  let chars = 0;
  try {
    chars = readPageMarkdown(pageId)?.length ?? 0;
  } catch {
    chars = 0;
  }
  cache.set(pageId, { stamp, chars });
  return chars;
}

/** Sizes the estimate needs for each page waiting for an update (cached reads). */
export function gatherEstimateInputs(candidates: ReadonlyArray<UpgradeCandidate>): PageEstimateInput[] {
  const sourcesByPage = getCandidateSourceIds();
  return candidates.map((c) => {
    const sourceIds = sourcesByPage.get(c.page_id) ?? [];
    return {
      source_chars: sourceIds.reduce((sum, id) => sum + sourceChars(id), 0),
      source_count: sourceIds.length,
      page_chars: pageChars(c.page_id, c.last_updated),
    };
  });
}

/** Test-only: forget cached source and page sizes. */
export function __clearPageUpgradeSizeCacheForTesting(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__clearPageUpgradeSizeCacheForTesting may only be called when NODE_ENV=test');
  }
  sizeCache().sources.clear();
  sizeCache().pages.clear();
}

// ── Views ──────────────────────────────────────────────────────────────────

export interface PageUpgradeRunView extends PageUpgradeRun {
  model_label: string;
  /** One line on why a stopped run stopped; null while running or after finishing. */
  stop_message: string | null;
}

function modelLabel(model: string): string {
  return isLlmModel(model) ? LLM_MODEL_INFO[model].label : model;
}

function stopMessage(run: PageUpgradeRun): string | null {
  if (run.status !== 'stopped') return null;
  switch (run.stop_reason) {
    case 'compile_started':
      return 'Stopped because a compile started.';
    case 'daily_cost_ceiling':
      return "Stopped at today's LLM spending limit.";
    case 'consecutive_failures':
      return `Stopped after ${PAGE_UPGRADE_MAX_CONSECUTIVE_FAILURES} failures in a row.`;
    case 'overspend':
      return `Stopped after spending ${formatSpent(run.spent_usd)}, more than ${PAGE_UPGRADE_MAX_OVERSPEND} × the high estimate (${formatUsd(run.estimate.cost_usd_high)}).`;
    case 'error':
      return 'Stopped by an unexpected error.';
    default:
      return 'Stopped.';
  }
}

function viewOf(run: PageUpgradeRun): PageUpgradeRunView {
  return {
    ...run,
    estimate: { ...run.estimate },
    failures: [...run.failures],
    skips: [...run.skips],
    model_label: modelLabel(run.model),
    stop_message: stopMessage(run),
  };
}

export function getPageUpgradeRunView(): PageUpgradeRunView | null {
  const run = pageUpgradeState().run;
  return run ? viewOf(run) : null;
}

export interface PageUpgradeOverview {
  /** The rules pages are updated to (lib/writing-rules.ts CURRENT_DRAFT_RULES). */
  rules: string;
  /** Pages written under earlier rules that an update can rebuild. */
  candidates: number;
  /** Of those, pages archived after a failed rewrite, which an update brings back (lib/page-hold.ts). */
  held: number;
  /** Pages Kompl drafts that already follow the current rules. */
  current_pages: number;
  /** Pages an update could not rebuild; not offered again until they change. */
  set_aside: SetAsidePage[];
  model: { id: LlmModel; label: string };
  estimate: Pick<UpgradeEstimate, 'pages' | 'cost_usd_low' | 'cost_usd_high' | 'minutes_low' | 'minutes_high'> | null;
  /** Why there is no estimate (nlp-service unreachable); null otherwise. */
  estimate_error: string | null;
  /** Today's LLM spending; null when it couldn't be read. */
  budget: { daily_cap_usd: number | null; spent_today_usd: number; remaining_usd: number | null } | null;
  /** The high estimate is more than today's remaining spending limit. */
  over_budget: boolean;
  compile_running: boolean;
  run: PageUpgradeRunView | null;
  max_overspend: number;
}

function budgetOf(usage: LlmUsage): NonNullable<PageUpgradeOverview['budget']> {
  return {
    daily_cap_usd: usage.daily_cap_usd > 0 ? usage.daily_cap_usd : null,
    spent_today_usd: usage.total_usd,
    remaining_usd: usage.remaining_usd >= 0 ? usage.remaining_usd : null,
  };
}

/** What Settings > Wiki health shows. `withEstimate: false` skips the nlp-service reads (progress polls). */
export async function getPageUpgradeOverview(opts: { withEstimate: boolean }): Promise<PageUpgradeOverview> {
  const model = getCompileModel();
  const candidates = listUpgradeCandidates();
  const overview: PageUpgradeOverview = {
    rules: CURRENT_DRAFT_RULES,
    candidates: candidates.length,
    held: (() => {
      const heldIds = listHeldPageIds();
      return candidates.filter((c) => heldIds.has(c.page_id)).length;
    })(),
    current_pages: countCurrentPages(),
    set_aside: listSetAsidePages(),
    model: { id: model, label: LLM_MODEL_INFO[model].label },
    estimate: null,
    estimate_error: null,
    budget: null,
    over_budget: false,
    compile_running: Boolean(getRunningCompileSession()),
    run: getPageUpgradeRunView(),
    max_overspend: PAGE_UPGRADE_MAX_OVERSPEND,
  };
  if (!opts.withEstimate || candidates.length === 0) return overview;

  let pricing: DraftPricing;
  try {
    pricing = await fetchDraftPricing(model);
  } catch {
    overview.estimate_error = "Kompl's NLP service did not respond, so the cost cannot be estimated right now.";
    return overview;
  }
  const estimate = estimateUpgrade(gatherEstimateInputs(candidates), pricing, model);
  overview.estimate = {
    pages: estimate.pages,
    cost_usd_low: estimate.cost_usd_low,
    cost_usd_high: estimate.cost_usd_high,
    minutes_low: estimate.minutes_low,
    minutes_high: estimate.minutes_high,
  };
  const usage = await readUsageQuietly();
  if (usage) {
    overview.budget = budgetOf(usage);
    overview.over_budget = exceedsBudget(estimate.cost_usd_high, overview.budget.remaining_usd);
  }
  return overview;
}

// ── Confirm, launch, stop ──────────────────────────────────────────────────

export interface PreparedPageUpgrade {
  model: LlmModel;
  /** The fixed iteration bound: these pages, in this order, and no others. */
  pageIds: string[];
  estimate: UpgradeEstimate;
  usage: LlmUsage;
}

/**
 * The user's explicit confirmation of the numbers they were shown. Checks
 * that those numbers still hold, recomputes the estimate for the pages that
 * will run, and arms the rule-7 flag. Throws PageUpgradeError otherwise.
 */
export async function confirmPageUpgrade(input: { expectedPages: number; model: string }): Promise<PreparedPageUpgrade> {
  const refuseIfCompiling = () => {
    if (getRunningCompileSession()) {
      throw new PageUpgradeError('session_in_progress', 409, 'A compile is running. Pages can be updated once it finishes.');
    }
    if (isWikiRepairRunning()) {
      throw new PageUpgradeError('wiki_repair_in_progress', 409, 'The wiki is being repaired. Pages can be updated once the repair finishes.');
    }
  };
  refuseIfCompiling();
  const model = getCompileModel();
  if (input.model !== model) {
    throw new PageUpgradeError(
      'model_changed',
      409,
      `The compile model is now ${LLM_MODEL_INFO[model].label}. Review the new estimate and confirm again.`,
    );
  }
  const candidates = listUpgradeCandidates();
  if (candidates.length === 0) {
    throw new PageUpgradeError('no_candidates', 409, 'No pages need updating.');
  }
  if (candidates.length > input.expectedPages) {
    throw new PageUpgradeError(
      'candidates_changed',
      409,
      `${candidates.length === 1 ? '1 page now needs' : `${candidates.length} pages now need`} updating, not ${input.expectedPages}. Review the new estimate and confirm again.`,
      { candidates: candidates.length },
    );
  }

  let pricing: DraftPricing;
  try {
    pricing = await fetchDraftPricing(model);
  } catch {
    throw new PageUpgradeError(
      'estimate_unavailable',
      503,
      "Kompl's NLP service did not respond, so the cost cannot be estimated. Try again in a moment.",
    );
  }
  let usage: LlmUsage;
  try {
    usage = await fetchLlmUsage();
  } catch {
    throw new PageUpgradeError(
      'usage_unavailable',
      503,
      "Kompl cannot read today's LLM spending, so it cannot keep the update within its estimate. Try again in a moment.",
    );
  }
  refuseIfCompiling(); // the awaits above gave a compile time to start

  const estimate = estimateUpgrade(gatherEstimateInputs(candidates), pricing, model);
  setSetting(PAGE_UPGRADE_FLAG, '1');
  return { model, pageIds: candidates.map((c) => c.page_id), estimate, usage };
}

/** Start the loop for a confirmed run. Refuses without the rule-7 flag. */
export function launchPageUpgrade(prepared: PreparedPageUpgrade): { run: PageUpgradeRunView; finished: Promise<void> } {
  const state = pageUpgradeState();
  if (state.run?.status === 'running') {
    throw new PageUpgradeError('already_running', 409, 'Pages are already being updated.');
  }
  if (getSetting(PAGE_UPGRADE_FLAG) !== '1') {
    throw new PageUpgradeError(
      'upgrade_not_enabled',
      409,
      'Updating pages requires your confirmation in Settings → Wiki health.',
    );
  }

  const { estimate } = prepared;
  const run: PageUpgradeRun = {
    run_id: randomUUID(),
    status: 'running',
    stop_requested: false,
    model: prepared.model,
    total: prepared.pageIds.length,
    done: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    consecutive_failures: 0,
    current_page_id: null,
    current_title: null,
    estimate: {
      cost_usd_low: estimate.cost_usd_low,
      cost_usd_high: estimate.cost_usd_high,
      minutes_low: estimate.minutes_low,
      minutes_high: estimate.minutes_high,
    },
    spend_limit_usd: PAGE_UPGRADE_MAX_OVERSPEND * estimate.cost_usd_high,
    spent_usd: 0,
    stop_reason: null,
    last_error: null,
    failures: [],
    skips: [],
    started_at: new Date().toISOString(),
    finished_at: null,
  };
  state.run = run;
  // Acting on the update counts as having seen the one-time notice.
  setSetting(PAGE_UPGRADE_NOTICE_DISMISSED, CURRENT_DRAFT_RULES);
  logActivity('page_upgrade_run', {
    source_id: null,
    details: {
      phase: 'started',
      rules: CURRENT_DRAFT_RULES,
      run_id: run.run_id,
      model: run.model,
      pages: run.total,
      estimate_usd_low: estimate.cost_usd_low,
      estimate_usd_high: estimate.cost_usd_high,
      spend_limit_usd: run.spend_limit_usd,
    },
  });

  const perPageHighUsd = prepared.pageIds.length > 0 ? estimate.raw.cost_usd_high / prepared.pageIds.length : 0;
  const finished = processPages(run, prepared.pageIds, prepared.usage, perPageHighUsd);
  return { run: viewOf(run), finished };
}

/** Confirm and launch: what POST /api/wiki/page-upgrade/start does. */
export async function startPageUpgrade(input: {
  expectedPages: number;
  model: string;
}): Promise<{ run: PageUpgradeRunView; finished: Promise<void> }> {
  const state = pageUpgradeState();
  if (state.starting || state.run?.status === 'running') {
    throw new PageUpgradeError('already_running', 409, 'Pages are already being updated.');
  }
  state.starting = true;
  try {
    return launchPageUpgrade(await confirmPageUpgrade(input));
  } finally {
    state.starting = false;
  }
}

/** Stop before the next page (the page being updated finishes first). */
export function requestPageUpgradeStop(): PageUpgradeRunView | null {
  const run = pageUpgradeState().run;
  if (!run || run.status !== 'running') return null;
  run.stop_requested = true;
  setSetting(PAGE_UPGRADE_FLAG, '0');
  return viewOf(run);
}

// ── The loop ───────────────────────────────────────────────────────────────

function pushIssue(list: PageUpgradeIssue[], issue: PageUpgradeIssue): void {
  list.push(issue);
  if (list.length > MAX_LISTED_ISSUES) list.shift();
}

function stopReasonBeforePage(run: PageUpgradeRun): PageUpgradeStopReason | null {
  if (run.stop_requested) return 'user';
  if (getSetting(PAGE_UPGRADE_FLAG) !== '1') return 'flag_off';
  if (getRunningCompileSession()) return 'compile_started';
  if (run.spent_usd > run.spend_limit_usd) return 'overspend';
  return null;
}

function endRun(run: PageUpgradeRun, status: 'finished' | 'stopped', reason: PageUpgradeStopReason | null): void {
  run.status = status;
  run.stop_reason = reason;
  run.current_page_id = null;
  run.current_title = null;
  run.finished_at = new Date().toISOString();
  try {
    // Disarm: the next run needs a new confirmation.
    setSetting(PAGE_UPGRADE_FLAG, '0');
    logActivity('page_upgrade_run', {
      source_id: null,
      details: {
        phase: status,
        rules: CURRENT_DRAFT_RULES,
        run_id: run.run_id,
        reason,
        model: run.model,
        pages: run.total,
        done: run.done,
        updated: run.updated,
        skipped: run.skipped,
        failed: run.failed,
        spent_usd: Math.round(run.spent_usd * 10_000) / 10_000,
      },
    });
  } catch (err) {
    console.error('[page-upgrade] could not record the end of the run', run.run_id, err);
  }
}

async function processPages(
  run: PageUpgradeRun,
  pageIds: ReadonlyArray<string>,
  usageAtStart: LlmUsage,
  perPageHighUsd: number,
): Promise<void> {
  let lastUsage = usageAtStart;
  try {
    for (const pageId of pageIds) {
      const reason = stopReasonBeforePage(run);
      if (reason) return endRun(run, 'stopped', reason);

      const page = getPage(pageId);
      if (!page || !isUpgradeCandidate(pageId)) {
        // Updated (or removed) since the run was confirmed: never charged twice.
        run.done++;
        run.skipped++;
        pushIssue(run.skips, {
          page_id: pageId,
          title: page?.title ?? pageId,
          error: 'already_current',
          message: page ? 'Already follows the current rules.' : 'The page no longer exists.',
        });
        continue;
      }

      run.current_page_id = pageId;
      run.current_title = page.title;
      let stopAfter: PageUpgradeStopReason | null = null;
      try {
        await redraftPage(pageId, { model: run.model as LlmModel });
        run.updated++;
        run.done++;
        run.consecutive_failures = 0;
      } catch (err) {
        const code = err instanceof RedraftError ? err.code : 'unexpected';
        const message = err instanceof Error ? err.message : String(err);
        if (code === 'daily_cost_ceiling') {
          // Not the page's fault: it stays waiting for the next run.
          run.last_error = message;
          stopAfter = 'daily_cost_ceiling';
        } else if (code === 'session_in_progress') {
          stopAfter = 'compile_started';
        } else if (SKIP_CODES.has(code)) {
          run.done++;
          run.skipped++;
          pushIssue(run.skips, { page_id: pageId, title: page.title, error: code, message });
          // Its sources can't rebuild it as it is now: don't offer or charge
          // it again until it changes (lib/draft-rules.ts).
          if (SET_ASIDE_REASONS.has(code)) setPageAside(page, code);
        } else {
          run.done++;
          run.failed++;
          run.consecutive_failures++;
          const detail = err instanceof RedraftError && typeof err.extra.detail === 'string' ? ` (${err.extra.detail})` : '';
          run.last_error = `${message}${detail}`;
          pushIssue(run.failures, { page_id: pageId, title: page.title, error: code, message: `${message}${detail}` });
          if (code === 'unexpected') console.error('[page-upgrade] unexpected error on', pageId, err);
          if (run.consecutive_failures >= PAGE_UPGRADE_MAX_CONSECUTIVE_FAILURES) stopAfter = 'consecutive_failures';
        }
      }
      run.current_page_id = null;
      run.current_title = null;

      // Spend since the last reading. Without a reading, count the page at
      // its high estimate, which only ever makes the guard stop sooner.
      const usage = await readUsageQuietly();
      if (usage) {
        run.spent_usd += spendDelta(lastUsage, usage);
        lastUsage = usage;
      } else {
        run.spent_usd += perPageHighUsd;
      }

      if (stopAfter) return endRun(run, 'stopped', stopAfter);
    }
    endRun(run, 'finished', null);
  } catch (err) {
    run.last_error = err instanceof Error ? err.message : String(err);
    console.error('[page-upgrade] run stopped by an unexpected error', run.run_id, err);
    endRun(run, 'stopped', 'error');
  }
}
