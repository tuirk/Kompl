/**
 * The whole-wiki check (plan 3.6, lib/claim-check/wiki-check.ts): on demand
 * from Settings > Wiki health, the cost and number of pairs shown first, one
 * confirmed run at a time judging at most MAX_WIKI_CHECK_PAIRS_PER_RUN pairs
 * with the claim check's engine (found_by 'wiki_check'), each run going on
 * where the last one stopped. Rule 7: the hard cap and a flag armed only by
 * the confirmation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as overviewGET } from '../app/api/wiki/claim-check/route';
import { POST as startPOST } from '../app/api/wiki/claim-check/start/route';
import { POST as stopPOST } from '../app/api/wiki/claim-check/stop/route';
import { GET as statusGET } from '../app/api/wiki/status/route';
import { isBackedUpSetting } from '../lib/backup-settings';
import { estimateWikiCheck, type JudgePricing } from '../lib/claim-check/estimate';
import { WIKI_CHECK_FLAG } from '../lib/claim-check/flag';
import { CLAIM_JUDGE_BATCH_SIZE } from '../lib/claim-check/limits';
import {
  __resetWikiCheckStateForTesting,
  getWikiCheckOverview,
  requestWikiCheckStop,
  startWikiCheck,
  WikiCheckError,
} from '../lib/claim-check/wiki-check';
import { getSetting, setCompileModel } from '../lib/db';
import { listPageDisagreements } from '../lib/disagreements';
import { seedCompileProgress, seedExtraction, seedPage, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  __resetWikiCheckStateForTesting();
  handle?.cleanup();
  handle = null;
});

const PRICING: JudgePricing = {
  input_usd_per_m: 0.3,
  output_usd_per_m: 1.2,
  claim_judge_thinking_budget: 512,
  claim_judge_max_output_tokens: 8192,
  draft_thinking_budget_is_cap: false,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Stub {
  judged: string[];
  /** Holds every judge call open until release() (to test Stop). */
  release?: () => void;
}

function stubNlp(opts: { remaining?: number; judge?: 'none' | 'disputed'; hold?: boolean } = {}): Stub {
  const stub: Stub = { judged: [] };
  let gate: Promise<void> = Promise.resolve();
  if (opts.hold) gate = new Promise<void>((resolve) => (stub.release = resolve));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url.toString()).pathname;
      if (path === '/llm/pricing') return json({ ...PRICING, model: 'deepseek-flash' });
      if (path === '/llm/usage') {
        const remaining = opts.remaining ?? -1;
        return json({ date: '2026-10-24', total_usd: 0, daily_cap_usd: remaining >= 0 ? 5 : 0, remaining_usd: remaining, call_count: 0 });
      }
      if (path === '/pipeline/judge-claims') {
        await gate;
        const pairs = (JSON.parse(String(init?.body)) as { pairs: Array<{ pair_id: string }> }).pairs;
        stub.judged.push(...pairs.map((p) => p.pair_id));
        const verdict = opts.judge ?? 'none';
        const items = pairs.map((p) => ({ pair_id: p.pair_id, verdict, topic: 'users', reason: 'A and B differ.', newer: null }));
        return json({ items, count: items.length });
      }
      throw new Error(`unexpected fetch: ${url.toString()}`);
    }),
  );
  return stub;
}

/** A Bitcoin page and `n` sources each claiming a different user count, plus filler under the 35% share. */
function seedWiki(n = 4): void {
  handle = setupTestDb();
  setCompileModel('deepseek-flash');
  seedPage(handle.db, { page_id: 'p-btc', title: 'Bitcoin', page_type: 'entity' });
  for (let i = 0; i < n; i++) {
    seedSource(handle.db, { source_id: `s${i}`, title: `Source ${i}`, compile_status: 'active' });
    seedExtraction(handle.db, {
      source_id: `s${i}`,
      llm_output: { claims: [{ claim: `Bitcoin has ${i + 1} million users.`, entities_involved: ['Bitcoin'] }] },
    });
  }
  for (let i = 0; i < 2 * n; i++) {
    seedSource(handle.db, { source_id: `f${i}`, compile_status: 'active' });
    seedExtraction(handle.db, { source_id: `f${i}`, llm_output: { claims: [{ claim: `Fact ${i}.`, entities_involved: [`Thing ${i}`] }] } });
  }
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://test/api/wiki/claim-check/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('estimateWikiCheck', () => {
  it('counts one call per batch and widens the range for effort-level thinking', () => {
    const pairs = Array.from({ length: 600 }, () => 300);
    const effort = estimateWikiCheck(pairs, PRICING);
    expect(effort.pairs).toBe(600);
    expect(effort.calls).toBe(Math.ceil(600 / CLAIM_JUDGE_BATCH_SIZE));
    expect(effort.minutes_high).toBeGreaterThan(effort.minutes_low);
    expect(effort.cost_usd_low).toBeGreaterThan(0);
    expect(effort.cost_usd_high).toBeGreaterThan(effort.cost_usd_low);
    const capped = estimateWikiCheck(pairs, { ...PRICING, draft_thinking_budget_is_cap: true });
    expect(capped.cost_usd_high).toBeLessThan(effort.cost_usd_high);
    expect(estimateWikiCheck([], PRICING)).toEqual({ pairs: 0, calls: 0, cost_usd_low: 0, cost_usd_high: 0, minutes_low: 0, minutes_high: 0 });
  });
});

describe('the whole-wiki check', () => {
  it('shows the pairs left, the next run and its cost before anything runs', async () => {
    seedWiki();
    const stub = stubNlp({ remaining: 0.0001 });

    const res = await overviewGET(new Request('http://test/api/wiki/claim-check'));
    const body = (await res.json()) as Awaited<ReturnType<typeof getWikiCheckOverview>>;

    expect(body.pairs_left).toBeGreaterThan(0);
    expect(body.next_run_pairs).toBe(body.pairs_left);
    expect(body.model).toEqual({ id: 'deepseek-flash', label: 'DeepSeek V4.1 Flash' });
    expect(body.estimate).toMatchObject({ pairs: body.next_run_pairs });
    expect(body.over_budget).toBe(true);
    expect(body.run).toBeNull();
    expect(stub.judged).toEqual([]);
    expect(getSetting(WIKI_CHECK_FLAG)).toBeNull();
  });

  it('runs on confirmation, records wiki_check findings, disarms, and leaves nothing to check', async () => {
    seedWiki();
    const stub = stubNlp({ judge: 'disputed' });
    const before = await getWikiCheckOverview({ withEstimate: true });

    const { run, finished } = await startWikiCheck({ expectedPairs: before.next_run_pairs!, model: 'deepseek-flash' });
    expect(run).toMatchObject({ status: 'running', total: before.next_run_pairs, model: 'deepseek-flash' });
    expect(getSetting(WIKI_CHECK_FLAG)).toBe('1');
    await finished;

    const after = await getWikiCheckOverview({ withEstimate: true });
    expect(after.run).toMatchObject({ status: 'finished', judged: before.next_run_pairs, findings: before.next_run_pairs, stop_reason: null });
    expect(after.pairs_left).toBe(0);
    expect(after.checked_pairs).toBe(before.next_run_pairs);
    expect(after.last_checked_at).not.toBeNull();
    expect(getSetting(WIKI_CHECK_FLAG)).toBe('0');
    expect(stub.judged).toHaveLength(before.next_run_pairs!);
    expect(listPageDisagreements('p-btc').every((d) => d.found_by === 'wiki_check' && d.status === 'possible')).toBe(true);
    await expect(startWikiCheck({ expectedPairs: 1, model: 'deepseek-flash' })).rejects.toMatchObject({ code: 'no_pairs' });
  });

  it('refuses when the numbers shown no longer hold, or while a compile runs', async () => {
    seedWiki();
    stubNlp();
    const { next_run_pairs } = await getWikiCheckOverview({ withEstimate: true });

    await expect(startWikiCheck({ expectedPairs: next_run_pairs!, model: 'gemini-2.5-flash' })).rejects.toMatchObject({
      code: 'model_changed',
      status: 409,
    });
    await expect(startWikiCheck({ expectedPairs: next_run_pairs! - 1, model: 'deepseek-flash' })).rejects.toBeInstanceOf(WikiCheckError);
    seedCompileProgress(handle!.db, 'sess-running');
    handle!.db.prepare(`UPDATE compile_progress SET status = 'running', started_at = datetime('now')`).run();
    await expect(startWikiCheck({ expectedPairs: next_run_pairs!, model: 'deepseek-flash' })).rejects.toMatchObject({
      code: 'session_in_progress',
    });
    expect(getSetting(WIKI_CHECK_FLAG)).toBeNull();
  });

  it('stops before the next batch and the next run goes on from there', async () => {
    // 16 sources: more batches than the calls in flight at once.
    seedWiki(16);
    const stub = stubNlp({ hold: true });
    const { next_run_pairs } = await getWikiCheckOverview({ withEstimate: true });
    const { finished } = await startWikiCheck({ expectedPairs: next_run_pairs!, model: 'deepseek-flash' });

    await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(0));
    const stopped = await stopPOST();
    expect(stopped.status).toBe(200);
    expect(getSetting(WIKI_CHECK_FLAG)).toBe('0');
    stub.release!();
    await finished;

    const after = await getWikiCheckOverview({ withEstimate: true });
    expect(after.run).toMatchObject({ status: 'stopped', stop_reason: 'user' });
    expect(after.run!.judged).toBeLessThan(next_run_pairs!);
    expect(after.pairs_left).toBe(next_run_pairs! - after.run!.judged);
    expect((await stopPOST()).status).toBe(409);
    expect(requestWikiCheckStop()).toBeNull();
  });

  it('start refuses cross-site requests and bad bodies', async () => {
    seedWiki();
    stubNlp();
    expect((await startPOST(post({ expected_pairs: 3, model: 'deepseek-flash' }, { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' }))).status).toBe(403);
    expect((await startPOST(post({ expected_pairs: 0, model: 'deepseek-flash' }))).status).toBe(400);
    expect((await startPOST(post({ expected_pairs: 3 }))).status).toBe(400);
    expect(getSetting(WIKI_CHECK_FLAG)).toBeNull();
  });

  it('the flag is never restored from a backup', () => {
    expect(WIKI_CHECK_FLAG).toBe('wiki_check_enabled');
    expect(isBackedUpSetting(WIKI_CHECK_FLAG)).toBe(false);
  });

  it("MCP wiki_status's last health check lists the open findings", async () => {
    seedWiki(2);
    stubNlp({ judge: 'disputed' });
    const { next_run_pairs } = await getWikiCheckOverview({ withEstimate: true });
    await (await startWikiCheck({ expectedPairs: next_run_pairs!, model: 'deepseek-flash' })).finished;

    const body = (await (await statusGET()).json()) as {
      last_health_check: { at: string; contradictions: { count: number; top: Array<{ page_a: string; page_b: string; claim: string }> } };
    };
    expect(body.last_health_check.contradictions).toEqual({
      count: 1,
      top: [{ page_a: 'Source 0', page_b: 'Source 1', claim: 'Bitcoin: users. A and B differ.' }],
    });
  });
});
