/**
 * Steps 2–6 of a confirmed wiki repair run (lib/wiki-repair/run.ts takes the
 * backup, step 1, before it calls this):
 *   2. aliases   the set-aside name matches confirmed, judged by the AI
 *   3. mentions  every source's mentions credited again from its extraction
 *   4. links     links written through name matches no longer used corrected
 *                (no AI call)
 *   5. pages     the pages whose credited sources changed rebuilt from them
 *   6. labels    labels that mean the same thing merged
 *
 * All or none: the run stops at the first thing that goes wrong (the daily
 * spending limit, a rate limit, the NLP service, 3 failed pages in a row,
 * an unexpected error), on Stop, or when it has spent more than
 * REPAIR_MAX_OVERSPEND × the confirmed high estimate. It never goes on to a
 * later step after a stop; the backup stays, Settings says what was done and
 * offers it for a restore, and the pages still to rebuild stay listed for
 * the next run. One activity row per finished step, one for the end.
 */

import { getAliases, getDb, getPage, getSetting, logActivity, setSetting } from '../db';
import { fetchLlmUsage, spendDelta, type LlmUsage } from '../page-upgrade';
import { RedraftError, redraftPage } from '../redraft';
import type { LlmModel } from '../llm-models';
import { applyAliasVerdicts, buildJudgePairs, judgeBatch, judgeBatches, listAliasesToJudge } from './aliases';
import { RepairCallError, type RepairCallCode } from './calls';
import { applyLabelMerges, consolidateWikiLabels, repairLabels } from './labels';
import { REPAIR_MAX_CONSECUTIVE_FAILURES, WIKI_REPAIR_FLAG } from './limits';
import { applyLinkFixes } from './links';
import { mergePendingPages, readWikiExtractions, recreditMentions } from './mentions';
import { saveRun, type RepairIssue, type RepairRun, type RepairStep, type RepairStopReason } from './state';

const MAX_LISTED_ISSUES = 50;

/** RedraftError codes about the page as it is now: it keeps its text and sources and leaves the list. */
const SET_ASIDE_CODES: ReadonlySet<string> = new Set(['draft_too_thin', 'page_not_found', 'page_not_redraftable']);
/** RedraftError codes about this moment: the page stays listed for the next run. */
const RETRY_CODES: ReadonlySet<string> = new Set(['page_changed', 'page_flush_pending', 'page_action_in_progress']);

const CALL_STOP: Record<RepairCallCode, RepairStopReason> = {
  daily_cost_ceiling: 'daily_cost_ceiling',
  rate_limited: 'rate_limited',
  nlp_unreachable: 'nlp_unreachable',
  call_failed: 'error',
};

class Stop extends Error {
  constructor(readonly reason: RepairStopReason, message?: string) {
    super(message ?? reason);
  }
}

export interface StepContext {
  /** The name matches confirmed (alias row ids): the step's fixed bound. */
  aliasIds: number[];
  usage: LlmUsage;
  /** Spend counted per AI call when /llm/usage can't be read (the high estimate per call). */
  perCallHighUsd: number;
}

function pushIssue(run: RepairRun, issue: RepairIssue): void {
  run.issues.push(issue);
  if (run.issues.length > MAX_LISTED_ISSUES) run.issues.shift();
}

function stepDetails(run: RepairRun, step: RepairStep): Record<string, unknown> {
  switch (step) {
    case 'backup':
      return { file: run.backup?.file ?? null, bytes: run.backup?.bytes ?? null };
    case 'aliases':
      return { ...run.aliases };
    case 'mentions':
      return { sources: run.mentions?.sources ?? 0, pages: run.mentions?.pages ?? 0 };
    case 'links':
      return { ...(run.links ?? { pages: 0, links: 0, missed: 0 }) };
    case 'pages': {
      const { current_title: _t, consecutive_failures: _c, ...pages } = run.pages;
      return { ...pages, waiting: run.pending_pages.length };
    }
    case 'labels':
      return { ...(run.labels ?? { merged: 0, pages: 0 }) };
  }
}

/** Records a finished step: one activity row, and the run's record. */
export function finishStep(run: RepairRun, step: RepairStep): void {
  run.steps_done.push(step);
  logActivity('wiki_repair', {
    source_id: null,
    details: { phase: 'step', step, run_id: run.run_id, ...stepDetails(run, step) },
  });
  saveRun(run);
}

function endRun(run: RepairRun, status: 'finished' | 'stopped', reason: RepairStopReason | null): void {
  run.status = status;
  run.stop_reason = reason;
  run.pages.current_title = null;
  run.finished_at = new Date().toISOString();
  if (status === 'finished') run.step = null;
  try {
    setSetting(WIKI_REPAIR_FLAG, '0'); // the next run needs a new confirmation
    logActivity('wiki_repair', {
      source_id: null,
      details: {
        phase: status,
        reason,
        step: run.step,
        run_id: run.run_id,
        model: run.model,
        steps_done: run.steps_done,
        backup: run.backup?.file ?? null,
        aliases_confirmed: run.aliases.confirmed,
        aliases_retired: run.aliases.retired,
        links_corrected: run.links?.links ?? 0,
        pages_rebuilt: run.pages.rebuilt,
        pages_waiting: run.pending_pages.length,
        labels_merged: run.labels?.merged ?? 0,
        spent_usd: Math.round(run.spent_usd * 10_000) / 10_000,
      },
    });
    saveRun(run);
  } catch (err) {
    console.error('[wiki-repair] could not record the end of the run', run.run_id, err);
  }
}

export async function runRepairSteps(run: RepairRun, ctx: StepContext): Promise<void> {
  const db = getDb();
  let lastUsage = ctx.usage;
  const measure = async () => {
    try {
      const usage = await fetchLlmUsage();
      run.spent_usd += spendDelta(lastUsage, usage);
      lastUsage = usage;
    } catch {
      run.spent_usd += ctx.perCallHighUsd; // only ever stops the run sooner
    }
  };
  const check = () => {
    if (run.stop_requested) throw new Stop('user');
    if (getSetting(WIKI_REPAIR_FLAG) !== '1') throw new Stop('flag_off');
    if (run.spent_usd > run.spend_limit_usd) throw new Stop('overspend');
  };
  const enter = (step: RepairStep) => {
    check();
    run.step = step;
    saveRun(run);
  };
  // An AI call that must stop the run: what it may have spent is measured first.
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RepairCallError)) throw err;
      await measure();
      throw new Stop(CALL_STOP[err.code], err.message);
    }
  };

  try {
    // ── 2. Name matches ──
    enter('aliases');
    const ids = new Set(ctx.aliasIds);
    const rows = listAliasesToJudge(db).filter((r) => ids.has(r.id));
    run.aliases.total = rows.length;
    for (const batch of judgeBatches(buildJudgePairs(db, rows, readWikiExtractions(db)))) {
      check();
      const verdicts = await call(() => judgeBatch(batch, run.model));
      await measure();
      const counts = applyAliasVerdicts(db, batch, verdicts);
      run.aliases.judged += batch.length;
      run.aliases.confirmed += counts.confirmed;
      run.aliases.retired += counts.retired;
      run.aliases.undecided += counts.undecided + counts.unanswered;
      saveRun(run);
    }
    finishStep(run, 'aliases');

    // ── 3. Mentions ──
    enter('mentions');
    recreditMentions(db, getAliases(), (changes, sources) => {
      run.pending_pages = mergePendingPages(run.pending_pages, changes);
      run.mentions = { sources, pages: changes.length };
      saveRun(run); // with the rows, in their transaction
    });
    finishStep(run, 'mentions');

    // ── 4. Links through name matches no longer used (no AI call) ──
    enter('links');
    run.links = { pages: 0, links: 0, missed: 0 };
    await applyLinkFixes(db, () => {
      check();
      saveRun(run);
    }, run.links);
    finishStep(run, 'links');

    // ── 5. Pages ──
    enter('pages');
    const queue = run.pending_pages.slice(0, run.confirmed.max_pages);
    const overflow = run.pending_pages.length > queue.length;
    run.pages.total = queue.length;
    for (const pending of queue) {
      check();
      const drop = () => {
        run.pending_pages = run.pending_pages.filter((p) => p.page_id !== pending.page_id);
      };
      const page = getPage(pending.page_id);
      if (!page) {
        drop();
        run.pages.done++;
        run.pages.skipped++;
        saveRun(run);
        continue;
      }
      run.pages.current_title = page.title;
      saveRun(run);
      let stopAfter: Stop | null = null;
      try {
        await redraftPage(pending.page_id, {
          model: run.model as LlmModel,
          credits: { remove: pending.remove, add: pending.add },
          quiet: true,
        });
        drop();
        run.pages.rebuilt++;
        run.pages.consecutive_failures = 0;
      } catch (err) {
        const code = err instanceof RedraftError ? err.code : 'unexpected';
        const message = err instanceof Error ? err.message : String(err);
        if (code === 'daily_cost_ceiling') stopAfter = new Stop('daily_cost_ceiling', message);
        else if (code === 'llm_rate_limited') stopAfter = new Stop('rate_limited', message);
        else if (code === 'session_in_progress') stopAfter = new Stop('error', message);
        else if (code === 'no_readable_sources' || SET_ASIDE_CODES.has(code)) {
          // Its sources can't rebuild it: it keeps its text and its sources.
          drop();
          run.pages.skipped++;
          pushIssue(run, {
            page_id: page.page_id,
            title: page.title,
            reason: code === 'no_readable_sources' ? 'no_sources_left' : code,
            message,
          });
        } else if (RETRY_CODES.has(code)) {
          run.pages.skipped++;
          pushIssue(run, { page_id: page.page_id, title: page.title, reason: code, message });
        } else {
          run.pages.failed++;
          run.pages.consecutive_failures++;
          run.last_error = message;
          pushIssue(run, { page_id: page.page_id, title: page.title, reason: code, message });
          if (code === 'unexpected') console.error('[wiki-repair] unexpected error on', page.page_id, err);
          if (run.pages.consecutive_failures >= REPAIR_MAX_CONSECUTIVE_FAILURES) stopAfter = new Stop('consecutive_failures');
        }
      }
      if (!stopAfter || stopAfter.reason === 'consecutive_failures') run.pages.done++;
      run.pages.current_title = null;
      await measure();
      saveRun(run);
      if (stopAfter) throw stopAfter;
    }
    finishStep(run, 'pages');

    // ── 6. Labels ──
    enter('labels');
    const target = await call(() => consolidateWikiLabels(repairLabels(), run.model));
    await measure();
    const outcome = await applyLabelMerges(db, target);
    run.labels = { merged: outcome.merged, pages: outcome.pages };
    finishStep(run, 'labels');

    if (overflow) endRun(run, 'stopped', 'pages_over_confirmed');
    else endRun(run, 'finished', null);
  } catch (err) {
    if (err instanceof Stop) {
      if (err.message !== err.reason) run.last_error = err.message;
      endRun(run, 'stopped', err.reason);
      return;
    }
    run.last_error = err instanceof Error ? err.message : String(err);
    console.error('[wiki-repair] run stopped by an unexpected error', run.run_id, err);
    endRun(run, 'stopped', 'error');
  }
}
