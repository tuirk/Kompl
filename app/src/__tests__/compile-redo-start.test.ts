/**
 * Redo of the last compile (GitHub #140, lib/compile-redo/): the preview,
 * the refusals and the reset each point makes before n8n runs it again.
 *
 * Regression targets: FR-2 (latest compile only, never while one runs),
 * FR-4 (preview with cost on the Settings model; no AI cost for a re-save),
 * FR-5 (refuse when the plan grew or the model changed), FR-6/7 (only pages
 * this compile created may be archived), FR-8 (pages changed since are
 * skipped), FR-10 (locks both ways).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

import { compilePages } from '../lib/compile-redo/baseline';
import { previewRedo, startRedo, RedoError } from '../lib/compile-redo/start';
import { readRedo } from '../lib/compile-redo/state';
import { getCompileModel, getRunningCompileSession, setSetting } from '../lib/db';
import { __resetWikiRepairStateForTesting, repairState } from '../lib/wiki-repair/state';
import { startWikiRepair } from '../lib/wiki-repair/run';
import { PRICING, SESSION, USAGE, seedFinishedCompile, seedProgress, touchPage } from './helpers/redo-fixture';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
  __resetWikiRepairStateForTesting();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubNlp(): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const path = new URL(url.toString()).pathname;
      calls.push(path);
      if (path === '/llm/pricing') return json(PRICING);
      if (path === '/llm/usage') return json(USAGE);
      if (path === '/webhook/session-compile') return json({ ok: true });
      throw new Error(`unexpected fetch in test: ${url.toString()}`);
    }),
  );
  return calls;
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof RedoError) return err.code;
    throw err;
  }
  return 'none';
}

const start = (point: 'plan' | 'write' | 'save', expected = 999) =>
  startRedo({ sessionId: SESSION, point, expectedPages: expected, model: getCompileModel() });

describe('compilePages', () => {
  it('tells created pages from updated ones, and spots pages changed since', () => {
    handle = setupTestDb();
    const f = seedFinishedCompile(handle.db);
    touchPage(handle.db, f.beta);
    const pages = new Map(compilePages(handle.db, SESSION).map((p) => [p.page_id, p]));
    expect(pages.get(f.oldPage)).toMatchObject({ action: 'update', changed: false });
    expect(pages.get(f.alpha)).toMatchObject({ action: 'create', changed: false });
    expect(pages.get(f.beta)).toMatchObject({ action: 'create', changed: true });
  });
});

describe('previewRedo', () => {
  it('re-plan: only pages this compile created may be archived; changed pages are skipped', async () => {
    handle = setupTestDb();
    const f = seedFinishedCompile(handle.db);
    touchPage(handle.db, f.beta);
    stubNlp();
    const p = await previewRedo(SESSION, 'plan');
    const archivable = p.may_archive.map((x) => x.page_id);
    expect(archivable).toEqual(expect.arrayContaining([f.alpha, f.summary]));
    expect(archivable).not.toContain(f.oldPage);
    expect(archivable).not.toContain(f.beta);
    expect(p.skipped.map((x) => x.page_id)).toEqual([f.beta]);
    expect(p.sources).toBe(2);
    expect(p.model.id).toBe(getCompileModel());
    expect(p.estimate!.cost_usd_high).toBeGreaterThan(0);
    expect(p.max_pages).toBeGreaterThanOrEqual(p.pages);
  });

  it('re-save: lists the held draft and expects no AI cost', async () => {
    handle = setupTestDb();
    seedFinishedCompile(handle.db);
    const calls = stubNlp();
    const p = await previewRedo(SESSION, 'save');
    expect(p.pages).toBe(1);
    expect(p.page_titles).toEqual(['Gamma']);
    expect(p.estimate).toMatchObject({ calls_high: 0, cost_usd_high: 0 });
    expect(calls).not.toContain('/llm/pricing');
  });

  it('re-write: skips a page changed since the compile', async () => {
    handle = setupTestDb();
    const f = seedFinishedCompile(handle.db);
    touchPage(handle.db, f.alpha);
    stubNlp();
    const p = await previewRedo(SESSION, 'write');
    expect(p.skipped.map((x) => x.page_id)).toEqual([f.alpha]);
    expect(p.page_titles).not.toContain('Alpha');
    expect(p.pages).toBe(4); // Old Topic, Beta, Source A, Gamma
  });
});

describe('startRedo refusals', () => {
  it('refuses an older compile and a running one', async () => {
    handle = setupTestDb();
    seedFinishedCompile(handle.db);
    stubNlp();
    seedProgress(handle.db, 'sess-newer', 'completed', 5);
    expect(await refusal(start('write'))).toBe('not_latest');

    handle.db.prepare(`DELETE FROM compile_progress WHERE session_id = 'sess-newer'`).run();
    handle.db.prepare(`UPDATE compile_progress SET status = 'running', started_at = datetime('now')`).run();
    expect(await refusal(start('write'))).toBe('compile_running');
  });

  it('refuses while the wiki is being repaired', async () => {
    handle = setupTestDb();
    seedFinishedCompile(handle.db);
    stubNlp();
    repairState().starting = true;
    expect(await refusal(start('write'))).toBe('wiki_repair_in_progress');
  });

  it('refuses when the model changed or the plan grew since the preview', async () => {
    handle = setupTestDb();
    seedFinishedCompile(handle.db);
    stubNlp();
    expect(await refusal(startRedo({ sessionId: SESSION, point: 'write', expectedPages: 99, model: 'not-the-model' }))).toBe(
      'model_changed',
    );
    expect(await refusal(start('write', 2))).toBe('plan_changed');
    expect(readRedo()).toBeNull();
  });

  it('refuses when there is nothing to save', async () => {
    handle = setupTestDb();
    seedFinishedCompile(handle.db);
    handle.db.prepare(`DELETE FROM page_plans WHERE draft_status = 'draft_too_thin'`).run();
    stubNlp();
    expect(await refusal(start('save'))).toBe('nothing_to_redo');
  });
});

describe('startRedo reset', () => {
  it('re-save puts the held draft back for commit only', async () => {
    handle = setupTestDb();
    const f = seedFinishedCompile(handle.db);
    const calls = stubNlp();
    await start('save');
    const status = (id: string) =>
      (handle!.db.prepare('SELECT draft_status FROM page_plans WHERE plan_id = ?').get(id) as { draft_status: string }).draft_status;
    expect(status(f.plans.gamma)).toBe('crossreffed');
    expect(status(f.plans.alpha)).toBe('committed');
    const steps = JSON.parse((handle.db.prepare('SELECT steps FROM compile_progress').get() as { steps: string }).steps);
    expect(steps.draft.status).toBe('done');
    expect(steps.commit.status).toBe('pending');
    expect(calls).toContain('/webhook/session-compile');
    expect(readRedo()).toMatchObject({ session_id: SESSION, point: 'save', status: 'running' });
  });

  it('re-write keeps each created page id and leaves changed pages alone', async () => {
    handle = setupTestDb();
    const f = seedFinishedCompile(handle.db);
    touchPage(handle.db, f.beta);
    stubNlp();
    await start('write');
    const plan = (id: string) =>
      handle!.db.prepare('SELECT action, existing_page_id, draft_status, draft_content FROM page_plans WHERE plan_id = ?').get(id) as {
        action: string;
        existing_page_id: string | null;
        draft_status: string;
        draft_content: string | null;
      };
    expect(plan(f.plans.alpha)).toMatchObject({ action: 'create', existing_page_id: f.alpha, draft_status: 'planned', draft_content: null });
    expect(plan(f.plans.old)).toMatchObject({ action: 'update', existing_page_id: f.oldPage, draft_status: 'planned' });
    expect(plan(f.plans.beta).draft_status).toBe('committed');
    expect(readRedo()!.skipped.map((p) => p.page_id)).toEqual([f.beta]);
  });

  it('re-plan clears the plans, reopens the sources and stamps the Settings model', async () => {
    handle = setupTestDb();
    const f = seedFinishedCompile(handle.db);
    handle.db.prepare(`UPDATE page_plans SET draft_status = 'rejected' WHERE plan_id = ?`).run(f.plans.gamma);
    setSetting('compile_model', getCompileModel());
    stubNlp();
    await start('plan');
    const left = handle.db.prepare('SELECT plan_id FROM page_plans').all() as Array<{ plan_id: string }>;
    expect(left.map((r) => r.plan_id)).toEqual([f.plans.gamma]);
    const statuses = handle.db.prepare('SELECT compile_status FROM sources').all() as Array<{ compile_status: string }>;
    expect(statuses.every((s) => s.compile_status === 'extracted')).toBe(true);
    const row = handle.db.prepare('SELECT status, compile_model FROM compile_progress').get() as { status: string; compile_model: string };
    expect(row).toEqual({ status: 'queued', compile_model: getCompileModel() });
    const own = readRedo()!.own_pages.map((p) => p.page_id);
    expect(own).toEqual(expect.arrayContaining([f.alpha, f.beta, f.summary]));
    expect(own).not.toContain(f.oldPage);
  });

  it('holds the compile lock while it runs, so Repair wiki refuses', async () => {
    handle = setupTestDb();
    seedFinishedCompile(handle.db);
    stubNlp();
    await start('write');
    expect(getRunningCompileSession()?.session_id).toBe(SESSION);
    await expect(startWikiRepair({ expectedAliases: 0, expectedPages: 0, model: getCompileModel() })).rejects.toMatchObject({
      code: 'session_in_progress',
    });
    expect(await refusal(start('write'))).toBe('compile_running');
  });
});
