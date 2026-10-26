/**
 * The bulk page update (lib/page-upgrade.ts): CLAUDE.md rule 7 in practice.
 *
 * An LLM call per page, possibly hundreds of pages, so the loop must only
 * run after an explicit confirmation (default-off flag), only over the pages
 * the user was shown (fixed bound), and stop on its own: Stop, a compile
 * starting, the daily ceiling, 3 failures in a row, or spending more than
 * 1.5 × the confirmed high estimate. Page-level refusals skip and continue;
 * a second run continues with the pages left and never charges one twice.
 *
 * redraftPage is mocked (its own behaviour is pinned in redraft.test.ts);
 * the nlp-service is mocked at fetch (/llm/pricing, /llm/usage).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/redraft', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/redraft')>();
  return { ...actual, redraftPage: vi.fn() };
});

import { POST as retryPOST } from '../app/api/compile/retry/route';
import { getSetting, setSetting } from '../lib/db';
import { CURRENT_DRAFT_RULES, countUpgradeCandidates, isUpgradeCandidate, listSetAsidePages } from '../lib/draft-rules';
import {
  PAGE_UPGRADE_FLAG,
  PAGE_UPGRADE_MAX_CONSECUTIVE_FAILURES,
  PAGE_UPGRADE_MAX_OVERSPEND,
  PAGE_UPGRADE_NOTICE_DISMISSED,
  PageUpgradeError,
  __clearPageUpgradeSizeCacheForTesting,
  confirmPageUpgrade,
  getPageUpgradeOverview,
  getPageUpgradeRunView,
  launchPageUpgrade,
  requestPageUpgradeStop,
  spendDelta,
  startPageUpgrade,
} from '../lib/page-upgrade';
import { __resetPageUpgradeStateForTesting, isPageUpgradeRunning, pageUpgradeBlock } from '../lib/page-upgrade-state';
import { RedraftError, redraftPage, type RedraftResult } from '../lib/redraft';
import {
  getActivityCounts,
  seedPage,
  seedProvenance,
  seedSource,
  setupTestDb,
  type TestDbHandle,
} from './helpers/test-db';

const redraftMock = vi.mocked(redraftPage);

let handle: TestDbHandle | null = null;
let nlp: NlpMock;

interface NlpMock {
  usageTotal: number;
  usageDate: string;
  pricingStatus: number;
  usageStatus: number;
}

const PRICING = {
  model: 'deepseek-flash',
  provider: 'deepseek',
  input_usd_per_m: 0.3,
  output_usd_per_m: 1.2,
  cached_input_usd_per_m: 0.006,
  thinking_billed_as: 'output',
  draft_thinking_budget: 1024,
  draft_thinking_budget_is_cap: false,
  draft_max_output_tokens: 16384,
  draft_prompt_char_cap: 128000,
};

function mockNlp(): NlpMock {
  const state: NlpMock = { usageTotal: 0, usageDate: '2026-10-10', pricingStatus: 200, usageStatus: 200 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes('/llm/pricing')) {
        return state.pricingStatus === 200 ? Response.json(PRICING) : new Response('down', { status: state.pricingStatus });
      }
      if (u.endsWith('/llm/usage')) {
        if (state.usageStatus !== 200) return new Response('down', { status: state.usageStatus });
        return Response.json({
          date: state.usageDate,
          total_usd: state.usageTotal,
          call_count: 0,
          daily_cap_usd: 5,
          remaining_usd: Math.max(0, 5 - state.usageTotal),
        });
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return state;
}

function ok(pageId: string): RedraftResult {
  return {
    page_id: pageId,
    status: 'redrafted',
    model: 'deepseek-flash',
    sources_used: 1,
    sources_skipped: 0,
    previous_chars: 100,
    new_chars: 100,
    flushed: true,
  };
}

/** What the real redraftPage leaves behind on success: the page marked current. */
function markCurrent(pageId: string): void {
  handle!.db.prepare("UPDATE pages SET draft_rules = 'v0.4' WHERE page_id = ?").run(pageId);
}

type Step = (pageId: string, call: number) => Promise<void> | void;

/** redraftPage succeeds (spending `spend` per page) unless `step` throws first. */
function redraftWith(step?: Step, spend = 0.001): string[] {
  const calls: string[] = [];
  redraftMock.mockImplementation(async (pageId: string) => {
    calls.push(pageId);
    await step?.(pageId, calls.length);
    markCurrent(pageId);
    nlp.usageTotal += spend;
    return ok(pageId);
  });
  return calls;
}

function seedCandidates(n: number): string[] {
  const db = handle!.db;
  const source = seedSource(db, { raw_markdown: 'Source text about the topic. '.repeat(40) });
  const ids: string[] = [];
  // Seeded newest first, so "oldest first" has something to reorder.
  for (let i = n; i >= 1; i--) {
    const id = seedPage(db, { page_id: `page-${i}`, title: `Page ${i}`, page_type: 'concept' });
    db.prepare('UPDATE pages SET created_at = ? WHERE page_id = ?').run(`2026-01-${String(i).padStart(2, '0')} 08:00:00`, id);
    seedProvenance(db, id, source);
    ids.unshift(id);
  }
  return ids;
}

async function runToEnd(expectedPages: number, model = 'deepseek-flash') {
  const { finished } = await startPageUpgrade({ expectedPages, model });
  await finished;
  return getPageUpgradeRunView()!;
}

async function expectRefusal(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof PageUpgradeError && e.code === code);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  handle = setupTestDb();
  nlp = mockNlp();
  __resetPageUpgradeStateForTesting();
  __clearPageUpgradeSizeCacheForTesting();
  redraftMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

describe('opt-in flag (rule 7)', () => {
  it('is off by default and the loop refuses to launch without it', async () => {
    seedCandidates(2);
    redraftWith();
    expect(getSetting(PAGE_UPGRADE_FLAG)).toBeNull();

    const prepared = await confirmPageUpgrade({ expectedPages: 2, model: 'deepseek-flash' });
    expect(getSetting(PAGE_UPGRADE_FLAG)).toBe('1');
    setSetting(PAGE_UPGRADE_FLAG, '0');

    expect(() => launchPageUpgrade(prepared)).toThrow(PageUpgradeError);
    try {
      launchPageUpgrade(prepared);
    } catch (e) {
      expect((e as PageUpgradeError).code).toBe('upgrade_not_enabled');
    }
    expect(redraftMock).not.toHaveBeenCalled();
    expect(getPageUpgradeRunView()).toBeNull();
  });

  it('is armed by the confirmation and disarmed when the run ends', async () => {
    seedCandidates(2);
    redraftWith();
    const run = await runToEnd(2);
    expect(run.status).toBe('finished');
    expect(getSetting(PAGE_UPGRADE_FLAG)).toBe('0');
  });

  it('turned off mid-run stops the loop before the next page', async () => {
    seedCandidates(3);
    const calls = redraftWith((_id, call) => {
      if (call === 1) setSetting(PAGE_UPGRADE_FLAG, '0');
    });
    const run = await runToEnd(3);
    expect(calls).toEqual(['page-1']);
    expect(run).toMatchObject({ status: 'stopped', stop_reason: 'flag_off', updated: 1, done: 1 });
  });
});

describe('a confirmed run', () => {
  it('updates every confirmed page, oldest first, with the confirmed model', async () => {
    const ids = seedCandidates(3);
    const calls = redraftWith();

    const { run: started, finished } = await startPageUpgrade({ expectedPages: 3, model: 'deepseek-flash' });
    expect(started).toMatchObject({ status: 'running', total: 3, model: 'deepseek-flash', model_label: 'DeepSeek V4.1 Flash' });
    expect(started.spend_limit_usd).toBeCloseTo(PAGE_UPGRADE_MAX_OVERSPEND * started.estimate.cost_usd_high, 12);
    await finished;

    expect(calls).toEqual(ids);
    expect(redraftMock).toHaveBeenCalledWith('page-1', { model: 'deepseek-flash' });
    const run = getPageUpgradeRunView()!;
    expect(run).toMatchObject({ status: 'finished', stop_reason: null, total: 3, done: 3, updated: 3, skipped: 0, failed: 0 });
    expect(run.spent_usd).toBeCloseTo(0.003, 9);
    expect(run.stop_message).toBeNull();
    expect(countUpgradeCandidates()).toBe(0);
    expect(getActivityCounts(handle!.db).page_upgrade_run).toBe(2);
    // Acting on the update counts as seeing the one-time notice.
    expect(getSetting(PAGE_UPGRADE_NOTICE_DISMISSED)).toBe(CURRENT_DRAFT_RULES);
  });

  it('never goes past the pages counted at confirmation', async () => {
    seedCandidates(2);
    const calls = redraftWith((_id, call) => {
      if (call === 1) {
        const late = seedPage(handle!.db, { page_id: 'late-page', title: 'Late page', page_type: 'entity' });
        seedProvenance(handle!.db, late, seedSource(handle!.db, { raw_markdown: 'Late.' }));
      }
    });
    const run = await runToEnd(2);
    expect(calls).toEqual(['page-1', 'page-2']);
    expect(run.total).toBe(2);
    expect(isUpgradeCandidate('late-page')).toBe(true);
  });

  it('keeps the model it confirmed when Settings change mid-run', async () => {
    seedCandidates(2);
    redraftWith((_id, call) => {
      if (call === 1) setSetting('compile_model', 'gemini-3.8-flash');
    });
    await runToEnd(2);
    expect(redraftMock).toHaveBeenNthCalledWith(2, 'page-2', { model: 'deepseek-flash' });
  });

  it('skips, without a model call, a page that was updated after confirmation', async () => {
    seedCandidates(3);
    const calls = redraftWith((_id, call) => {
      if (call === 1) markCurrent('page-2');
    });
    const run = await runToEnd(3);
    expect(calls).toEqual(['page-1', 'page-3']);
    expect(run).toMatchObject({ status: 'finished', updated: 2, skipped: 1, done: 3 });
    expect(run.skips[0]).toMatchObject({ page_id: 'page-2', error: 'already_current' });
  });

  it('refuses compiles while it runs', async () => {
    seedCandidates(2);
    handle!.db
      .prepare("INSERT INTO compile_progress (session_id, status, steps, source_count) VALUES ('old-session', 'failed', '{}', 1)")
      .run();
    const gate = deferred();
    redraftWith(async (_id, call) => {
      if (call === 1) await gate.promise;
    });

    const { finished } = await startPageUpgrade({ expectedPages: 2, model: 'deepseek-flash' });
    expect(isPageUpgradeRunning()).toBe(true);
    expect(pageUpgradeBlock()).toMatchObject({ error_code: 'page_upgrade_in_progress' });
    const res = await retryPOST(
      new Request('http://test/api/compile/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'old-session' }),
      }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error_code: string }).error_code).toBe('page_upgrade_in_progress');
    await expectRefusal(startPageUpgrade({ expectedPages: 2, model: 'deepseek-flash' }), 'already_running');

    gate.resolve();
    await finished;
    expect(isPageUpgradeRunning()).toBe(false);
    expect(pageUpgradeBlock()).toBeNull();
  });
});

describe('refusing to start', () => {
  it('when more pages need updating than the user confirmed', async () => {
    seedCandidates(3);
    redraftWith();
    await expectRefusal(startPageUpgrade({ expectedPages: 2, model: 'deepseek-flash' }), 'candidates_changed');
    expect(redraftMock).not.toHaveBeenCalled();
    expect(getSetting(PAGE_UPGRADE_FLAG)).toBeNull();
  });

  it('runs the pages left when fewer need updating than confirmed', async () => {
    seedCandidates(2);
    const calls = redraftWith();
    const run = await runToEnd(5);
    expect(calls).toHaveLength(2);
    expect(run.total).toBe(2);
  });

  it('when the compile model changed since the confirmation', async () => {
    seedCandidates(1);
    await expectRefusal(startPageUpgrade({ expectedPages: 1, model: 'gemini-2.5-flash' }), 'model_changed');
  });

  it('while a compile runs', async () => {
    seedCandidates(1);
    handle!.db
      .prepare("INSERT INTO compile_progress (session_id, status, steps, source_count) VALUES ('s1', 'queued', '{}', 1)")
      .run();
    await expectRefusal(startPageUpgrade({ expectedPages: 1, model: 'deepseek-flash' }), 'session_in_progress');
  });

  it('when every page already uses the current rules', async () => {
    await expectRefusal(startPageUpgrade({ expectedPages: 1, model: 'deepseek-flash' }), 'no_candidates');
  });

  it('without an estimate or a spend reading', async () => {
    seedCandidates(1);
    nlp.pricingStatus = 503;
    await expectRefusal(startPageUpgrade({ expectedPages: 1, model: 'deepseek-flash' }), 'estimate_unavailable');
    nlp.pricingStatus = 200;
    nlp.usageStatus = 500;
    await expectRefusal(startPageUpgrade({ expectedPages: 1, model: 'deepseek-flash' }), 'usage_unavailable');
    expect(getSetting(PAGE_UPGRADE_FLAG)).toBeNull();
    expect(redraftMock).not.toHaveBeenCalled();
  });
});

describe('stopping on its own', () => {
  it('on Stop, before the next page', async () => {
    seedCandidates(3);
    const calls = redraftWith((_id, call) => {
      if (call === 1) expect(requestPageUpgradeStop()?.stop_requested).toBe(true);
    });
    const run = await runToEnd(3);
    expect(calls).toEqual(['page-1']);
    expect(run).toMatchObject({ status: 'stopped', stop_reason: 'user', done: 1, updated: 1 });
    expect(run.stop_message).toBe('Stopped.');
    expect(getSetting(PAGE_UPGRADE_FLAG)).toBe('0');
    expect(requestPageUpgradeStop()).toBeNull();
  });

  it('when a compile starts', async () => {
    seedCandidates(3);
    const calls = redraftWith((_id, call) => {
      if (call === 1) {
        handle!.db
          .prepare("INSERT INTO compile_progress (session_id, status, steps, source_count) VALUES ('new', 'queued', '{}', 1)")
          .run();
      }
    });
    const run = await runToEnd(3);
    expect(calls).toEqual(['page-1']);
    expect(run).toMatchObject({ status: 'stopped', stop_reason: 'compile_started' });
  });

  it("at the daily ceiling, leaving that page for the next run", async () => {
    seedCandidates(3);
    const calls = redraftWith((_id, call) => {
      if (call === 2) throw new RedraftError('daily_cost_ceiling', 503, "Today's LLM spending limit is reached.");
    });
    const run = await runToEnd(3);
    expect(calls).toEqual(['page-1', 'page-2']);
    expect(run).toMatchObject({ status: 'stopped', stop_reason: 'daily_cost_ceiling', done: 1, updated: 1, failed: 0 });
    expect(isUpgradeCandidate('page-2')).toBe(true);
    expect(isUpgradeCandidate('page-3')).toBe(true);
  });

  it('on an empty provider account, saying so (audit M7)', async () => {
    seedCandidates(3);
    const calls = redraftWith((_id, call) => {
      if (call === 1) throw new RedraftError('provider_out_of_credit', 503, 'The AI provider account has no credit left.');
    });
    const run = await runToEnd(3);
    expect(calls).toEqual(['page-1']);
    expect(run).toMatchObject({ status: 'stopped', failed: 0, last_error: 'The AI provider account has no credit left.' });
    expect(isUpgradeCandidate('page-1')).toBe(true);
  });

  it(`after ${PAGE_UPGRADE_MAX_CONSECUTIVE_FAILURES} failures in a row; a success resets the count, a skip does not`, async () => {
    seedCandidates(8);
    const outcome: Record<number, string> = { 1: 'fail', 2: 'fail', 3: 'ok', 4: 'fail', 5: 'skip', 6: 'fail', 7: 'fail', 8: 'ok' };
    const calls = redraftWith((_id, call) => {
      if (outcome[call] === 'fail') throw new RedraftError('draft_failed', 502, 'The model did not return a page.', { detail: 'upstream 500' });
      if (outcome[call] === 'skip') throw new RedraftError('draft_too_thin', 422, 'The new version was too short, so the page was left as it is.');
    });
    const run = await runToEnd(8);
    expect(calls).toHaveLength(7);
    expect(run).toMatchObject({
      status: 'stopped',
      stop_reason: 'consecutive_failures',
      done: 7,
      updated: 1,
      skipped: 1,
      failed: 5,
      consecutive_failures: 3,
    });
    expect(run.failures).toHaveLength(5);
    expect(run.failures[0]).toMatchObject({ page_id: 'page-1', error: 'draft_failed' });
    expect(run.last_error).toBe('The model did not return a page. (upstream 500)');
    expect(run.stop_message).toBe('Stopped after 3 failures in a row.');
  });

  it('when its spend passes 1.5 × the confirmed high estimate', async () => {
    seedCandidates(3);
    const calls = redraftWith(undefined, 25);
    const run = await runToEnd(3);
    expect(calls).toEqual(['page-1']);
    expect(run.spent_usd).toBeCloseTo(25, 9);
    expect(run).toMatchObject({ status: 'stopped', stop_reason: 'overspend' });
    expect(run.stop_message).toMatch(/more than 1\.5 × the high estimate/);
  });

  it('counts a page at its high estimate when spend cannot be read', async () => {
    seedCandidates(2);
    redraftWith((_id, call) => {
      if (call === 1) nlp.usageStatus = 500;
    }, 0);
    const run = await runToEnd(2);
    expect(run.status).toBe('finished');
    expect(run.spent_usd).toBeGreaterThan(0);
  });
});

describe('page-level refusals', () => {
  it('skip the page and continue', async () => {
    seedCandidates(5);
    const calls = redraftWith((_id, call) => {
      if (call === 1) throw new RedraftError('no_readable_sources', 422, "None of this page's sources can be read.");
      if (call === 2) throw new RedraftError('draft_too_thin', 422, 'The new version was too short.');
      if (call === 3) throw new RedraftError('page_changed', 409, 'The page changed while it was being updated.');
    });
    const run = await runToEnd(5);
    expect(calls).toHaveLength(5);
    expect(run).toMatchObject({ status: 'finished', skipped: 3, updated: 2, failed: 0, consecutive_failures: 0 });
    expect(run.skips.map((s) => s.error)).toEqual(['no_readable_sources', 'draft_too_thin', 'page_changed']);
    // Pages their sources can't rebuild are set aside; the page that changed is retried.
    expect(countUpgradeCandidates()).toBe(1);
    expect(listSetAsidePages().map((p) => [p.page_id, p.reason])).toEqual([
      ['page-1', 'no_readable_sources'],
      ['page-2', 'draft_too_thin'],
    ]);
  });

  it('never charge a set-aside page again until it changes', async () => {
    seedCandidates(2);
    redraftWith((id) => {
      if (id === 'page-1') throw new RedraftError('draft_too_thin', 422, 'The new version was too short.');
    });
    expect(await runToEnd(2)).toMatchObject({ status: 'finished', updated: 1, skipped: 1 });
    expect(isUpgradeCandidate('page-1')).toBe(false);
    expect((await getPageUpgradeOverview({ withEstimate: false })).set_aside).toEqual([
      { page_id: 'page-1', title: 'Page 1', reason: 'draft_too_thin' },
    ]);
    // Update all has nothing left to charge for.
    await expectRefusal(confirmPageUpgrade({ expectedPages: 1, model: 'deepseek-flash' }), 'no_candidates');

    // A compile changes the page: it is offered, and updated, again.
    handle!.db.prepare("UPDATE pages SET last_updated = '2030-01-01 00:00:00' WHERE page_id = 'page-1'").run();
    expect(isUpgradeCandidate('page-1')).toBe(true);
    expect(listSetAsidePages()).toEqual([]);
    redraftMock.mockClear();
    redraftWith();
    expect(await runToEnd(1)).toMatchObject({ status: 'finished', total: 1, updated: 1 });
    expect(redraftMock.mock.calls.map((c) => c[0])).toEqual(['page-1']);
  });

  it('treat an unexpected error as a failure, not a crash', async () => {
    seedCandidates(2);
    redraftWith((_id, call) => {
      if (call === 1) throw new Error('socket hang up');
    });
    const run = await runToEnd(2);
    expect(run).toMatchObject({ status: 'finished', failed: 1, updated: 1 });
    expect(run.failures[0]).toMatchObject({ error: 'unexpected', message: 'socket hang up' });
  });
});

describe('resuming', () => {
  it('continues with the pages left and never charges a page twice', async () => {
    seedCandidates(3);
    const calls = redraftWith((_id, call) => {
      if (call === 1) requestPageUpgradeStop();
    });
    const first = await runToEnd(3);
    expect(first).toMatchObject({ status: 'stopped', updated: 1 });
    expect(countUpgradeCandidates()).toBe(2);

    redraftMock.mockClear();
    const second = await runToEnd(2);
    expect(second).toMatchObject({ status: 'finished', total: 2, updated: 2 });
    expect(redraftMock.mock.calls.map((c) => c[0])).toEqual(['page-2', 'page-3']);
    expect(calls).toEqual(['page-1', 'page-2', 'page-3']);
    expect(getActivityCounts(handle!.db).page_upgrade_run).toBe(4);
  });
});

describe('spendDelta', () => {
  const at = (date: string, total_usd: number) => ({ date, total_usd, daily_cap_usd: 5, remaining_usd: 5 - total_usd });

  it('is the difference within a day and the new total after midnight UTC', () => {
    expect(spendDelta(at('2026-10-10', 1.25), at('2026-10-10', 1.4))).toBeCloseTo(0.15, 12);
    expect(spendDelta(at('2026-10-10', 4.9), at('2026-10-11', 0.02))).toBe(0.02);
    expect(spendDelta(at('2026-10-10', 1.4), at('2026-10-10', 1.25))).toBe(0);
  });
});
