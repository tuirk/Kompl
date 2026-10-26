/**
 * runCompilePipeline and the re-check of stored triage failures.
 *
 *   - Match is told whether plan will use its answers (will_plan): only a
 *     run that plans may re-check stored pairs or consume them. A retry
 *     whose plans are kept makes no re-check.
 *   - A re-check verdict is planned, drafted and committed like a triage
 *     verdict for a session source: an 'update' writes the page with the
 *     earlier source and links it.
 *   - The verdict stays on the pair until the session completes, so a run
 *     that fails and plans again on retry still has it without a new call.
 *   - The match step's detail counts re-checks.
 *
 * match, plan, crossref and commit are the real routes in the first test;
 * resolve, draft, schema and nlp-service are stubbed.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as runPOST } from '../app/api/compile/run/route';
import { POST as retryPOST } from '../app/api/compile/retry/route';
import { POST as matchPOST } from '../app/api/compile/match/route';
import { POST as planPOST } from '../app/api/compile/plan/route';
import { POST as crossrefPOST } from '../app/api/compile/crossref/route';
import { POST as commitPOST } from '../app/api/compile/commit/route';
import { getCompileProgress, updatePlanDraft } from '../lib/db';
import { setTriageRecheckEnabled } from '../lib/triage-rechecks';
import {
  setupTestDb,
  seedSource,
  seedExtraction,
  seedPage,
  seedPagePlan,
  type TestDbHandle,
} from './helpers/test-db';
import { COMMIT_OK, json, post, readSteps, seedQueuedProgress } from './helpers/compile-run-harness';
import { seedStoredPair, storedPairs, stubFetch, verdict } from './helpers/triage-stub';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

const SESSION = 'sess-recheck-run';
const BODY = `---\ntitle: "Page"\nsummary: "A page"\n---\n${'Body text about the subject. '.repeat(40)}`;

async function runAndWait(session_id = SESSION) {
  expect((await runPOST(post({ session_id }))).status).toBe(200);
  await vi.waitFor(
    () => {
      const s = getCompileProgress(session_id)?.status;
      if (s !== 'completed' && s !== 'failed') throw new Error(`still ${s}`);
    },
    { timeout: 10_000, interval: 10 },
  );
  const p = getCompileProgress(session_id)!;
  return { status: p.status, error: p.error, steps: readSteps(p.steps) };
}

/** A wiki page, an earlier compiled source stored against it, and this session's own source. */
function seedWorld() {
  const db = handle!.db;
  const page_id = seedPage(db, { title: 'Bitcoin', page_type: 'entity', summary: 'About Bitcoin' });
  const earlier = seedSource(db, {
    title: 'Earlier article',
    onboarding_session_id: 'sess-earlier',
    compile_status: 'active',
    raw_markdown: `gamma ${'z'.repeat(600)}`,
  });
  seedStoredPair(db, { source_id: earlier, page_id, session_id: 'sess-earlier' });
  const own = seedSource(db, {
    title: 'New article',
    onboarding_session_id: SESSION,
    compile_status: 'in_progress',
    raw_markdown: `delta ${'d'.repeat(600)}`,
  });
  seedExtraction(db, { source_id: own });
  seedQueuedProgress(db, SESSION);
  return { page_id, earlier, own };
}

/** Stands in for the draft route: drafts every plan still to write. */
function draftAll(): Response {
  const plans = handle!.db
    .prepare(
      `SELECT plan_id FROM page_plans
        WHERE session_id = ? AND draft_status IN ('planned', 'failed') AND action != 'provenance-only'`,
    )
    .all(SESSION) as Array<{ plan_id: string }>;
  for (const p of plans) updatePlanDraft(p.plan_id, BODY, null);
  return json({ drafted: plans.length, failed: 0 });
}

const RESOLVE = () => json({ canonical_entities: [], canonical_concepts: [] });
const SCHEMA = () => json({ status: 'already_exists' });

describe('a re-check verdict reaches the wiki', () => {
  it('plans, drafts and commits an update from the earlier source, then removes the pair', async () => {
    handle = setupTestDb();
    setTriageRecheckEnabled(true);
    const { page_id, earlier } = seedWorld();
    const stub = stubFetch({
      triage: { Bitcoin: verdict('update', 'new figures') },
      routes: {
        '/api/compile/match': matchPOST,
        '/api/compile/plan': planPOST,
        '/api/compile/crossref': crossrefPOST,
        '/api/compile/commit': commitPOST,
      },
      answers: { '/api/compile/resolve': RESOLVE, '/api/compile/draft': draftAll, '/api/compile/schema': SCHEMA },
    });

    const run = await runAndWait();

    expect(run.status).toBe('completed');
    expect(stub.routeBodies['/api/compile/match'][0]).toMatchObject({ will_plan: true });
    expect(stub.triaged).toEqual(['Bitcoin']);
    expect(run.steps.match.detail).toContain('1 rechecked, 1 answered, 0 dropped');
    const link = handle.db
      .prepare(`SELECT contribution_type FROM provenance WHERE source_id = ? AND page_id = ?`)
      .get(earlier, page_id) as { contribution_type: string } | undefined;
    expect(link?.contribution_type).toBe('updated');
    expect(storedPairs(handle.db)).toEqual([]);
    const rows = handle.db.prepare(`SELECT COUNT(*) AS n FROM activity_log WHERE action_type = 'match_triage_rechecked'`).get() as { n: number };
    expect(rows.n).toBe(1);
  });
});

describe('the verdict is kept until the session completes', () => {
  it('a failed run keeps it, and its retry plans it again without a new call', async () => {
    handle = setupTestDb();
    setTriageRecheckEnabled(true);
    const { page_id, earlier } = seedWorld();
    const answers = {
      '/api/compile/resolve': RESOLVE,
      '/api/compile/plan': () => json({ stats: { total: 1 } }),
      '/api/compile/draft': () => json({ drafted: 1, failed: 0 }),
      '/api/compile/crossref': () => json({ wikilinks_added: 0 }),
      '/api/compile/commit': () => json({ ...COMMIT_OK, failed: 1 }),
      '/api/compile/schema': SCHEMA,
    };
    const first = stubFetch({ triage: { Bitcoin: verdict('update') }, routes: { '/api/compile/match': matchPOST }, answers });

    expect((await runAndWait()).status).toBe('failed');
    expect(first.triaged).toEqual(['Bitcoin']);
    expect(storedPairs(handle.db)).toEqual([expect.objectContaining({ verdict: 'update', verdict_session_id: SESSION })]);

    const second = stubFetch({
      triage: {},
      routes: { '/api/compile/match': matchPOST },
      answers: { ...answers, '/api/compile/commit': () => json(COMMIT_OK) },
    });
    expect((await retryPOST(post({ session_id: SESSION }))).status).toBe(200);
    const retried = await runAndWait();

    expect(retried.status).toBe('completed');
    expect(second.triaged).toEqual([]);
    expect(second.routeBodies['/api/compile/plan'][0].matches).toEqual([
      expect.objectContaining({ source_id: earlier, page_id, decision: 'update' }),
    ]);
    expect(storedPairs(handle.db)).toEqual([]);
  });
});

describe('a run that keeps its plans', () => {
  it('tells match plan will not run, and re-checks nothing', async () => {
    handle = setupTestDb();
    setTriageRecheckEnabled(true);
    const { own } = seedWorld();
    seedPagePlan(handle.db, { session_id: SESSION, title: 'New article', page_type: 'source-summary', source_ids: [own], draft_status: 'planned' });
    const stub = stubFetch({
      triage: { Bitcoin: verdict('update') },
      routes: { '/api/compile/match': matchPOST },
      answers: {
        '/api/compile/resolve': RESOLVE,
        '/api/compile/draft': () => json({ drafted: 1, failed: 0 }),
        '/api/compile/crossref': () => json({ wikilinks_added: 0 }),
        '/api/compile/commit': () => json(COMMIT_OK),
        '/api/compile/schema': SCHEMA,
      },
    });

    expect((await runAndWait()).status).toBe('completed');
    expect(stub.routeBodies['/api/compile/match'][0]).toMatchObject({ will_plan: false });
    expect(stub.calls).not.toContain('/api/compile/plan');
    expect(stub.triaged).toEqual([]);
    expect(storedPairs(handle.db)).toEqual([expect.objectContaining({ verdict: null, attempts: 1 })]);
  });
});

describe('match step detail', () => {
  it('counts re-checks when there were any', async () => {
    handle = setupTestDb();
    seedWorld();
    stubFetch({
      answers: {
        '/api/compile/resolve': RESOLVE,
        '/api/compile/match': () =>
          json({
            skipped: false,
            matches: [],
            stats: {
              candidates_found: 0, sources_checked: 1, updates: 0, contradictions: 0, skips: 0, triage_failed: 0,
              rechecked: 3, recheck_answered: 1, recheck_failed: 1, recheck_dropped: 2,
            },
          }),
        '/api/compile/plan': () => json({ stats: { total: 0 } }),
        '/api/compile/draft': () => json({ drafted: 0, failed: 0 }),
        '/api/compile/crossref': () => json({ wikilinks_added: 0 }),
        '/api/compile/commit': () => json(COMMIT_OK),
        '/api/compile/schema': SCHEMA,
      },
    });

    const run = await runAndWait();

    expect(run.steps.match.detail).toBe('0 candidates from 1 sources → 0u/0c/0s · 3 rechecked, 1 answered, 2 dropped');
  });
});
