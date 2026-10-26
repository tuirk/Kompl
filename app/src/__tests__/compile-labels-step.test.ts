/**
 * The 'labels' step in the compile pipeline (plan 2.3, owner decision D7).
 *
 * Between crossref and commit, one call merges the category labels the
 * compile's drafts added into labels that mean the same thing; the commit
 * then writes each page once, with its final label, through the outbox.
 * The step runs once per session and never fails the compile.
 *
 * crossref and commit are the real route handlers, reached through a fetch
 * stub; resolve, match, schema and nlp-service are stubbed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as runPOST } from '../app/api/compile/run/route';
import { POST as retryPOST } from '../app/api/compile/retry/route';
import { POST as crossrefPOST } from '../app/api/compile/crossref/route';
import { POST as commitPOST } from '../app/api/compile/commit/route';
import { COMPILE_STEP_KEYS } from '../lib/compile-steps';
import { getCompileProgress } from '../lib/db';
import {
  seedCompileProgress,
  seedExtraction,
  seedPage,
  seedPagePlan,
  seedSource,
  setupTestDb,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

const SESSION = 'sess-labels-step';
const DRAFT = `---\ntitle: "Solana"\ncategory: Crypto\n---\n\n${'Solana is a blockchain. '.repeat(40)}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function post(body: unknown): Request {
  return new Request('http://test/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface Stub {
  calls: string[];
  written: string[];
}

function stubServices(opts: { consolidate: () => Response; writePageOk?: boolean }): Stub {
  const stub: Stub = { calls: [], written: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(url.toString()).pathname;
      stub.calls.push(path);
      const forward = (handler: (r: Request) => Promise<Response>) => handler(post(JSON.parse(String(init?.body ?? '{}'))));
      switch (path) {
        case '/api/compile/crossref':
          return forward(crossrefPOST);
        case '/api/compile/commit':
          return forward(commitPOST);
        case '/api/compile/resolve':
          return json({ canonical_entities: [], canonical_concepts: [] });
        case '/api/compile/match':
          return json({ skipped: true, matches: [], stats: {} });
        case '/api/compile/schema':
          return json({ status: 'already_exists' });
        case '/pipeline/consolidate-labels':
          return opts.consolidate();
        case '/storage/write-page':
          stub.written.push((JSON.parse(String(init?.body)) as { markdown: string }).markdown);
          return opts.writePageOk === false
            ? json({ detail: 'disk full' }, 500)
            : json({ current_path: '/data/pages/x.md.gz', previous_path: null });
        case '/vectors/upsert':
        case '/webhook/session-compile':
          return json({});
      }
      throw new Error(`unexpected fetch in test: ${url.toString()}`);
    })
  );
  return stub;
}

/** A session with one extracted source and one draft ready to commit, labelled "Crypto". */
function seedSession(): void {
  const db = handle!.db;
  seedPage(db, { page_id: 'btc', title: 'Bitcoin', category: 'Cryptocurrency' });
  const source_id = seedSource(db, { onboarding_session_id: SESSION, compile_status: 'in_progress' });
  seedExtraction(db, { source_id });
  seedCompileProgress(db, SESSION);
  // Planned and drafted already: the draft below is ready to commit.
  const steps = Object.fromEntries(
    COMPILE_STEP_KEYS.map((k) => [k, { status: k === 'plan' || k === 'draft' ? 'done' : 'pending' }])
  );
  db.prepare(`UPDATE compile_progress SET status = 'queued', steps = ? WHERE session_id = ?`).run(JSON.stringify(steps), SESSION);
  seedPagePlan(db, {
    session_id: SESSION,
    title: 'Solana',
    page_type: 'entity',
    action: 'create',
    source_ids: [source_id],
    draft_status: 'crossreffed',
    draft_content: DRAFT,
  });
}

async function runAndWait() {
  expect((await runPOST(post({ session_id: SESSION }))).status).toBe(200);
  await vi.waitFor(
    () => {
      const status = getCompileProgress(SESSION)?.status;
      if (status !== 'completed' && status !== 'failed') throw new Error(`still ${status}`);
    },
    { timeout: 10_000, interval: 10 }
  );
  const p = getCompileProgress(SESSION)!;
  return { status: p.status, steps: JSON.parse(p.steps) as Record<string, { status: string; detail?: string }> };
}

function solanaCategory(): string | null {
  return (handle!.db.prepare(`SELECT category FROM pages WHERE title = 'Solana'`).get() as { category: string | null }).category;
}

const mergeCrypto = () => json({ items: [{ label: 'Crypto', into: 'Cryptocurrency', reason: 'short form' }], count: 1 });

describe('compile pipeline: labels step', () => {
  it('merges before commit, so the page is written once with the merged label', async () => {
    handle = setupTestDb();
    seedSession();
    const stub = stubServices({ consolidate: mergeCrypto });

    const result = await runAndWait();

    expect(result.status).toBe('completed');
    expect(result.steps.labels).toEqual({ status: 'done', detail: '1 category merged (1 page)' });
    const order = stub.calls.filter((p) => ['/api/compile/crossref', '/pipeline/consolidate-labels', '/api/compile/commit'].includes(p));
    expect(order).toEqual(['/api/compile/crossref', '/pipeline/consolidate-labels', '/api/compile/commit']);
    expect(solanaCategory()).toBe('Cryptocurrency');
    expect(stub.written).toHaveLength(1);
    expect(stub.written[0]).toContain('\ncategory: Cryptocurrency\n');
  });

  it('at the daily cost cap the compile still completes, labels unmerged', async () => {
    handle = setupTestDb();
    seedSession();
    stubServices({ consolidate: () => json({ detail: 'daily_cost_ceiling' }, 503) });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runAndWait();

    expect(result.status).toBe('completed');
    expect(result.steps.labels).toEqual({ status: 'done', detail: '1 new not checked: daily cost limit reached' });
    expect(solanaCategory()).toBe('Crypto');
  });

  it('runs once per session: a retry after commit failed does not call again', async () => {
    handle = setupTestDb();
    seedSession();
    stubServices({ consolidate: mergeCrypto, writePageOk: false });
    const first = await runAndWait();
    expect(first.status).toBe('failed');
    expect(first.steps.labels.status).toBe('done');

    const stub = stubServices({ consolidate: mergeCrypto });
    expect((await retryPOST(post({ session_id: SESSION }))).status).toBe(200);
    const second = await runAndWait();

    expect(second.status).toBe('completed');
    expect(stub.calls).not.toContain('/pipeline/consolidate-labels');
    expect(second.steps.labels).toEqual({ status: 'done', detail: '1 category merged (1 page)' });
    expect(solanaCategory()).toBe('Cryptocurrency');
  });
});
