/**
 * An update draft records the version of the page it read
 * (page_plans.base_version, schema v30), so approving it later can tell
 * whether the page changed since (lib/approve-plan.ts). A new-page draft
 * reads no page and records none.
 */

import { it, expect, afterEach, vi } from 'vitest';
import { POST as draftPOST } from '../app/api/compile/draft/route';
import { pageTextVersionToken } from '../lib/page-rewrite';
import {
  setupTestDb,
  seedSource,
  seedExtraction,
  seedPage,
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

it('stores the page version an update draft read, and none for a new page', async () => {
  handle = setupTestDb();
  const { db } = handle;
  const session_id = 'sess-base';
  seedCompileProgress(db, session_id);
  const source_id = seedSource(db, { onboarding_session_id: session_id, raw_markdown: 'Fresh facts about Claude.' });
  seedExtraction(db, {
    source_id,
    llm_output: { entities: [{ name: 'Claude', type: 'PRODUCT' }, { name: 'Gemini', type: 'PRODUCT' }], concepts: [], relationships: [] },
  });
  const page_id = seedPage(db, { page_id: 'page-claude', title: 'Claude', page_type: 'entity' });
  db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run('---\ntitle: "Claude"\n---\n\nOld text.', page_id);
  const update = seedPagePlan(db, {
    session_id,
    title: 'Claude',
    action: 'update',
    source_ids: [source_id],
    existing_page_id: page_id,
  });
  const create = seedPagePlan(db, { session_id, title: 'Gemini', action: 'create', source_ids: [source_id] });
  const expected = pageTextVersionToken(page_id);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/pipeline/draft-page')) {
        return Response.json({ markdown: '---\ntitle: "stub"\n---\n\nstub body' });
      }
      return new Response('not found', { status: 404 });
    }),
  );
  const res = await draftPOST(
    new Request('http://test/api/compile/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id }),
    }),
  );
  expect(res.status).toBe(200);

  const baseOf = (plan_id: string) =>
    (db.prepare('SELECT draft_status, base_version FROM page_plans WHERE plan_id = ?').get(plan_id) as {
      draft_status: string;
      base_version: string | null;
    });
  expect(baseOf(update)).toEqual({ draft_status: 'drafted', base_version: expected });
  expect(baseOf(create)).toEqual({ draft_status: 'drafted', base_version: null });
});
