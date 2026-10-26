/**
 * Test harness for POST /api/compile/run: a fetch stub for the pipeline's
 * internal calls, with any call held open until the test releases it.
 */

import type Database from 'better-sqlite3';
import { vi } from 'vitest';
import { COMPILE_STEP_KEYS } from '../../lib/compile-steps';

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function post(body: unknown): Request {
  return new Request('http://test/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const COMMIT_OK = {
  committed: 0,
  failed: 0,
  thin_drafts_skipped: 0,
  sources_activated: 0,
  flush_failures: 0,
};

const DEFAULTS: Record<string, () => Response> = {
  '/health': () => json({ status: 'ok' }),
  '/api/compile/resolve': () => json({ canonical_entities: [], canonical_concepts: [] }),
  '/api/compile/match': () => json({ skipped: true, matches: [], stats: {} }),
  '/api/compile/plan': () => json({ stats: { total: 0 } }),
  '/api/compile/draft': () => json({ drafted: 0, failed: 0 }),
  '/api/compile/crossref': () => json({ wikilinks_added: 0 }),
  '/api/compile/commit': () => json(COMMIT_OK),
  '/api/compile/schema': () => json({ status: 'already_exists' }),
  '/storage/write-page': () => json({ current_path: '/data/pages/x.md.gz', previous_path: null }),
  '/vectors/upsert': () => json({}),
  '/webhook/session-compile': () => json({ ok: true }),
};

export interface HeldCall {
  path: string;
  release: (res: Response) => void;
}

export interface PipelineStub {
  /** Every path the pipeline fetched, in order. */
  calls: string[];
  /** Calls to held paths, waiting for release(). */
  held: HeldCall[];
}

/**
 * Stubs fetch with canned answers (`answers` overrides the defaults). Calls
 * to a path in `hold` stay open until the test calls release() on the
 * matching entry of `held`.
 */
export function stubPipeline(hold: string[] = [], answers: Record<string, () => Response> = {}): PipelineStub {
  const stub: PipelineStub = { calls: [], held: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const path = new URL(url.toString()).pathname;
      stub.calls.push(path);
      if (hold.includes(path)) {
        return new Promise<Response>((resolve) => stub.held.push({ path, release: resolve }));
      }
      const answer = answers[path] ?? DEFAULTS[path];
      if (!answer) throw new Error(`unexpected fetch in test: ${url.toString()}`);
      return answer();
    })
  );
  return stub;
}

/** Waits until the pipeline has made `n` held calls to `path`. */
export async function heldCall(stub: PipelineStub, path: string, n = 1): Promise<HeldCall> {
  await vi.waitFor(
    () => {
      if (stub.held.filter((h) => h.path === path).length < n) throw new Error(`waiting for ${path}`);
    },
    { timeout: 5_000, interval: 5 }
  );
  return stub.held.filter((h) => h.path === path)[n - 1];
}

/** Lets pending promise chains run (the pipeline's writes after a released call). */
export function settle(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** compile_progress as /api/onboarding/finalize leaves it: queued, every step pending. */
export function seedQueuedProgress(db: Database.Database, session_id: string, startedMinutesAgo?: number): void {
  const steps = Object.fromEntries(COMPILE_STEP_KEYS.map((k) => [k, { status: 'pending' }]));
  db.prepare(
    `INSERT INTO compile_progress (session_id, status, steps, source_count, started_at)
     VALUES (?, 'queued', ?, 0, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ? || ' minutes') END)`
  ).run(session_id, JSON.stringify(steps), startedMinutesAgo ?? null, `-${startedMinutesAgo ?? 0}`);
}

export function readSteps(stepsJson: string): Record<string, { status: string; detail?: string }> {
  return JSON.parse(stepsJson) as Record<string, { status: string; detail?: string }>;
}
