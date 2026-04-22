/**
 * Flag 3A — dossier capping by TF-IDF relevance.
 *
 * The draft POST handler calls the nlp-service /extract/tfidf-rank endpoint
 * to score per-source dossier blocks against a query (plan.title + existing
 * page markdown on updates), filters by dossier_min_score, caps at
 * dossier_max_sources, with deterministic (score DESC, source_id ASC)
 * tie-breaking. Graceful degradation falls back to recency. Comparison
 * pages skip scoring entirely.
 *
 * These tests drive the draft POST handler end-to-end (DB + handler) with
 * fetch stubbed so no real nlp-service call is made. Each case seeds a
 * known extraction/plan shape and asserts the body of the /pipeline/draft-page
 * fetch to prove which sources survived the cap.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as draftPOST } from '../app/api/compile/draft/route';
import {
  setupTestDb,
  seedSource,
  seedExtraction,
  seedPagePlan,
  seedCompileProgress,
  type TestDbHandle,
} from './helpers/test-db';
import { setDossierMaxSources, setDossierMinScore, setSetting } from '../lib/db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

interface DraftPageBody {
  page_type: string;
  title: string;
  extraction_dossier: string;
}

interface TfidfRankBody {
  query: string;
  candidates: Array<{ id: string; text: string }>;
}

/**
 * Stub fetch for both /pipeline/draft-page and /extract/tfidf-rank.
 * tfidf-rank scores are provided up-front; draft-page returns stub markdown
 * and records the body for assertion.
 */
function mockFetch(opts: {
  tfidfScores?: Array<{ id: string; score: number }>;
  tfidfThrow?: boolean;
}) {
  let draftBody: DraftPageBody | null = null;
  let tfidfBody: TfidfRankBody | null = null;
  let tfidfCalls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : String(url);
      if (u.endsWith('/pipeline/draft-page')) {
        draftBody = JSON.parse((init?.body as string) ?? '{}') as DraftPageBody;
        return new Response(
          JSON.stringify({ markdown: '---\ntitle: "stub"\n---\n\nstub' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (u.endsWith('/extract/tfidf-rank')) {
        tfidfCalls++;
        tfidfBody = JSON.parse((init?.body as string) ?? '{}') as TfidfRankBody;
        if (opts.tfidfThrow) {
          return new Response('upstream error', { status: 500 });
        }
        return new Response(
          JSON.stringify({ scores: opts.tfidfScores ?? [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return {
    getDraftBody: () => draftBody,
    getTfidfBody: () => tfidfBody,
    getTfidfCalls: () => tfidfCalls,
  };
}

function draftReq(session_id: string): Request {
  return new Request('http://test/api/compile/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id }),
  });
}

function seedEntitySource(
  db: TestDbHandle['db'],
  args: { source_id: string; session_id: string; entityName: string; context: string; claim?: string; createdAt?: string },
): string {
  const sid = seedSource(db, {
    source_id: args.source_id,
    onboarding_session_id: args.session_id,
    raw_markdown: `Markdown about ${args.entityName}. ${args.context}`,
  });
  seedExtraction(db, {
    source_id: sid,
    llm_output: {
      entities: [{ name: args.entityName, type: 'PRODUCT', mentions: 5, context: args.context }],
      concepts: [],
      claims: args.claim ? [{ claim: args.claim }] : [],
      contradictions: [],
      relationships: [],
    },
  });
  if (args.createdAt) {
    db.prepare('UPDATE extractions SET created_at = ? WHERE source_id = ?').run(args.createdAt, sid);
  }
  return sid;
}

describe('compile/draft — dossier relevance cap', () => {
  it('getExtractionsBySourceIds returns only the requested rows', async () => {
    // Small smoke test via the draft handler: seed 3 sources in session, 2 in an
    // unrelated session. Draft a plan that references a subset. The dossier the
    // drafter sees should only have blocks for the plan's source_ids, not bleed
    // from unrelated sources.
    handle = setupTestDb();
    const sid = 'sess-subset';
    seedCompileProgress(handle.db, sid);
    seedEntitySource(handle.db, { source_id: 's1', session_id: sid, entityName: 'GPT-4', context: 'A' });
    seedEntitySource(handle.db, { source_id: 's2', session_id: sid, entityName: 'GPT-4', context: 'B' });
    // Sources present in DB but NOT referenced by any plan
    seedEntitySource(handle.db, { source_id: 's-orphan', session_id: 'other', entityName: 'GPT-4', context: 'C' });

    seedPagePlan(handle.db, {
      session_id: sid,
      title: 'GPT-4',
      page_type: 'entity',
      action: 'create',
      source_ids: ['s1', 's2'],
      draft_status: 'planned',
    });

    setDossierMinScore(0);
    const mock = mockFetch({
      tfidfScores: [
        { id: 's1', score: 0.5 },
        { id: 's2', score: 0.4 },
      ],
    });

    const res = await draftPOST(draftReq(sid));
    expect(res.status).toBe(200);
    const body = mock.getDraftBody();
    expect(body?.extraction_dossier ?? '').toContain('From source s1:');
    expect(body?.extraction_dossier ?? '').toContain('From source s2:');
    expect(body?.extraction_dossier ?? '').not.toContain('From source s-orphan:');
  });

  it('cap enforced: >max_sources candidates → top-N by score kept', async () => {
    handle = setupTestDb();
    const sid = 'sess-cap';
    seedCompileProgress(handle.db, sid);
    for (const i of ['1', '2', '3', '4', '5']) {
      seedEntitySource(handle.db, { source_id: `s${i}`, session_id: sid, entityName: 'GPT-4', context: `context ${i}` });
    }
    seedPagePlan(handle.db, {
      session_id: sid,
      title: 'GPT-4',
      page_type: 'entity',
      action: 'create',
      source_ids: ['s1', 's2', 's3', 's4', 's5'],
      draft_status: 'planned',
    });

    setDossierMaxSources(3);
    setDossierMinScore(0);

    const mock = mockFetch({
      tfidfScores: [
        { id: 's1', score: 0.9 },
        { id: 's2', score: 0.8 },
        { id: 's3', score: 0.7 },
        { id: 's4', score: 0.1 },
        { id: 's5', score: 0.05 },
      ],
    });

    await draftPOST(draftReq(sid));
    const dossier = mock.getDraftBody()?.extraction_dossier ?? '';
    // Top 3 by score kept
    expect(dossier).toContain('From source s1:');
    expect(dossier).toContain('From source s2:');
    expect(dossier).toContain('From source s3:');
    // Lower scored dropped
    expect(dossier).not.toContain('From source s4:');
    expect(dossier).not.toContain('From source s5:');
  });

  it('min_score enforced: below-threshold dropped regardless of cap', async () => {
    handle = setupTestDb();
    const sid = 'sess-minscore';
    seedCompileProgress(handle.db, sid);
    for (const i of ['1', '2', '3']) {
      seedEntitySource(handle.db, { source_id: `m${i}`, session_id: sid, entityName: 'GPT-4', context: `ctx ${i}` });
    }
    seedPagePlan(handle.db, {
      session_id: sid,
      title: 'GPT-4',
      page_type: 'entity',
      action: 'create',
      source_ids: ['m1', 'm2', 'm3'],
      draft_status: 'planned',
    });

    setDossierMaxSources(10); // well above candidate count
    setDossierMinScore(0.05);

    const mock = mockFetch({
      tfidfScores: [
        { id: 'm1', score: 0.9 },
        { id: 'm2', score: 0.04 }, // below min_score
        { id: 'm3', score: 0.8 },
      ],
    });

    await draftPOST(draftReq(sid));
    const dossier = mock.getDraftBody()?.extraction_dossier ?? '';
    expect(dossier).toContain('From source m1:');
    expect(dossier).not.toContain('From source m2:');
    expect(dossier).toContain('From source m3:');
  });

  it('deterministic tiebreaker: equal scores ordered by source_id ASC', async () => {
    handle = setupTestDb();
    const sid = 'sess-tie';
    seedCompileProgress(handle.db, sid);
    // NOTE: contexts are distinct so the rendered dossier can be parsed deterministically.
    seedEntitySource(handle.db, { source_id: 'src-zzz', session_id: sid, entityName: 'GPT-4', context: 'zzz' });
    seedEntitySource(handle.db, { source_id: 'src-aaa', session_id: sid, entityName: 'GPT-4', context: 'aaa' });
    seedEntitySource(handle.db, { source_id: 'src-mmm', session_id: sid, entityName: 'GPT-4', context: 'mmm' });

    seedPagePlan(handle.db, {
      session_id: sid,
      title: 'GPT-4',
      page_type: 'entity',
      action: 'create',
      source_ids: ['src-zzz', 'src-aaa', 'src-mmm'],
      draft_status: 'planned',
    });

    setDossierMaxSources(2); // drops one — tiebreaker must pick src-aaa first
    setDossierMinScore(0);

    const mock = mockFetch({
      tfidfScores: [
        { id: 'src-zzz', score: 0.5 },
        { id: 'src-aaa', score: 0.5 },
        { id: 'src-mmm', score: 0.5 },
      ],
    });

    const res = await draftPOST(draftReq(sid));
    expect(res.status).toBe(200);

    const dossier = mock.getDraftBody()?.extraction_dossier ?? '';
    // Deterministic tiebreaker picks src-aaa + src-mmm (alphabetical) for the
    // top-2 cap; src-zzz must be dropped.
    expect(dossier).toContain('From source src-aaa:');
    expect(dossier).toContain('From source src-mmm:');
    expect(dossier).not.toContain('From source src-zzz:');
  });

  it('graceful degradation: tfidf_rank fails → recency fallback caps without min_score', async () => {
    handle = setupTestDb();
    const sid = 'sess-fallback';
    seedCompileProgress(handle.db, sid);
    // Three sources with explicit created_at so the recency order is deterministic.
    seedEntitySource(handle.db, { source_id: 'r-old', session_id: sid, entityName: 'GPT-4', context: 'oldest', createdAt: '2025-01-01 00:00:00' });
    seedEntitySource(handle.db, { source_id: 'r-mid', session_id: sid, entityName: 'GPT-4', context: 'middle', createdAt: '2025-06-01 00:00:00' });
    seedEntitySource(handle.db, { source_id: 'r-new', session_id: sid, entityName: 'GPT-4', context: 'newest', createdAt: '2026-01-01 00:00:00' });

    seedPagePlan(handle.db, {
      session_id: sid,
      title: 'GPT-4',
      page_type: 'entity',
      action: 'create',
      source_ids: ['r-old', 'r-mid', 'r-new'],
      draft_status: 'planned',
    });

    setDossierMaxSources(2);
    setDossierMinScore(0.99); // would drop everything under TF-IDF — but fallback skips this

    const mock = mockFetch({ tfidfThrow: true });

    await draftPOST(draftReq(sid));
    const dossier = mock.getDraftBody()?.extraction_dossier ?? '';
    // Recency fallback keeps the two newest regardless of score threshold.
    expect(dossier).toContain('From source r-new:');
    expect(dossier).toContain('From source r-mid:');
    expect(dossier).not.toContain('From source r-old:');
  });

  it('comparison-page skip: no tfidf-rank call made', async () => {
    handle = setupTestDb();
    const sid = 'sess-comparison';
    seedCompileProgress(handle.db, sid);

    // Seed sources with a relationship that a comparison plan targets.
    const s1 = seedSource(handle.db, {
      source_id: 'cmp1',
      onboarding_session_id: sid,
      raw_markdown: 'GPT-4 competes with Claude across benchmarks.',
    });
    seedExtraction(handle.db, {
      source_id: s1,
      llm_output: {
        entities: [{ name: 'GPT-4', type: 'PRODUCT' }, { name: 'Claude', type: 'PRODUCT' }],
        concepts: [],
        claims: [],
        contradictions: [],
        relationships: [
          { from_entity: 'GPT-4', to: 'Claude', type: 'competes_with', description: 'rivals' },
        ],
      },
    });
    // Related entity plans so planTitleById resolves both subjects.
    seedPagePlan(handle.db, {
      session_id: sid,
      plan_id: 'plan-gpt',
      title: 'GPT-4',
      page_type: 'entity',
      action: 'create',
      source_ids: [s1],
      draft_status: 'planned',
    });
    seedPagePlan(handle.db, {
      session_id: sid,
      plan_id: 'plan-claude',
      title: 'Claude',
      page_type: 'entity',
      action: 'create',
      source_ids: [s1],
      draft_status: 'planned',
    });
    seedPagePlan(handle.db, {
      session_id: sid,
      title: 'Claude vs GPT-4',
      page_type: 'comparison',
      action: 'create',
      source_ids: [s1],
      related_plan_ids: ['plan-gpt', 'plan-claude'],
      draft_status: 'planned',
    });
    // Threshold so entity plans aren't pre-filtered
    setSetting('entity_promotion_threshold', '1');

    // tfidfThrow would blow up if called — we rely on it NOT being called for the comparison plan.
    const mock = mockFetch({ tfidfThrow: false, tfidfScores: [{ id: s1, score: 0.5 }] });

    await draftPOST(draftReq(sid));
    // Entity plans may invoke tfidf-rank, but for comparison plans the call
    // must be skipped. We can't directly observe "per-plan skipped" from a
    // single counter, but the stronger guarantee is: the comparison dossier
    // output survives regardless of tfidfScores (skip = no ranking applied).
    const calls = mock.getTfidfCalls();
    // Entity plans above DO score, but comparison plan adds 0 extra calls.
    // Exactly 2 calls (one per entity plan), not 3.
    expect(calls).toBe(2);
  });
});
