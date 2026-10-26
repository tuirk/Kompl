/**
 * compile/draft when its run outlives the step (audit H3).
 *
 * The orchestrator gives up on the draft step at its timeout and fails the
 * session; a Retry then starts a second draft run over the same plans. The
 * first run used to keep starting drafts (paying twice), and a draft it
 * finished after the Retry had linked the plan moved the plan back to
 * 'drafted', where commit never reads it: the page was lost while the
 * session ended 'completed'.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as draftPOST } from '../app/api/compile/draft/route';
import { updatePlanDraft, updatePlanDraftFailed } from '../lib/db';
import {
  setupTestDb,
  seedSource,
  seedPagePlan,
  seedCompileProgress,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

const STUB_MD = '---\ntitle: "Page"\ncategory: "Crypto"\nsummary: "s"\n---\n\nbody';

function draftRequest(session_id: string, signal?: AbortSignal): Request {
  return new Request('http://test/api/compile/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id }),
    signal,
  });
}

/** Stubs nlp-service: each draft-page call runs `during` first, then answers. */
function stubDraftPage(during: (n: number) => void, status = 200): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/pipeline/draft-page')) {
        during(++calls);
        return status === 200
          ? new Response(JSON.stringify({ markdown: STUB_MD }), { status: 200, headers: { 'Content-Type': 'application/json' } })
          : new Response('upstream failed', { status });
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return { calls: () => calls };
}

function statusOf(plan_id: string): { draft_status: string; draft_content: string | null } {
  return handle!.db.prepare('SELECT draft_status, draft_content FROM page_plans WHERE plan_id = ?').get(plan_id) as {
    draft_status: string;
    draft_content: string | null;
  };
}

function seedSummary(session_id: string, n: number): string {
  const source_id = seedSource(handle!.db, {
    source_id: `src-${n}`,
    title: `Source ${n}`,
    onboarding_session_id: session_id,
    raw_markdown: `Text of source ${n}.`,
  });
  return seedPagePlan(handle!.db, {
    session_id,
    title: `Source ${n}`,
    page_type: 'source-summary',
    action: 'create',
    source_ids: [source_id],
    draft_status: 'planned',
  });
}

describe('updatePlanDraft and updatePlanDraftFailed', () => {
  it('write only a plan still waiting for its draft', () => {
    handle = setupTestDb();
    const waiting = seedPagePlan(handle.db, { session_id: 's', draft_status: 'failed' });
    const linked = seedPagePlan(handle.db, { session_id: 's', draft_status: 'crossreffed', draft_content: 'linked' });

    expect(updatePlanDraft(waiting, 'new', null)).toBe(true);
    expect(statusOf(waiting).draft_status).toBe('drafted');

    expect(updatePlanDraft(linked, 'stale', null)).toBe(false);
    expect(updatePlanDraftFailed(linked, 'stale failure')).toBe(false);
    expect(statusOf(linked)).toEqual({ draft_status: 'crossreffed', draft_content: 'linked' });
  });
});

describe('compile/draft — a run that outlived its step', () => {
  it('leaves a plan another run linked meanwhile as that run left it', async () => {
    handle = setupTestDb();
    seedCompileProgress(handle.db, 'sess-taken');
    const plan_id = seedSummary('sess-taken', 1);
    // While this draft waits on the model, the Retry's run drafts and links the plan.
    stubDraftPage(() => {
      handle!.db
        .prepare(`UPDATE page_plans SET draft_status = 'crossreffed', draft_content = 'the retry draft' WHERE plan_id = ?`)
        .run(plan_id);
    });

    const res = await draftPOST(draftRequest('sess-taken'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { drafted: number }).drafted).toBe(0);
    expect(statusOf(plan_id)).toEqual({ draft_status: 'crossreffed', draft_content: 'the retry draft' });
  });

  it('never marks a plan another run linked meanwhile as failed', async () => {
    handle = setupTestDb();
    seedCompileProgress(handle.db, 'sess-taken-fail');
    const plan_id = seedSummary('sess-taken-fail', 1);
    stubDraftPage(() => {
      handle!.db.prepare(`UPDATE page_plans SET draft_status = 'committed' WHERE plan_id = ?`).run(plan_id);
    }, 500);

    const res = await draftPOST(draftRequest('sess-taken-fail'));
    expect(((await res.json()) as { failed: number }).failed).toBe(0);
    expect(statusOf(plan_id).draft_status).toBe('committed');
  });

  it('starts no more drafts once the orchestrator stops waiting', async () => {
    handle = setupTestDb();
    seedCompileProgress(handle.db, 'sess-gone', 3);
    // Three summaries in a wiki with no labels yet: the first drafts alone,
    // and the orchestrator's timeout fires while it runs.
    const first = seedSummary('sess-gone', 1);
    const second = seedSummary('sess-gone', 2);
    const third = seedSummary('sess-gone', 3);
    const caller = new AbortController();
    const nlp = stubDraftPage(() => caller.abort());

    const res = await draftPOST(draftRequest('sess-gone', caller.signal));
    expect(res.status).toBe(200);

    expect(nlp.calls()).toBe(1);
    // The draft already paid for is kept; the others wait for the Retry.
    expect(statusOf(first).draft_status).toBe('drafted');
    expect(statusOf(second).draft_status).toBe('planned');
    expect(statusOf(third).draft_status).toBe('planned');
  });

  it('starts no later layer once the orchestrator stops waiting', async () => {
    handle = setupTestDb();
    seedCompileProgress(handle.db, 'sess-gone-layer');
    seedSummary('sess-gone-layer', 1);
    const entity = seedPagePlan(handle.db, {
      session_id: 'sess-gone-layer',
      title: 'Bitcoin',
      page_type: 'entity',
      action: 'create',
      source_ids: ['src-1'],
      draft_status: 'planned',
    });
    const caller = new AbortController();
    const nlp = stubDraftPage(() => caller.abort());

    await draftPOST(draftRequest('sess-gone-layer', caller.signal));

    expect(nlp.calls()).toBe(1);
    expect(statusOf(entity).draft_status).toBe('planned');
  });
});
