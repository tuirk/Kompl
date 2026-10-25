/**
 * MCP add_source and the one-compile-at-a-time gate. A queued compile that
 * nothing will start any more (its trigger failed, or it is older than the
 * reconciler's five minutes) no longer refuses an agent's add: the add goes
 * through and supersedes it, as the app's own Add sources does. A compile
 * that runs, or may still be starting, refuses it with when it started and
 * when to try again. The UI's gate (getRunningCompileSession) is unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/trigger-n8n', () => ({
  triggerSessionCompile: vi.fn(async () => ({ ok: true })),
}));

import { POST } from '../app/api/agent/sources/route';
import { getRunningCompileSession, logActivity, setAgentAddSourcesEnabled } from '../lib/db';
import { triggerSessionCompile } from '../lib/trigger-n8n';
import { seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle;

beforeEach(() => {
  handle = setupTestDb();
  vi.mocked(triggerSessionCompile).mockClear();
  setAgentAddSourcesEnabled(true);
});

afterEach(() => handle.cleanup());

async function add() {
  const res = await POST(
    new Request('http://test/api/agent/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: ['https://example.org/new'] }),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** A compile_progress row; `started` is minutes ago (null: never started), `created` likewise. */
function session(session_id: string, status: string, { started = null as number | null, created = 0 } = {}) {
  handle.db
    .prepare(
      `INSERT INTO compile_progress (session_id, status, steps, started_at, created_at)
       VALUES (?, ?, '{}', CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END, datetime('now', ?))`
    )
    .run(session_id, status, started, `-${started ?? 0} minutes`, `-${created} minutes`);
}

const statusOf = (session_id: string) =>
  (handle.db.prepare('SELECT status FROM compile_progress WHERE session_id = ?').get(session_id) as { status: string }).status;
const staged = () => (handle.db.prepare('SELECT COUNT(*) AS n FROM collect_staging').get() as { n: number }).n;
const confirmed = (session_id: string) =>
  logActivity('onboarding_confirmed', { source_id: null, details: { session_id, queued: 1, deleted: 0 } });
const triggerFailed = (session_id: string) =>
  logActivity('compile_trigger_failed', { source_id: null, details: { session_id, reason: 'n8n_unreachable' } });
/** Move every activity row logged so far `minutes` into the past. */
const ageActivity = (minutes: number) =>
  handle.db.prepare(`UPDATE activity_log SET timestamp = datetime(timestamp, ?)`).run(`-${minutes} minutes`);

describe('add_source and a compile left queued', () => {
  it('adds after a compile whose start failed, superseding it as the app does', async () => {
    session('left', 'queued');
    confirmed('left');
    triggerFailed('left');
    // The UI's gate still sees the row until the reconciler clears it.
    expect(getRunningCompileSession()?.session_id).toBe('left');

    const res = await add();
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    expect(triggerSessionCompile).toHaveBeenCalledWith(res.body.session_id);
    expect(statusOf('left')).toBe('cancelled');
  });

  it("adds after a queued compile older than the reconciler's five minutes that nothing started", async () => {
    session('stale', 'queued', { created: 10 });
    expect((await add()).status).toBe(200);
    expect(statusOf('stale')).toBe('cancelled');
  });

  it('adds after a recompile whose trigger failed (logged by source)', async () => {
    const source_id = seedSource(handle.db, { onboarding_session_id: 'rc', compile_status: 'pending' });
    session('rc', 'queued', { created: 60 });
    logActivity('source_recompile_triggered', { source_id, details: { title: 'x' } });
    logActivity('compile_trigger_failed', { source_id, details: { title: 'x', event: 'session-compile', reason: 'n8n_timeout' } });
    expect((await add()).status).toBe(200);
  });
});

describe('add_source waits for a compile that runs or may still be starting', () => {
  it('says when the running compile started and to try again after it', async () => {
    session('busy', 'running', { started: 10, created: 11 });
    const started = (handle.db.prepare(`SELECT started_at FROM compile_progress`).get() as { started_at: string }).started_at;
    const res = await add();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'compile_running', active_session_id: 'busy', started_at: started });
    expect(res.body.message).toBe(
      `A compile is already running: session \`busy\`, started ${started} UTC. Kompl runs one compile at a time and ` +
        'each add_source call starts one, so try again after it finishes (recent_changes with that session_id shows its progress).'
    );
    expect(staged()).toBe(0);
  });

  it('waits for a compile confirmed a moment ago whose trigger may still be on its way', async () => {
    session('fresh', 'queued');
    confirmed('fresh');
    const res = await add();
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/^A compile is starting now: session `fresh`\. Kompl runs one compile at a time/);
    expect(statusOf('fresh')).toBe('queued');
    expect(staged()).toBe(0);
    expect(triggerSessionCompile).not.toHaveBeenCalled();
  });

  it('waits when a failed start was tried again a moment ago', async () => {
    session('again', 'queued', { created: 30 });
    confirmed('again');
    triggerFailed('again');
    ageActivity(30);
    confirmed('again');
    expect((await add()).status).toBe(409);
    expect(statusOf('again')).toBe('queued');
  });

  it('waits for a recompile started a moment ago, though its session is old', async () => {
    const source_id = seedSource(handle.db, { onboarding_session_id: 'rc2', compile_status: 'pending' });
    session('rc2', 'queued', { created: 120 });
    logActivity('source_recompile_triggered', { source_id, details: { title: 'x' } });
    expect((await add()).status).toBe(409);
  });

  it('waits for a compile queued again for a retry after it had started', async () => {
    session('retry', 'queued', { started: 40, created: 45 });
    const res = await add();
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('session `retry`, started ');
  });
});
