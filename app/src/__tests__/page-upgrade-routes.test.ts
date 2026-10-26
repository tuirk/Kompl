/**
 * /api/wiki/page-upgrade (status + estimate), /start, /stop and /notice.
 *
 * The browser only ever talks to these routes: they must show the numbers
 * before anything runs (count, model, cost and time range, spending-limit
 * warning), refuse a malformed or stale confirmation, and show the one-time
 * notice only to wikis with pages written by an earlier version.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/redraft', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/redraft')>();
  return { ...actual, redraftPage: vi.fn() };
});

import { GET as statusGET } from '../app/api/wiki/page-upgrade/route';
import { GET as noticeGET, POST as noticePOST } from '../app/api/wiki/page-upgrade/notice/route';
import { POST as startPOST } from '../app/api/wiki/page-upgrade/start/route';
import { POST as stopPOST } from '../app/api/wiki/page-upgrade/stop/route';
import { getSetting, setSetting } from '../lib/db';
import {
  __clearPageUpgradeSizeCacheForTesting,
  gatherEstimateInputs,
  getPageUpgradeRunView,
  type PageUpgradeOverview,
} from '../lib/page-upgrade';
import { CURRENT_DRAFT_RULES, listUpgradeCandidates } from '../lib/draft-rules';
import { estimateUpgrade } from '../lib/page-upgrade-estimate';
import { __resetPageUpgradeStateForTesting } from '../lib/page-upgrade-state';
import { redraftPage } from '../lib/redraft';
import { seedPage, seedProvenance, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

const redraftMock = vi.mocked(redraftPage);

let handle: TestDbHandle | null = null;
const nlp = { pricingStatus: 200, usageTotal: 0, cap: 5, fetches: [] as string[] };

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

function mockNlp(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      nlp.fetches.push(u);
      if (u.includes('/llm/pricing')) {
        return nlp.pricingStatus === 200 ? Response.json(PRICING) : new Response('down', { status: nlp.pricingStatus });
      }
      if (u.endsWith('/llm/usage')) {
        return Response.json({
          date: '2026-10-10',
          total_usd: nlp.usageTotal,
          call_count: 3,
          daily_cap_usd: nlp.cap,
          remaining_usd: nlp.cap > 0 ? Math.max(0, nlp.cap - nlp.usageTotal) : -1,
        });
      }
      return new Response('not found', { status: 404 });
    }),
  );
}

function seedCandidates(n: number, sourceChars = 40_000): void {
  const db = handle!.db;
  const source = seedSource(db, { raw_markdown: 'x'.repeat(sourceChars) });
  for (let i = 1; i <= n; i++) {
    const id = seedPage(db, { page_id: `page-${i}`, title: `Page ${i}`, page_type: i % 2 ? 'entity' : 'concept' });
    seedProvenance(db, id, source);
  }
}

async function status(estimate = true): Promise<PageUpgradeOverview> {
  const res = await statusGET(new Request(`http://test/api/wiki/page-upgrade${estimate ? '' : '?estimate=0'}`));
  expect(res.status).toBe(200);
  return (await res.json()) as PageUpgradeOverview;
}

function startRequest(body: unknown): Request {
  return new Request('http://test/api/wiki/page-upgrade/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  handle = setupTestDb();
  nlp.pricingStatus = 200;
  nlp.usageTotal = 0;
  nlp.cap = 5;
  nlp.fetches = [];
  mockNlp();
  __resetPageUpgradeStateForTesting();
  __clearPageUpgradeSizeCacheForTesting();
  redraftMock.mockReset();
});

afterEach(async () => {
  // Let a background run settle before its database closes.
  await vi.waitFor(() => expect(getPageUpgradeRunView()?.status ?? 'none').not.toBe('running'));
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

describe('GET /api/wiki/page-upgrade', () => {
  it('says all pages are current when nothing needs updating, without asking the nlp-service', async () => {
    const body = await status();
    expect(body).toMatchObject({ rules: CURRENT_DRAFT_RULES, candidates: 0, set_aside: [], estimate: null, run: null, compile_running: false });
    expect(body.model).toEqual({ id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' });
    expect(nlp.fetches).toEqual([]);
  });

  it('counts the pages and estimates cost and time with the selected model', async () => {
    seedCandidates(6);
    const body = await status();
    expect(body.candidates).toBe(6);
    const expected = estimateUpgrade(gatherEstimateInputs(listUpgradeCandidates()), PRICING, 'deepseek-flash');
    expect(body.estimate).toEqual({
      pages: 6,
      cost_usd_low: expected.cost_usd_low,
      cost_usd_high: expected.cost_usd_high,
      minutes_low: expected.minutes_low,
      minutes_high: expected.minutes_high,
    });
    expect(body.estimate!.cost_usd_high).toBeGreaterThan(body.estimate!.cost_usd_low);
    expect(body.budget).toEqual({ daily_cap_usd: 5, spent_today_usd: 0, remaining_usd: 5 });
    expect(body.over_budget).toBe(false);
    expect(body.max_overspend).toBe(1.5);
    expect(nlp.fetches.some((u) => u.endsWith('/llm/pricing?model=deepseek-flash'))).toBe(true);
  });

  it("warns when the high estimate can pass today's remaining limit", async () => {
    seedCandidates(6);
    nlp.usageTotal = 4.99;
    const body = await status();
    expect(body.budget!.remaining_usd).toBeCloseTo(0.01, 6);
    expect(body.over_budget).toBe(true);
  });

  it('never warns without a daily limit', async () => {
    seedCandidates(6);
    nlp.cap = 0;
    const body = await status();
    expect(body.budget).toEqual({ daily_cap_usd: null, spent_today_usd: 0, remaining_usd: null });
    expect(body.over_budget).toBe(false);
  });

  it('explains a missing estimate instead of guessing', async () => {
    seedCandidates(2);
    nlp.pricingStatus = 502;
    const body = await status();
    expect(body.candidates).toBe(2);
    expect(body.estimate).toBeNull();
    expect(body.estimate_error).toMatch(/NLP service did not respond/);
  });

  it('skips the nlp-service on progress polls', async () => {
    seedCandidates(2);
    const body = await status(false);
    expect(body.candidates).toBe(2);
    expect(body.estimate).toBeNull();
    expect(nlp.fetches).toEqual([]);
  });
});

describe('POST /api/wiki/page-upgrade/start and /stop', () => {
  it('rejects a confirmation without the numbers it confirmed', async () => {
    for (const body of ['not json', {}, { expected_pages: 0, model: 'deepseek-flash' }, { expected_pages: 2.5, model: 'deepseek-flash' }, { expected_pages: 3 }]) {
      const res = await startPOST(startRequest(body));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    }
    expect(redraftMock).not.toHaveBeenCalled();
  });

  it('refuses a stale confirmation with fresh numbers to show', async () => {
    seedCandidates(4);
    const res = await startPOST(startRequest({ expected_pages: 3, model: 'deepseek-flash' }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'candidates_changed', candidates: 4 });
    const model = await startPOST(startRequest({ expected_pages: 4, model: 'gemini-3.8-flash' }));
    expect(model.status).toBe(409);
    expect(((await model.json()) as { error: string }).error).toBe('model_changed');
  });

  it('reports a missing estimate as 503', async () => {
    seedCandidates(1);
    nlp.pricingStatus = 500;
    const res = await startPOST(startRequest({ expected_pages: 1, model: 'deepseek-flash' }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('estimate_unavailable');
  });

  it('starts the run in the background, then Stop ends it before the next page', async () => {
    seedCandidates(3);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    redraftMock.mockImplementation(async (pageId: string) => {
      await gate;
      handle!.db.prepare("UPDATE pages SET draft_rules = 'v0.4' WHERE page_id = ?").run(pageId);
      return {
        page_id: pageId,
        status: 'redrafted',
        model: 'deepseek-flash',
        sources_used: 1,
        sources_skipped: 0,
        previous_chars: 1,
        new_chars: 1,
        flushed: true,
      };
    });

    const res = await startPOST(startRequest({ expected_pages: 3, model: 'deepseek-flash' }));
    expect(res.status).toBe(202);
    const { run } = (await res.json()) as { run: { status: string; total: number; current_title: string | null } };
    expect(run).toMatchObject({ status: 'running', total: 3, current_title: 'Page 1' });
    expect(getSetting('page_upgrade_enabled')).toBe('1');

    const polled = await status(false);
    expect(polled.run).toMatchObject({ status: 'running', done: 0 });

    const stop = await stopPOST();
    expect(stop.status).toBe(200);
    expect(((await stop.json()) as { run: { stop_requested: boolean } }).run.stop_requested).toBe(true);
    expect(getSetting('page_upgrade_enabled')).toBe('0');

    release();
    await vi.waitFor(() => expect(getPageUpgradeRunView()?.status).toBe('stopped'));
    expect(redraftMock).toHaveBeenCalledTimes(1);
    const after = await status();
    expect(after.run).toMatchObject({ status: 'stopped', stop_reason: 'user', updated: 1, stop_message: 'Stopped.' });
    expect(after.candidates).toBe(2);
  });

  it('answers Stop with 409 when nothing runs', async () => {
    const res = await stopPOST();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('not_running');
  });
});

describe('/api/wiki/page-upgrade/notice', () => {
  it('stays hidden on a wiki with nothing to update (fresh installs)', async () => {
    const body = (await (await noticeGET()).json()) as { show: boolean };
    expect(body.show).toBe(false);
  });

  it('shows once there are pages from an earlier version, until closed', async () => {
    seedCandidates(3);
    expect(await (await noticeGET()).json()).toEqual({ show: true, count: 3 });

    expect(await (await noticePOST()).json()).toEqual({ dismissed: true });
    expect(getSetting('page_upgrade_notice_dismissed')).toBe(CURRENT_DRAFT_RULES);
    expect(await (await noticeGET()).json()).toEqual({ show: false, count: 0 });
  });

  it('shows again when a later release changes the rules', async () => {
    seedCandidates(2);
    // Closed for older rules: this release's rules haven't been announced yet.
    setSetting('page_upgrade_notice_dismissed', 'v0.3');
    expect(await (await noticeGET()).json()).toEqual({ show: true, count: 2 });
  });
});
