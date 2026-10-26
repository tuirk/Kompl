/**
 * The 'claims' step in the compile pipeline (plan 3.3): after the pages are
 * committed, the session's new sources' claims are judged against the
 * wiki's other claims on shared subjects. Behind a flag, off by default
 * (CLAUDE.md rule 7): off, the step is skipped from the start and the
 * progress page hides it. Once per session, and it never fails the compile.
 *
 * crossref and commit are the real route handlers, reached through a fetch
 * stub; resolve, match, schema and nlp-service are stubbed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as runPOST } from '../app/api/compile/run/route';
import { POST as crossrefPOST } from '../app/api/compile/crossref/route';
import { POST as commitPOST } from '../app/api/compile/commit/route';
import { GET as settingsGET, POST as settingsPOST } from '../app/api/settings/route';
import { isBackedUpSetting } from '../lib/backup-settings';
import { CompileRun } from '../lib/compile/compile-run';
import { runClaimsStep } from '../lib/compile/steps/claims';
import { CLAIM_CHECK_FLAG, getClaimCheckEnabled, setClaimCheckEnabled } from '../lib/claim-check/flag';
import { COMPILE_STEP_KEYS } from '../lib/compile-steps';
import { getCompileProgress } from '../lib/db';
import { listPageDisagreements } from '../lib/disagreements';
import {
  seedCompileProgress,
  seedExtraction,
  seedPage,
  seedPagePlan,
  seedSource,
  setupTestDb,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SESSION = 'sess-claims-step';
const DRAFT = `---\ntitle: "Solana"\ncategory: Crypto\n---\n\n${'Solana is a blockchain. '.repeat(40)}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function post(body: unknown): Request {
  return new Request('http://test/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface PairIn {
  pair_id: string;
}

function stubServices(judge: (pairs: PairIn[]) => Response): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url.toString()).pathname;
      calls.push(path);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      switch (path) {
        case '/api/compile/crossref':
          return crossrefPOST(post(body));
        case '/api/compile/commit':
          return commitPOST(post(body));
        case '/api/compile/resolve':
          return json({ canonical_entities: [], canonical_concepts: [] });
        case '/api/compile/match':
          return json({ skipped: true, matches: [], stats: {} });
        case '/api/compile/schema':
          return json({ status: 'already_exists' });
        case '/pipeline/consolidate-labels':
          return json({ items: [], count: 0 });
        case '/pipeline/judge-claims':
          return judge(body.pairs as PairIn[]);
        case '/storage/write-page':
          return json({ current_path: '/data/pages/x.md.gz', previous_path: null });
        case '/vectors/upsert':
        case '/webhook/session-compile':
          return json({});
      }
      throw new Error(`unexpected fetch in test: ${url.toString()}`);
    }),
  );
  return calls;
}

const disputed = (pairs: PairIn[]) =>
  json({
    items: pairs.map((p) => ({ pair_id: p.pair_id, verdict: 'disputed', topic: 'launch year', reason: 'A gives 2008; B gives 2009.', newer: null })),
    count: pairs.length,
  });

/**
 * An existing source and page about Bitcoin, and a session whose new source
 * claims a different launch year, with one draft ready to commit.
 */
function seedSession(): void {
  const db = handle!.db;
  seedPage(db, { page_id: 'btc', title: 'Bitcoin', category: 'Cryptocurrency' });
  const old = seedSource(db, { source_id: 'old', compile_status: 'active' });
  seedExtraction(db, {
    source_id: old,
    llm_output: {
      claims: [
        { claim: 'Bitcoin launched in 2008.', entities_involved: ['Bitcoin'] },
        // Other subjects keep "Bitcoin" under the 35% share.
        ...['Lisbon', 'Porto', 'Faro', 'Braga'].map((city) => ({ claim: `${city} is in Portugal.`, entities_involved: [city] })),
      ],
    },
  });
  const fresh = seedSource(db, { source_id: 'new', onboarding_session_id: SESSION, compile_status: 'in_progress' });
  seedExtraction(db, { source_id: fresh, llm_output: { claims: [{ claim: 'Bitcoin launched in 2009.', entities_involved: ['Bitcoin'] }] } });
  seedCompileProgress(db, SESSION);
  const steps = Object.fromEntries(
    COMPILE_STEP_KEYS.map((k) => [k, { status: k === 'plan' || k === 'draft' ? 'done' : 'pending' }]),
  );
  db.prepare(`UPDATE compile_progress SET status = 'queued', steps = ? WHERE session_id = ?`).run(JSON.stringify(steps), SESSION);
  seedPagePlan(db, {
    session_id: SESSION,
    title: 'Solana',
    page_type: 'entity',
    action: 'create',
    source_ids: [fresh],
    draft_status: 'crossreffed',
    draft_content: DRAFT,
  });
}

async function runAndWait() {
  expect((await runPOST(post({ session_id: SESSION }))).status).toBe(200);
  await vi.waitFor(
    () => {
      const status = getCompileProgress(SESSION)?.status;
      if (status !== 'completed' && status !== 'failed') throw new Error(`still ${status}`);
    },
    { timeout: 10_000, interval: 10 },
  );
  const p = getCompileProgress(SESSION)!;
  return { status: p.status, steps: JSON.parse(p.steps) as Record<string, { status: string; detail?: string }> };
}

describe('compile pipeline: claims step', () => {
  it('is skipped and hidden while the flag is off, with no judge call', async () => {
    handle = setupTestDb();
    seedSession();
    setClaimCheckEnabled(false);
    const calls = stubServices(disputed);

    const result = await runAndWait();

    expect(result.status).toBe('completed');
    expect(result.steps.claims).toEqual({ status: 'done', detail: 'skipped (claim check off)' });
    expect(calls).not.toContain('/pipeline/judge-claims');
    expect(listPageDisagreements('btc')).toEqual([]);
  });

  it('with the flag on, checks the new claims after schema and records the finding', async () => {
    handle = setupTestDb();
    seedSession();
    setClaimCheckEnabled(true);
    const calls = stubServices(disputed);

    const result = await runAndWait();

    expect(result.status).toBe('completed');
    expect(result.steps.claims).toEqual({ status: 'done', detail: '1 claim pair checked · 1 possible disagreement' });
    expect(calls.indexOf('/pipeline/judge-claims')).toBeGreaterThan(calls.indexOf('/api/compile/schema'));
    expect(listPageDisagreements('btc')).toEqual([
      expect.objectContaining({ found_by: 'claim_check', kind: 'disputed', source_a: 'old', source_b: 'new', session_id: SESSION }),
    ]);
  });

  it('at the daily cost cap the compile still completes', async () => {
    handle = setupTestDb();
    seedSession();
    setClaimCheckEnabled(true);
    stubServices(() => json({ detail: 'daily_cost_ceiling' }, 503));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runAndWait();

    expect(result.status).toBe('completed');
    expect(result.steps.claims).toEqual({
      status: 'done',
      detail: "claims not checked: today's spending limit reached",
    });
  });
});

describe('runClaimsStep', () => {
  it('runs once per session', async () => {
    handle = setupTestDb();
    seedSession();
    handle.db.prepare(`UPDATE sources SET compile_status = 'active' WHERE source_id = 'new'`).run();
    setClaimCheckEnabled(true);
    const calls = stubServices(disputed);
    const run = CompileRun.start(SESSION);

    await runClaimsStep(run);
    await runClaimsStep(run);

    expect(calls.filter((c) => c === '/pipeline/judge-claims')).toHaveLength(1);
    run.end();
  });

  it('says so when the session brought no claims to check', async () => {
    handle = setupTestDb();
    seedSession();
    setClaimCheckEnabled(true);
    // The new source's claim shares no subject with another source's claim.
    handle.db.prepare(`UPDATE extractions SET llm_output = ? WHERE source_id = 'new'`).run(
      JSON.stringify({ claims: [{ claim: 'Solana is fast.', entities_involved: ['Solana'] }] }),
    );
    handle.db.prepare(`UPDATE sources SET compile_status = 'active' WHERE source_id = 'new'`).run();
    const calls = stubServices(disputed);
    const run = CompileRun.start(SESSION);

    await runClaimsStep(run);

    expect(calls).toEqual([]);
    expect(JSON.parse(getCompileProgress(SESSION)!.steps).claims).toEqual({ status: 'done', detail: 'no claim pairs to check' });
    run.end();
  });
});

describe('the claim check switch', () => {
  const settingsPost = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    settingsPOST(
      new Request('http://test/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      }),
    );

  it('is on by default (it passed the accuracy bar) and set through the settings API', async () => {
    handle = setupTestDb();
    expect(getClaimCheckEnabled()).toBe(true);
    expect(((await (await settingsGET()).json()) as Record<string, unknown>).claim_check_enabled).toBe(true);

    expect((await settingsPost({ claim_check_enabled: 'yes' })).status).toBe(422);
    expect((await settingsPost({ claim_check_enabled: false })).status).toBe(200);
    expect(getClaimCheckEnabled()).toBe(false);
    expect(((await (await settingsGET()).json()) as Record<string, unknown>).claim_check_enabled).toBe(false);
  });

  it('is not switched from another site, nor restored from a backup', async () => {
    handle = setupTestDb();
    const res = await settingsPost({ claim_check_enabled: false }, { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(getClaimCheckEnabled()).toBe(true);
    expect(CLAIM_CHECK_FLAG).toBe('claim_check_enabled');
    expect(isBackedUpSetting(CLAIM_CHECK_FLAG)).toBe(false);
  });
});
