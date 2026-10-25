/**
 * One claim-check run (lib/claim-check/run.ts, judge.ts): candidate pairs
 * go to the judge in batches, every verdict is saved once, and a disputed or
 * outdated verdict becomes a possible disagreement on the subject's page with
 * both sources and their checked quotes. Outdated vs disputed follows the
 * sources' dates (D5). The daily cost ceiling ends the run without failing
 * it, and the owner's verdicts are never touched.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { listPageDisagreements, setOwnerVerdict } from '../lib/disagreements';
import { claimKey, pairKey } from '../lib/claim-check/claims';
import { judgeClaimPairs, type JudgePair } from '../lib/claim-check/judge';
import { CLAIM_JUDGE_BATCH_SIZE } from '../lib/claim-check/limits';
import { pendingClaimPairs, runClaimCheck } from '../lib/claim-check/run';
import { getActivityCounts, seedExtraction, seedPage, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

interface SentPair {
  pair_id: string;
  subject: string;
  a: { claim: string; quote: string | null; source_title: string | null; date: string | null; date_kind: string | null };
  b: { claim: string; quote: string | null; source_title: string | null; date: string | null; date_kind: string | null };
}

type Answer = (pair: SentPair) => { verdict: string; topic?: string; reason?: string; newer?: 'a' | 'b' | null } | null;

/** Stubs nlp-service's judge: `answer` decides each pair; `status` can refuse whole calls. */
function stubJudge(answer: Answer, status: (call: number) => number = () => 200): SentPair[][] {
  const calls: SentPair[][] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (!String(url).endsWith('/pipeline/judge-claims')) throw new Error(`unexpected fetch: ${String(url)}`);
      const body = JSON.parse(String(init?.body)) as { pairs: SentPair[]; compile_model: string };
      calls.push(body.pairs);
      const code = status(calls.length);
      if (code !== 200) return new Response(JSON.stringify({ detail: 'x' }), { status: code });
      const items = body.pairs.flatMap((p) => {
        const a = answer(p);
        return a ? [{ pair_id: p.pair_id, topic: a.topic ?? 'launch year', reason: a.reason ?? 'A and B differ.', verdict: a.verdict, newer: a.newer ?? null }] : [];
      });
      return new Response(JSON.stringify({ items, count: items.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return calls;
}

function source(id: string, published: string | null, claims: Array<{ claim: string; subjects: string[]; quote?: string; verified?: boolean }>): void {
  const { db } = handle!;
  seedSource(db, { source_id: id, title: `Title ${id}`, compile_status: 'active', onboarding_session_id: id.startsWith('new') ? 'sess-new' : 'sess-old' });
  if (published) {
    db.prepare(`UPDATE sources SET published_at = ?, published_at_source = 'page_published' WHERE source_id = ?`).run(published, id);
  }
  seedExtraction(db, {
    source_id: id,
    llm_output: {
      claims: claims.map((c) => ({
        claim: c.claim,
        confidence: 'stated',
        entities_involved: c.subjects,
        quote: c.quote ?? null,
        quote_verified: c.quote ? (c.verified ?? true) : null,
      })),
    },
  });
}

/** Unrelated claims so the subjects under test stay under the 35% share. */
function filler(n: number): void {
  for (let i = 0; i < n; i++) source(`filler-${i}`, null, [{ claim: `Unrelated fact ${i}.`, subjects: [`Thing ${i}`] }]);
}

function seedWiki(): void {
  handle = setupTestDb();
  seedPage(handle.db, { page_id: 'p-btc', title: 'Bitcoin', page_type: 'entity' });
  source('old-a', '2019-04-01', [{ claim: 'Bitcoin launched in 2008.', subjects: ['Bitcoin'], quote: 'It launched in 2008.' }]);
  source('new-b', '2023-02-01', [{ claim: 'Bitcoin launched in 2009.', subjects: ['Bitcoin'], quote: 'Made-up sentence.', verified: false }]);
  filler(6);
}

const KEY = () => pairKey(claimKey('old-a', 'Bitcoin launched in 2008.'), claimKey('new-b', 'Bitcoin launched in 2009.'));

describe('runClaimCheck', () => {
  it('records a disputed pair on the subject page with both sources and only checked quotes', async () => {
    seedWiki();
    const calls = stubJudge(() => ({ verdict: 'disputed', topic: 'launch year', reason: 'A gives 2008; B gives 2009.' }));

    const summary = await runClaimCheck({
      found_by: 'claim_check',
      model: 'deepseek-flash',
      maxPairs: 60,
      session_id: 'sess-new',
      newSourceIds: new Set(['new-b']),
    });

    expect(summary).toMatchObject({ candidates: 1, selected: 1, judged: 1, findings: 1, stopped: null, by_kind: { disputed: 1 } });
    // The earlier-dated claim is side a, each with its date; an unchecked quote is never sent.
    expect(calls[0][0]).toMatchObject({
      pair_id: KEY(),
      subject: 'Bitcoin',
      a: { claim: 'Bitcoin launched in 2008.', quote: 'It launched in 2008.', source_title: 'Title old-a', date: '2019-04-01', date_kind: 'published' },
      b: { claim: 'Bitcoin launched in 2009.', quote: null, source_title: 'Title new-b', date: '2023-02-01', date_kind: 'published' },
    });
    const [finding] = listPageDisagreements('p-btc');
    expect(finding).toMatchObject({
      found_by: 'claim_check',
      kind: 'disputed',
      status: 'possible',
      topic: 'launch year',
      reason: 'A gives 2008; B gives 2009.',
      source_a: 'old-a',
      quote_a: 'It launched in 2008.',
      source_b: 'new-b',
      quote_b: null,
      match_key: 'sources:disputed:new-b|old-a',
      session_id: 'sess-new',
    });
    const saved = handle!.db.prepare('SELECT * FROM claim_verdicts').all();
    expect(saved).toEqual([
      expect.objectContaining({ pair_key: KEY(), source_a: 'old-a', source_b: 'new-b', verdict: 'disputed', found_by: 'claim_check', model: 'deepseek-flash' }),
    ]);
    expect(getActivityCounts(handle!.db).claim_check_run).toBe(1);
  });

  it('judges each pair once: a later run finds nothing left and keeps the owner verdict', async () => {
    seedWiki();
    stubJudge(() => ({ verdict: 'disputed' }));
    await runClaimCheck({ found_by: 'claim_check', model: 'deepseek-flash', maxPairs: 60, newSourceIds: new Set(['new-b']) });
    const [finding] = listPageDisagreements('p-btc');
    setOwnerVerdict(finding.disagreement_id, 'dismissed');

    const calls = stubJudge(() => ({ verdict: 'outdated', newer: 'b' }));
    const again = await runClaimCheck({ found_by: 'wiki_check', model: 'deepseek-flash', maxPairs: 600 });

    expect(calls).toEqual([]);
    expect(again).toMatchObject({ candidates: 0, selected: 0, judged: 0 });
    expect(listPageDisagreements('p-btc')).toEqual([expect.objectContaining({ kind: 'disputed', status: 'dismissed', owner_verdict: 'dismissed' })]);
    expect(pendingClaimPairs(handle!.db)).toEqual([]);
  });

  it('records an outdated pair as changed, the superseded claim first and the newer second', async () => {
    seedWiki();
    stubJudge(() => ({ verdict: 'outdated', newer: 'b', topic: 'launch year' }));
    const summary = await runClaimCheck({ found_by: 'wiki_check', model: 'deepseek-flash', maxPairs: 600 });
    expect(summary.by_kind).toEqual({ changed: 1 });
    expect(listPageDisagreements('p-btc')[0]).toMatchObject({ kind: 'changed', found_by: 'wiki_check', source_a: 'old-a', source_b: 'new-b' });
    expect(handle!.db.prepare('SELECT verdict, newer FROM claim_verdicts').get()).toEqual({ verdict: 'outdated', newer: 'b' });
  });

  it.each(['scope', 'opinion'])('saves a %s verdict without showing it to the owner', async (verdict) => {
    seedWiki();
    stubJudge(() => ({ verdict }));
    const summary = await runClaimCheck({ found_by: 'wiki_check', model: 'deepseek-flash', maxPairs: 600 });
    expect(summary).toMatchObject({ judged: 1, findings: 0, by_kind: {} });
    expect(listPageDisagreements('p-btc')).toEqual([]);
    expect(handle!.db.prepare('SELECT verdict FROM claim_verdicts').all()).toEqual([{ verdict }]);
    expect(pendingClaimPairs(handle!.db)).toEqual([]);
  });

  it('saves none verdicts without recording a finding, and leaves unanswered pairs for later', async () => {
    seedWiki();
    source('new-c', '2024-01-01', [{ claim: 'Bitcoin launched in January 2009.', subjects: ['Bitcoin'] }]);
    stubJudge((p) => (p.b.claim.includes('January') || p.a.claim.includes('January') ? null : { verdict: 'none' }));

    const summary = await runClaimCheck({ found_by: 'wiki_check', model: 'deepseek-flash', maxPairs: 600 });

    expect(summary.findings).toBe(0);
    expect(summary.judged).toBe(1);
    expect(listPageDisagreements('p-btc')).toEqual([]);
    // The two pairs with the January claim got no answer: still pending.
    expect(pendingClaimPairs(handle!.db)).toHaveLength(2);
  });

  it('stops at the daily cost ceiling without failing, keeping what was judged', async () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'p-btc', title: 'Bitcoin', page_type: 'entity' });
    // 8 sources × 1 claim on Bitcoin, 20 filler claims: 28 pairs at most.
    for (let i = 0; i < 8; i++) source(`s${i}`, `2020-01-0${i + 1}`, [{ claim: `Bitcoin had ${i + 1} million users.`, subjects: ['Bitcoin'] }]);
    filler(20);
    const calls = stubJudge(() => ({ verdict: 'none' }), (call) => (call === 1 ? 200 : 503));

    const summary = await runClaimCheck({ found_by: 'wiki_check', model: 'deepseek-flash', maxPairs: 600 });

    expect(summary.stopped).toBe('daily_cost_ceiling');
    expect(summary.judged).toBe(CLAIM_JUDGE_BATCH_SIZE);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(handle.db.prepare('SELECT COUNT(*) AS n FROM claim_verdicts').get()).toEqual({ n: CLAIM_JUDGE_BATCH_SIZE });
    const row = handle.db.prepare(`SELECT details FROM activity_log WHERE action_type = 'claim_check_run'`).get() as { details: string };
    expect(JSON.parse(row.details)).toMatchObject({ found_by: 'wiki_check', stopped: 'daily_cost_ceiling', judged: CLAIM_JUDGE_BATCH_SIZE });
  });

  it('judges at most maxPairs, best ranked first', async () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'p-btc', title: 'Bitcoin', page_type: 'entity' });
    for (let i = 0; i < 6; i++) source(`s${i}`, null, [{ claim: `Bitcoin had ${i + 1} million users.`, subjects: ['Bitcoin'] }]);
    filler(12);
    const calls = stubJudge(() => ({ verdict: 'none' }));
    const ranked = pendingClaimPairs(handle.db).map((p) => p.pair_key);

    const summary = await runClaimCheck({ found_by: 'wiki_check', model: 'deepseek-flash', maxPairs: 4 });

    expect(summary.selected).toBe(4);
    expect(calls.flat().map((p) => p.pair_id)).toEqual(ranked.slice(0, 4));
  });
});

describe('judgeClaimPairs', () => {
  const pair = (i: number): JudgePair => ({ pair_id: `p${i}`, subject: 'X', a: { claim: `a${i}` }, b: { claim: `b${i}` } });

  it('sends batches and stops after three failed calls in a row', async () => {
    const calls = stubJudge(() => ({ verdict: 'none' }), () => 500);
    const outcome = await judgeClaimPairs(Array.from({ length: 30 }, (_, i) => pair(i)), 'deepseek-flash', { concurrency: 1 });
    expect(calls.map((c) => c.length)).toEqual([6, 6, 6]);
    expect(outcome).toMatchObject({ verdicts: [], calls: 0, failed_calls: 3, stopped: 'failures' });
  });

  it('stops before the next batch when asked', async () => {
    const calls = stubJudge(() => ({ verdict: 'scope' }));
    let n = 0;
    const outcome = await judgeClaimPairs(Array.from({ length: 12 }, (_, i) => pair(i)), 'deepseek-flash', {
      concurrency: 1,
      shouldStop: () => (n++ >= 1 ? 'stopped' : null),
    });
    expect(calls).toHaveLength(1);
    expect(outcome.verdicts).toHaveLength(6);
    expect(outcome.stopped).toBe('stopped');
  });
});
