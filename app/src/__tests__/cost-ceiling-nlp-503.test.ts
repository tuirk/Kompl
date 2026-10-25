/**
 * At the daily LLM spending limit nlp-service answers 503
 * {"detail":"daily_cost_ceiling"} before sending anything
 * (nlp-service/tests/test_cost_ceiling_routes.py). The compile routes turn
 * that into their daily_cost_ceiling outcome: a failed plan for a draft, a
 * 503 for an extract, with nothing saved.
 */

import { it, expect, afterEach, vi } from 'vitest';
import { POST as draftPOST } from '../app/api/compile/draft/route';
import { POST as extractPOST } from '../app/api/compile/extract/route';
import {
  setupTestDb,
  seedSource,
  seedExtraction,
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

const atCeiling = () => Response.json({ detail: 'daily_cost_ceiling' }, { status: 503 });

function post(body: object): Request {
  return new Request('http://test/api/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

it('a draft refused at the ceiling fails its plan as daily_cost_ceiling', async () => {
  handle = setupTestDb();
  const { db } = handle;
  const session_id = 'sess-ceiling';
  seedCompileProgress(db, session_id);
  const source_id = seedSource(db, { onboarding_session_id: session_id, raw_markdown: 'Facts about Claude.' });
  seedExtraction(db, { source_id, llm_output: { entities: [{ name: 'Claude', type: 'PRODUCT' }], concepts: [], relationships: [] } });
  const plan_id = seedPagePlan(db, { session_id, title: 'Claude', action: 'create', source_ids: [source_id] });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) =>
      String(url).endsWith('/pipeline/draft-page') ? atCeiling() : new Response('not found', { status: 404 }),
    ),
  );
  const res = await draftPOST(post({ session_id }));

  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ drafted: 0, failed: 1 });
  expect(db.prepare('SELECT draft_status, draft_error FROM page_plans WHERE plan_id = ?').get(plan_id)).toEqual({
    draft_status: 'failed',
    draft_error: 'daily_cost_ceiling',
  });
});

it('an extract refused at the ceiling answers 503 daily_cost_ceiling and saves nothing', async () => {
  handle = setupTestDb();
  const { db } = handle;
  const source_id = seedSource(db, { raw_markdown: 'Facts about Claude.' });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/extract/ner')) {
        return Response.json({ source_id, entities: [], entity_count: 0, entity_density: 'low' });
      }
      if (u.endsWith('/extract/route')) return Response.json({ profile: 'default', methods: [], skip: [] });
      if (u.endsWith('/pipeline/extract-llm')) return atCeiling();
      return new Response('not found', { status: 404 });
    }),
  );
  const res = await extractPOST(post({ source_id }));

  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: 'daily_cost_ceiling' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM extractions WHERE source_id = ?').get(source_id)).toEqual({ n: 0 });
  expect(db.prepare('SELECT compile_status FROM sources WHERE source_id = ?').get(source_id)).toEqual({
    compile_status: 'pending',
  });
});
