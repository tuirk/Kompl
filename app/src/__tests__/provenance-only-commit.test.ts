/**
 * Provenance-only plans reach commit (plan 2.2, audit 3 B3).
 *
 * A match triage 'skip' verdict means the source covers the page's subject
 * but adds nothing to it: plan Rule 6 makes a provenance-only plan that
 * links the source to the page without rewriting it. Such a plan used to be
 * stored 'planned'; draft skips it and crossref only reads drafts, so it
 * never reached commit and the source was never linked.
 *
 *   - Plan stores it ready to commit ('crossreffed').
 *   - Commit records one 'mentioned' row per source not yet on the page and
 *     recounts source_count from provenance (distinct sources).
 *   - It commits without approval when auto-approve is off: no text changes.
 *   - A page deleted during the compile drops the plan; the session goes on.
 *   - Plans that earlier versions left 'planned' (some from triage outages,
 *     which recorded no verdict) never commit.
 *   - A re-check's 'skip' verdict links the earlier source the same way.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as planPOST } from '../app/api/compile/plan/route';
import { POST as draftPOST } from '../app/api/compile/draft/route';
import { POST as crossrefPOST } from '../app/api/compile/crossref/route';
import { POST as commitPOST } from '../app/api/compile/commit/route';
import { POST as matchPOST } from '../app/api/compile/match/route';
import { POST as runPOST } from '../app/api/compile/run/route';
import { deletePage, getCompileProgress, setSetting, updatePlanDraft } from '../lib/db';
import { setTriageRecheckEnabled } from '../lib/triage-rechecks';
import {
  setupTestDb,
  seedSource,
  seedExtraction,
  seedPage,
  seedPagePlan,
  seedProvenance,
  seedCompileProgress,
  type TestDbHandle,
} from './helpers/test-db';
import { json, post, seedQueuedProgress } from './helpers/compile-run-harness';
import { seedStoredPair, storedPairs, stubFetch, verdict } from './helpers/triage-stub';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

interface CommitResp {
  committed: number;
  failed: number;
  pending_approval: number;
  flush_failures: number;
}

function provenance(page_id: string): Array<{ source_id: string; contribution_type: string }> {
  return handle!.db
    .prepare('SELECT source_id, contribution_type FROM provenance WHERE page_id = ? ORDER BY id')
    .all(page_id) as Array<{ source_id: string; contribution_type: string }>;
}

function sourceCount(page_id: string): number {
  return (handle!.db.prepare('SELECT source_count FROM pages WHERE page_id = ?').get(page_id) as { source_count: number })
    .source_count;
}

function planStatus(plan_id: string): string | undefined {
  return (handle!.db.prepare('SELECT draft_status FROM page_plans WHERE plan_id = ?').get(plan_id) as
    | { draft_status: string }
    | undefined)?.draft_status;
}

async function commit(session_id: string): Promise<CommitResp> {
  const res = await commitPOST(post({ session_id }));
  expect(res.status).toBe(200);
  return (await res.json()) as CommitResp;
}

/** A wiki page and one session source that triage called a 'skip' for it. */
function seedSkip(session_id: string) {
  const { db } = handle!;
  const page_id = seedPage(db, { page_id: 'bitcoin', title: 'Bitcoin', page_type: 'entity' });
  const source_id = seedSource(db, {
    onboarding_session_id: session_id,
    compile_status: 'extracted',
    raw_markdown: 'x'.repeat(600),
  });
  seedExtraction(db, { source_id, llm_output: { entities: [], concepts: [], relationships: [] } });
  seedCompileProgress(db, session_id);
  const matches = [{ source_id, page_id, page_title: 'Bitcoin', decision: 'skip', reason: 'already covered' }];
  return { page_id, source_id, matches };
}

describe('a skip verdict links the source to the page', () => {
  it('plan stores the provenance-only plan ready to commit', async () => {
    handle = setupTestDb();
    const session_id = 'sess-skip-plan';
    const { page_id, matches } = seedSkip(session_id);

    const res = await planPOST(post({ session_id, canonical_entities: [], matches }));
    expect(res.status).toBe(200);

    const rows = handle.db
      .prepare(`SELECT draft_status FROM page_plans WHERE session_id = ? AND action = 'provenance-only' AND existing_page_id = ?`)
      .all(session_id, page_id) as Array<{ draft_status: string }>;
    expect(rows).toEqual([{ draft_status: 'crossreffed' }]);
  });

  it('plan, draft, crossref and commit record one mentioned row and recount the page', async () => {
    handle = setupTestDb();
    stubFetch({});
    const session_id = 'sess-skip-flow';
    const { page_id, source_id, matches } = seedSkip(session_id);
    expect((await planPOST(post({ session_id, canonical_entities: [], matches }))).status).toBe(200);
    // Rule 1's summary plan would need an LLM draft; only the link is under test.
    handle.db.prepare(`DELETE FROM page_plans WHERE session_id = ? AND action != 'provenance-only'`).run(session_id);
    expect((await draftPOST(post({ session_id }))).status).toBe(200);
    expect((await crossrefPOST(post({ session_id }))).status).toBe(200);
    const body = await commit(session_id);

    expect(body).toMatchObject({ committed: 1, failed: 0, flush_failures: 0 });
    expect(provenance(page_id)).toEqual([{ source_id, contribution_type: 'mentioned' }]);
    expect(sourceCount(page_id)).toBe(1);
    const plans = handle.db
      .prepare(`SELECT draft_status FROM page_plans WHERE session_id = ?`)
      .all(session_id) as Array<{ draft_status: string }>;
    expect(plans).toEqual([{ draft_status: 'committed' }]);
  });

  it('commits without approval when auto-approve is off', async () => {
    handle = setupTestDb();
    setSetting('auto_approve', '0');
    const session_id = 'sess-skip-off';
    const page_id = seedPage(handle.db, { page_id: 'eth', title: 'Ethereum' });
    const source_id = seedSource(handle.db, { onboarding_session_id: session_id, compile_status: 'in_progress' });
    seedCompileProgress(handle.db, session_id);
    seedPagePlan(handle.db, {
      plan_id: 'link-off',
      session_id,
      action: 'provenance-only',
      source_ids: [source_id],
      existing_page_id: page_id,
      draft_status: 'crossreffed',
    });

    expect(await commit(session_id)).toMatchObject({ committed: 1, pending_approval: 0 });
    expect(provenance(page_id)).toEqual([{ source_id, contribution_type: 'mentioned' }]);
  });
});

describe('source_count and duplicate links', () => {
  it('counts distinct sources and never links a source already on the page', async () => {
    handle = setupTestDb();
    const { db } = handle;
    const session_id = 'sess-distinct';
    const page_id = seedPage(db, { page_id: 'eth', title: 'Ethereum' });
    const already = seedSource(db, { compile_status: 'active' });
    seedProvenance(db, page_id, already, 'created');
    const fresh = seedSource(db, { onboarding_session_id: session_id, compile_status: 'in_progress' });
    seedCompileProgress(db, session_id);
    seedPagePlan(db, {
      plan_id: 'link-two',
      session_id,
      action: 'provenance-only',
      source_ids: [already, fresh],
      existing_page_id: page_id,
      draft_status: 'crossreffed',
    });

    expect(await commit(session_id)).toMatchObject({ committed: 1, failed: 0 });
    expect(provenance(page_id)).toEqual([
      { source_id: already, contribution_type: 'created' },
      { source_id: fresh, contribution_type: 'mentioned' },
    ]);
    expect(sourceCount(page_id)).toBe(2);
  });

  it('a second skip verdict for the same pair adds no row', async () => {
    handle = setupTestDb();
    const { db } = handle;
    const session_id = 'sess-twice';
    const page_id = seedPage(db, { page_id: 'eth', title: 'Ethereum' });
    const source_id = seedSource(db, { onboarding_session_id: session_id, compile_status: 'in_progress' });
    seedCompileProgress(db, session_id);
    for (const plan_id of ['link-a', 'link-b']) {
      seedPagePlan(db, {
        plan_id,
        session_id,
        action: 'provenance-only',
        source_ids: [source_id],
        existing_page_id: page_id,
        draft_status: 'crossreffed',
      });
    }

    expect(await commit(session_id)).toMatchObject({ committed: 2, failed: 0 });
    expect(provenance(page_id)).toEqual([{ source_id, contribution_type: 'mentioned' }]);
    expect(sourceCount(page_id)).toBe(1);
    expect([planStatus('link-a'), planStatus('link-b')]).toEqual(['committed', 'committed']);
  });
});

describe('a page deleted during the compile', () => {
  it('drops the link plan without failing the commit', async () => {
    handle = setupTestDb();
    const { db } = handle;
    const session_id = 'sess-page-gone';
    const page_id = seedPage(db, { page_id: 'gone', title: 'Gone' });
    const source_id = seedSource(db, { onboarding_session_id: session_id, compile_status: 'in_progress' });
    seedCompileProgress(db, session_id);
    seedPagePlan(db, {
      plan_id: 'link-gone',
      session_id,
      action: 'provenance-only',
      source_ids: [source_id],
      existing_page_id: page_id,
      draft_status: 'crossreffed',
    });
    deletePage(page_id);

    expect(await commit(session_id)).toMatchObject({ committed: 0, failed: 0 });
    expect(planStatus('link-gone')).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM provenance').get()).toEqual({ n: 0 });
  });
});

describe('plans earlier versions left planned', () => {
  /** An old provenance-only row: stored 'planned', no verdict recorded with it. */
  function seedOldLink(session_id: string, source_status = 'active') {
    const { db } = handle!;
    const page_id = seedPage(db, { page_id: 'eth', title: 'Ethereum' });
    const source_id = seedSource(db, { onboarding_session_id: session_id, compile_status: source_status });
    seedPagePlan(db, {
      plan_id: 'old-link',
      session_id,
      action: 'provenance-only',
      source_ids: [source_id],
      existing_page_id: page_id,
      draft_status: 'planned',
    });
    return { page_id };
  }

  it('commit never takes one', async () => {
    handle = setupTestDb();
    const session_id = 'sess-old-commit';
    seedCompileProgress(handle.db, session_id);
    const { page_id } = seedOldLink(session_id);

    expect(await commit(session_id)).toMatchObject({ committed: 0, failed: 0 });
    expect(planStatus('old-link')).toBe('planned');
    expect(provenance(page_id)).toEqual([]);
  });

  it('a retry of its session completes without linking it', async () => {
    handle = setupTestDb();
    const session_id = 'sess-old-retry';
    seedQueuedProgress(handle.db, session_id);
    const { page_id } = seedOldLink(session_id);
    stubFetch({
      routes: {
        '/api/compile/draft': draftPOST,
        '/api/compile/crossref': crossrefPOST,
        '/api/compile/commit': commitPOST,
      },
      answers: { '/api/compile/schema': () => json({ status: 'already_exists' }) },
    });

    expect((await runPOST(post({ session_id }))).status).toBe(200);
    await vi.waitFor(
      () => {
        const s = getCompileProgress(session_id)?.status;
        if (s !== 'completed' && s !== 'failed') throw new Error(`still ${s}`);
      },
      { timeout: 10_000, interval: 10 },
    );

    expect(getCompileProgress(session_id)?.status).toBe('completed');
    expect(planStatus('old-link')).toBe('planned');
    expect(provenance(page_id)).toEqual([]);
  });
});

describe("a re-check's skip verdict", () => {
  const SESSION = 'sess-recheck-skip';
  const BODY = `---\ntitle: "Page"\nsummary: "A page"\n---\n${'Body text about the subject. '.repeat(40)}`;

  it('links the earlier source to the page and settles the stored pair', async () => {
    handle = setupTestDb();
    setTriageRecheckEnabled(true);
    const { db } = handle;
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
    // Stands in for the draft route, which never drafts a provenance-only plan.
    const draftAll = () => {
      const plans = db
        .prepare(
          `SELECT plan_id FROM page_plans
            WHERE session_id = ? AND draft_status IN ('planned', 'failed') AND action != 'provenance-only'`,
        )
        .all(SESSION) as Array<{ plan_id: string }>;
      for (const p of plans) updatePlanDraft(p.plan_id, BODY, null);
      return json({ drafted: plans.length, failed: 0 });
    };
    stubFetch({
      triage: { Bitcoin: verdict('skip', 'nothing new') },
      routes: {
        '/api/compile/match': matchPOST,
        '/api/compile/plan': planPOST,
        '/api/compile/crossref': crossrefPOST,
        '/api/compile/commit': commitPOST,
      },
      answers: {
        '/api/compile/resolve': () => json({ canonical_entities: [], canonical_concepts: [] }),
        '/api/compile/draft': draftAll,
        '/api/compile/schema': () => json({ status: 'already_exists' }),
      },
    });

    expect((await runPOST(post({ session_id: SESSION }))).status).toBe(200);
    await vi.waitFor(
      () => {
        const s = getCompileProgress(SESSION)?.status;
        if (s !== 'completed' && s !== 'failed') throw new Error(`still ${s}`);
      },
      { timeout: 10_000, interval: 10 },
    );

    expect(getCompileProgress(SESSION)?.status).toBe('completed');
    expect(provenance(page_id)).toEqual([{ source_id: earlier, contribution_type: 'mentioned' }]);
    expect(storedPairs(db)).toEqual([]);
  });
});
