/**
 * The pipeline in redo mode (POST /api/compile/run with a running redo
 * record, lib/compile-redo/): what each point runs, the archive after a
 * re-plan, and the outcome record.
 *
 * Regression targets: FR-3 (never extract), FR-6/7 (archive only pages this
 * compile created, never an older page it updated), FR-8 (a page changed
 * meanwhile is not overwritten), FR-12 (activity row), FR-14 (a re-save
 * writes no draft), FR-13 (a finished redo leaves later runs normal).
 *
 * crossref and commit are the real route handlers; resolve, match, plan,
 * draft, schema, n8n and nlp-service are stubbed.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import { POST as runPOST } from '../app/api/compile/run/route';
import { POST as crossrefPOST } from '../app/api/compile/crossref/route';
import { POST as commitPOST } from '../app/api/compile/commit/route';
import { activeRedo, readRedo, saveRedo } from '../lib/compile-redo/state';
import { startRedo } from '../lib/compile-redo/start';
import { getCompileModel, getCompileProgress, getDb, setSetting, updatePlanDraft } from '../lib/db';
import { pageTextVersionToken } from '../lib/page-rewrite';
import { BODY, PRICING, SESSION, USAGE, seedFinishedCompile, touchPage, type RedoFixture } from './helpers/redo-fixture';
import { setupTestDb, getActivityCounts, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Stubs {
  /** Stands in for the plan route: writes the new plan. */
  plan?: () => void;
  /** Runs after the stub draft wrote its drafts (something else acting meanwhile). */
  afterDraft?: () => void;
}

/** Drafts every planned or failed plan, recording the page version like the draft route. */
function stubDraft(): { drafted: number; failed: number } {
  const rows = getDb()
    .prepare(`SELECT plan_id, existing_page_id FROM page_plans WHERE session_id = ? AND draft_status IN ('planned', 'failed')`)
    .all(SESSION) as Array<{ plan_id: string; existing_page_id: string | null }>;
  for (const r of rows) {
    updatePlanDraft(r.plan_id, BODY, null, r.existing_page_id ? pageTextVersionToken(r.existing_page_id) : null);
  }
  return { drafted: rows.length, failed: 0 };
}

function stubServices(stubs: Stubs = {}): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url.toString()).pathname;
      calls.push(path);
      const forward = (handler: (r: Request) => Promise<Response>) =>
        handler(new Request(url.toString(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: String(init?.body ?? '{}') }));
      switch (path) {
        case '/api/compile/crossref':
          return forward(crossrefPOST);
        case '/api/compile/commit':
          return forward(commitPOST);
        case '/api/compile/resolve':
          return json({ canonical_entities: [], canonical_concepts: [] });
        case '/api/compile/match':
          return json({ skipped: true, matches: [], stats: {} });
        case '/api/compile/plan':
          stubs.plan?.();
          return json({ stats: { total: 0 } });
        case '/api/compile/draft': {
          const r = stubDraft();
          stubs.afterDraft?.();
          return json(r);
        }
        case '/api/compile/schema':
          return json({ status: 'already_exists' });
        case '/llm/pricing':
          return json(PRICING);
        case '/llm/usage':
          return json(USAGE);
        case '/webhook/session-compile':
          return json({ ok: true });
        case '/storage/write-page':
          return json({ current_path: '/data/pages/x.md.gz', previous_path: null });
        case '/vectors/upsert':
          return json({});
        default:
          throw new Error(`unexpected fetch in test: ${url.toString()}`);
      }
    }),
  );
  return calls;
}

async function redoAndRun(point: 'plan' | 'write' | 'save'): Promise<void> {
  await startRedo({ sessionId: SESSION, point, expectedPages: 999, model: getCompileModel() });
  const res = await runPOST(new Request('http://test/api/compile/run', { method: 'POST', body: JSON.stringify({ session_id: SESSION }) }));
  expect(res.status).toBe(200);
  await vi.waitFor(
    () => {
      const s = getCompileProgress(SESSION)!.status;
      if (s === 'running' || s === 'queued') throw new Error('still running');
    },
    { timeout: 5_000, interval: 10 },
  );
}

const PIPELINE_AI = ['/api/compile/extract', '/api/compile/resolve', '/api/compile/match', '/api/compile/plan', '/api/compile/draft'];
const pageType = (id: string) => (getDb().prepare('SELECT page_type FROM pages WHERE page_id = ?').get(id) as { page_type: string }).page_type;

describe('redo pipeline', () => {
  it('re-save commits the held draft with no AI writing', async () => {
    handle = setupTestDb();
    const f = seedFinishedCompile(handle.db);
    setSetting('min_draft_chars', '0');
    const calls = stubServices();
    await redoAndRun('save');
    expect(getCompileProgress(SESSION)!.status).toBe('completed');
    for (const p of PIPELINE_AI) expect(calls).not.toContain(p);
    const gamma = handle.db.prepare('SELECT draft_status FROM page_plans WHERE plan_id = ?').get(f.plans.gamma) as { draft_status: string };
    expect(gamma.draft_status).toBe('committed');
    expect(readRedo()).toMatchObject({ status: 'finished', outcome: { saved: 1, archived: [] } });
    expect(getActivityCounts(handle.db).compile_redo).toBe(1);
  });

  it('re-write drafts again in place without extracting or planning', async () => {
    handle = setupTestDb();
    const f = seedFinishedCompile(handle.db);
    const pagesBefore = (handle.db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n;
    const calls = stubServices();
    await redoAndRun('write');
    expect(getCompileProgress(SESSION)!.status).toBe('completed');
    expect(calls).toContain('/api/compile/draft');
    for (const p of ['/api/compile/extract', '/api/compile/resolve', '/api/compile/match', '/api/compile/plan']) expect(calls).not.toContain(p);
    // Only the draft that was too short before becomes a new page; the rest are rewritten in place.
    expect((handle.db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n).toBe(pagesBefore + 1);
    expect((handle.db.prepare(`SELECT COUNT(*) AS n FROM pages WHERE title = 'Alpha'`).get() as { n: number }).n).toBe(1);
    expect(pageType(f.alpha)).toBe('entity');
    const redo = readRedo()!;
    expect(redo.outcome!.saved).toBeGreaterThanOrEqual(4);
    expect(activeRedo(SESSION)).toBeNull();
  });

  it('a page changed after its draft is skipped at save, not overwritten', async () => {
    handle = setupTestDb();
    const f = seedFinishedCompile(handle.db);
    stubServices({ afterDraft: () => touchPage(getDb(), f.alpha) });
    await redoAndRun('write');
    const alpha = handle.db.prepare('SELECT draft_status FROM page_plans WHERE plan_id = ?').get(f.plans.alpha) as { draft_status: string };
    expect(alpha.draft_status).toBe('page_changed');
    expect(getActivityCounts(handle.db).compile_page_skipped).toBe(1);
    expect(readRedo()!.outcome!.skipped_on_save).toBe(1);
  });

  it('re-plan archives only the created pages the new plan drops', async () => {
    handle = setupTestDb();
    const f: RedoFixture = seedFinishedCompile(handle.db);
    const calls = stubServices({
      plan: () => {
        const add = getDb().prepare(
          `INSERT INTO page_plans (plan_id, session_id, title, page_type, action, source_ids, existing_page_id, draft_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'planned')`,
        );
        // What plan/route.ts would plan: the compile's own pages found as existing.
        add.run(randomUUID(), SESSION, 'Source A', 'source-summary', 'update', JSON.stringify([f.sources[0]]), f.summary);
        add.run(randomUUID(), SESSION, 'Alpha', 'entity', 'update', JSON.stringify(f.sources), f.alpha);
        // Beta (created) and Old Topic (older page) are no longer planned.
      },
    });
    await redoAndRun('plan');
    expect(getCompileProgress(SESSION)!.status).toBe('completed');
    expect(calls).not.toContain('/api/compile/extract');
    expect(calls).toContain('/api/compile/plan');
    expect(pageType(f.beta)).toBe('archived');
    expect(pageType(f.oldPage)).toBe('entity');
    expect(pageType(f.alpha)).toBe('entity');
    // Own pages are written from scratch in place, not updated over their own text.
    const alphaPlan = handle.db.prepare(`SELECT action FROM page_plans WHERE title = 'Alpha'`).get() as { action: string };
    expect(alphaPlan.action).toBe('create');
    const redo = readRedo()!;
    expect(redo.outcome!.archived.map((p) => p.page_id)).toEqual([f.beta]);
    const held = handle.db.prepare('SELECT restore_page_type, archive_reason FROM pages WHERE page_id = ?').get(f.beta) as {
      restore_page_type: string;
      archive_reason: string;
    };
    expect(held.restore_page_type).toBe('concept');
    expect(held.archive_reason).toMatch(/planned again/);
  });

  it('re-plan stops before writing when the new plan is larger than confirmed', async () => {
    handle = setupTestDb();
    const f = seedFinishedCompile(handle.db);
    const calls = stubServices({
      plan: () => {
        const add = getDb().prepare(
          `INSERT INTO page_plans (plan_id, session_id, title, page_type, action, source_ids, draft_status)
           VALUES (?, ?, ?, 'entity', 'create', ?, 'planned')`,
        );
        for (let i = 0; i < 40; i++) add.run(randomUUID(), SESSION, `Topic ${i}`, JSON.stringify(f.sources));
      },
    });
    await redoAndRun('plan');
    expect(getCompileProgress(SESSION)!.status).toBe('failed');
    expect(calls).not.toContain('/api/compile/draft');
    expect(pageType(f.beta)).toBe('concept');
  });
});

describe('activeRedo', () => {
  it('only a running redo of this session puts the pipeline in redo mode', () => {
    handle = setupTestDb();
    const base = {
      session_id: SESSION, point: 'write' as const, status: 'finished' as const, model: 'm', model_label: 'm',
      confirmed: { pages: 1, max_pages: 1, calls_low: 0, calls_high: 0, cost_usd_low: 0, cost_usd_high: 0, minutes_low: 0, minutes_high: 0 },
      own_pages: [], skipped: [], usage_at_start: null, outcome: null, started_at: '', finished_at: null,
    };
    saveRedo(base);
    expect(activeRedo(SESSION)).toBeNull();
    saveRedo({ ...base, status: 'running', session_id: 'other' });
    expect(activeRedo(SESSION)).toBeNull();
    saveRedo({ ...base, status: 'running' });
    expect(activeRedo(SESSION)).not.toBeNull();
  });
});
