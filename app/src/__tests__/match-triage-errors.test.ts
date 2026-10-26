/**
 * POST /api/compile/match — a triage call that gives no verdict.
 *
 * Triage errors (rate limit 429, daily cost ceiling 503, any other failure)
 * used to come back as decision 'skip', which plan Rule 6 turns into a
 * provenance-only plan: the source was recorded as mentioned on the page
 * without anything having checked it. They are now their own outcome,
 * 'triage_failed', with the cause as the reason: no plan, no provenance
 * link, counted in the step stats and reported in the activity log. A real
 * 'skip' verdict is unchanged.
 */

import type { ReactElement } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as matchPOST } from '../app/api/compile/match/route';
import { POST as planPOST } from '../app/api/compile/plan/route';
import { getEventDef, resolveBadge, type FeedActivityRow } from '../lib/activity-events';
import {
  setupTestDb,
  seedSource,
  seedExtraction,
  seedPage,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

interface MatchEntry {
  source_id: string;
  page_id: string;
  page_title: string;
  decision: string;
  reason: string;
}

interface MatchResponse {
  skipped: boolean;
  matches: MatchEntry[];
  stats: Record<string, number>;
}

function post(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Stubs nlp-service. TF-IDF matches each source to the pages named in
 * `candidates` (keyed by a word in the source text); triage answers per
 * page title from `triage`.
 */
function stubNlp(
  candidates: Record<string, string[]>,
  triage: Record<string, () => Response>,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = url.toString();
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      if (u.endsWith('/extract/tfidf-overlap')) {
        const key = Object.keys(candidates).find((k) => body.source_text.includes(k));
        const pages = key ? candidates[key] : [];
        return Response.json({
          overlap_score: 0.5,
          top_matches: pages.map((page_id) => ({ page_id, similarity: 0.5 })),
        });
      }
      if (u.endsWith('/pipeline/triage')) {
        const answer = triage[body.page_title];
        if (!answer) throw new Error(`no triage answer for ${body.page_title}`);
        return answer();
      }
      throw new Error(`unexpected fetch in test: ${u}`);
    }),
  );
}

const verdict = (decision: string, reason: string) => () => Response.json({ decision, reason });
const status = (code: number, detail: string) => () => Response.json({ detail }, { status: code });

/** Two session sources against five existing pages. */
function seedWiki(session_id: string) {
  const { db } = handle!;
  for (const [page_id, title] of [
    ['p-ceiling', 'Ceiling'],
    ['p-rate', 'Rate'],
    ['p-error', 'Error'],
    ['p-timeout', 'Timeout'],
    ['p-skip', 'Skip'],
  ]) {
    seedPage(db, { page_id, title, page_type: 'entity', summary: `About ${title}` });
  }
  const one = seedSource(db, {
    onboarding_session_id: session_id,
    compile_status: 'extracted',
    raw_markdown: `alpha ${'x'.repeat(600)}`,
  });
  const two = seedSource(db, {
    onboarding_session_id: session_id,
    compile_status: 'extracted',
    raw_markdown: `beta ${'y'.repeat(600)}`,
  });
  for (const source_id of [one, two]) {
    seedExtraction(db, { source_id, llm_output: { entities: [], concepts: [], relationships: [] } });
  }
  stubNlp(
    { alpha: ['p-ceiling', 'p-rate', 'p-error'], beta: ['p-timeout', 'p-skip'] },
    {
      Ceiling: status(503, 'daily_cost_ceiling'),
      Rate: status(429, 'llm_rate_limited'),
      Error: status(500, 'triage_llm_call_failed: boom'),
      Timeout: () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
      Skip: verdict('skip', 'nothing new for this page'),
    },
  );
  return { one, two };
}

async function runMatch(session_id: string): Promise<MatchResponse> {
  const res = await matchPOST(post('/api/compile/match', { session_id, canonical_entities: [] }));
  expect(res.status).toBe(200);
  return (await res.json()) as MatchResponse;
}

describe('match: triage errors are not skip verdicts', () => {
  it('each failed triage carries its cause; a real skip stays a skip', async () => {
    handle = setupTestDb();
    const session_id = 'sess-triage-errors';
    const { one, two } = seedWiki(session_id);

    const data = await runMatch(session_id);

    const byPage = Object.fromEntries(data.matches.map((m) => [m.page_id, m]));
    expect(byPage['p-ceiling']).toMatchObject({ source_id: one, decision: 'triage_failed', reason: 'daily_cost_ceiling' });
    expect(byPage['p-rate']).toMatchObject({ source_id: one, decision: 'triage_failed', reason: 'llm_rate_limited' });
    expect(byPage['p-error']).toMatchObject({ source_id: one, decision: 'triage_failed', reason: 'triage_error' });
    expect(byPage['p-timeout']).toMatchObject({ source_id: two, decision: 'triage_failed', reason: 'triage_error' });
    expect(byPage['p-skip']).toMatchObject({ source_id: two, decision: 'skip', reason: 'nothing new for this page' });
    expect(data.stats).toEqual({
      sources_checked: 2,
      candidates_found: 5,
      updates: 0,
      contradictions: 0,
      skips: 1,
      triage_failed: 4,
      rechecked: 0,
      recheck_answered: 0,
      recheck_failed: 0,
      recheck_dropped: 0,
    });
  });

  it('logs one activity row with the failures by cause', async () => {
    handle = setupTestDb();
    const session_id = 'sess-triage-activity';
    seedWiki(session_id);

    await runMatch(session_id);

    const rows = handle.db
      .prepare(`SELECT session_id, step_key, details FROM activity_log WHERE action_type = 'match_triage_failed'`)
      .all() as Array<{ session_id: string; step_key: string; details: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id, step_key: 'match' });
    const details = JSON.parse(rows[0].details) as Record<string, unknown>;
    expect(details).toMatchObject({
      session_id,
      failed: 4,
      cost_ceiling: 1,
      rate_limited: 1,
      errors: 2,
    });
    expect(details.examples).toEqual(expect.arrayContaining([expect.objectContaining({ page_title: 'Ceiling' })]));
  });

  it('logs nothing when every triage call answers', async () => {
    handle = setupTestDb();
    const session_id = 'sess-triage-ok';
    seedPage(handle.db, { page_id: 'p-skip', title: 'Skip', page_type: 'entity' });
    seedSource(handle.db, { onboarding_session_id: session_id, compile_status: 'extracted', raw_markdown: `beta ${'y'.repeat(600)}` });
    stubNlp({ beta: ['p-skip'] }, { Skip: verdict('skip', 'nothing new') });

    const data = await runMatch(session_id);

    expect(data.stats.triage_failed).toBe(0);
    const n = handle.db.prepare(`SELECT COUNT(*) AS n FROM activity_log WHERE action_type = 'match_triage_failed'`).get() as { n: number };
    expect(n.n).toBe(0);
  });

  it('plan makes no plan and no provenance link for a failed triage', async () => {
    handle = setupTestDb();
    const session_id = 'sess-triage-plan';
    seedWiki(session_id);
    const { matches } = await runMatch(session_id);

    const res = await planPOST(post('/api/compile/plan', { session_id, canonical_entities: [], matches }));
    expect(res.status).toBe(200);
    const plans = handle.db
      .prepare(`SELECT existing_page_id, action FROM page_plans WHERE session_id = ? AND existing_page_id IS NOT NULL`)
      .all(session_id) as Array<{ existing_page_id: string; action: string }>;
    // Only the real 'skip' verdict records the source on its page.
    expect(plans).toEqual([{ existing_page_id: 'p-skip', action: 'provenance-only' }]);
  });
});

describe('a decision triage does not know', () => {
  it('is a failed triage (triage_error), stored for a re-check, never a skip', async () => {
    handle = setupTestDb();
    const { db } = handle;
    const session_id = 'sess-triage-unknown';
    seedPage(db, { page_id: 'p-500', title: 'Refused', page_type: 'entity', summary: 'About it' });
    seedPage(db, { page_id: 'p-200', title: 'Odd', page_type: 'entity', summary: 'About it' });
    const source_id = seedSource(db, {
      onboarding_session_id: session_id,
      compile_status: 'extracted',
      raw_markdown: `alpha ${'x'.repeat(600)}`,
    });
    stubNlp(
      { alpha: ['p-500', 'p-200'] },
      {
        // nlp-service refuses an answer outside the three decisions...
        Refused: status(500, "triage_unknown_decision: 'maybe'"),
        // ...and the app refuses one that still carries it.
        Odd: verdict('no_update', 'unclear'),
      },
    );

    const { matches, stats } = await runMatch(session_id);

    expect(matches).toEqual([
      { source_id, page_id: 'p-500', page_title: 'Refused', decision: 'triage_failed', reason: 'triage_error' },
      { source_id, page_id: 'p-200', page_title: 'Odd', decision: 'triage_failed', reason: 'triage_error' },
    ]);
    expect(stats).toMatchObject({ skips: 0, triage_failed: 2 });
    expect(
      db.prepare('SELECT page_id, reason FROM triage_rechecks WHERE source_id = ? ORDER BY page_id').all(source_id),
    ).toEqual([
      { page_id: 'p-200', reason: 'triage_error' },
      { page_id: 'p-500', reason: 'triage_error' },
    ]);

    await planPOST(post('/api/compile/plan', { session_id, canonical_entities: [], matches }));
    const links = db
      .prepare(`SELECT COUNT(*) AS n FROM page_plans WHERE session_id = ? AND existing_page_id IS NOT NULL`)
      .get(session_id) as { n: number };
    expect(links.n).toBe(0);
  });
});

describe('activity feed', () => {
  const text = (node: unknown): string => {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(text).join('');
    return text((node as ReactElement<{ children?: unknown }>).props.children);
  };

  it('renders the failed checks with their causes', () => {
    const def = getEventDef('match_triage_failed');
    expect(def).not.toBeNull();
    const row: FeedActivityRow = {
      id: 1, timestamp: '2026-10-24 10:00:00', action_type: 'match_triage_failed', source_id: null, source_title: null,
      details: JSON.stringify({
        session_id: 's', failed: 3, cost_ceiling: 2, rate_limited: 0, errors: 1,
        examples: [{ source_title: 'An article', page_title: 'Bitcoin' }],
      }),
    };
    expect(resolveBadge(def!, row)).toEqual({ label: 'UNCHECKED', tone: 'dim' });
    const content = def!.render(row);
    expect(text(content.primary)).toBe('3 checks against existing pages not done');
    expect(text(content.secondary)).toBe('2 hit the daily cost limit · 1 failed · An article → Bitcoin');
  });
});
