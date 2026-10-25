/**
 * Provenance records only the sources a draft used, once per page
 * (plan 2.1; audit B4 and B11).
 *
 * B4: the draft prompt was cut at the budget, yet the commit recorded an
 * 'updated' row for every plan source. B11: every update re-inserted rows
 * for every historical source, so the table grew with each update and
 * claimed contributions that did not happen. The draft now stores the
 * sources its prompt carried (page_plans.used_source_ids); the compile
 * commit and the approve path credit those, each once per page.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as commitPOST } from '../app/api/compile/commit/route';
import { commitSinglePlan } from '../lib/approve-plan';
import { contributingSourceIds } from '../lib/plan-provenance';
import {
  setupTestDb,
  seedSource,
  seedPage,
  seedPagePlan,
  seedCompileProgress,
  seedProvenance,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

function stubFetchOk(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ current_path: '/tmp/fake', previous_path: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

const DRAFT_MD = (title: string): string =>
  `---\ntitle: "${title}"\npage_type: entity\ncategory: Test\nsummary: "t"\n---\n\n${'body '.repeat(200)}`;

function provenance(page_id: string): Array<{ source_id: string; contribution_type: string }> {
  return handle!.db
    .prepare('SELECT source_id, contribution_type FROM provenance WHERE page_id = ? ORDER BY id')
    .all(page_id) as Array<{ source_id: string; contribution_type: string }>;
}

async function commit(session_id: string): Promise<Response> {
  return commitPOST(
    new Request('http://test/api/compile/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id }),
    }),
  );
}

/** A Rule 2 page with three earlier contributors and one new session source. */
function seedHubUpdate(session_id: string, used: string[] | null, status = 'crossreffed') {
  const db = handle!.db;
  seedCompileProgress(db, session_id);
  const page_id = seedPage(db, { page_id: 'page-hub', title: 'Hub', page_type: 'entity' });
  const old = ['old-a', 'old-b', 'old-c'].map((id) => seedSource(db, { source_id: id, raw_markdown: 'x'.repeat(600) }));
  for (const id of old) seedProvenance(db, page_id, id, 'created');
  const fresh = seedSource(db, { source_id: 'new-1', onboarding_session_id: session_id, raw_markdown: 'y'.repeat(600) });
  const plan_id = seedPagePlan(db, {
    session_id,
    title: 'Hub',
    page_type: 'entity',
    action: 'update',
    existing_page_id: page_id,
    source_ids: [...old, fresh],
    draft_status: status,
    draft_content: DRAFT_MD('Hub'),
    used_source_ids: used,
  });
  return { page_id, plan_id, old, fresh };
}

describe('contributingSourceIds', () => {
  it('keeps the used sources that are still plan sources, in plan order', () => {
    expect(contributingSourceIds(['a', 'b', 'c'], JSON.stringify(['c', 'a', 'gone']))).toEqual(['a', 'c']);
  });

  it('credits every plan source when the draft recorded none (older drafts)', () => {
    expect(contributingSourceIds(['a', 'b'], null)).toEqual(['a', 'b']);
  });

  it('an empty list credits nobody', () => {
    expect(contributingSourceIds(['a', 'b'], '[]')).toEqual([]);
  });
});

describe('compile/commit — provenance from used_source_ids', () => {
  it('an update credits the new source once and adds no rows for earlier contributors', async () => {
    handle = setupTestDb();
    const { page_id } = seedHubUpdate('sess-hub-1', ['old-a', 'new-1']);
    stubFetchOk();

    expect((await commit('sess-hub-1')).status).toBe(200);

    expect(provenance(page_id)).toEqual([
      { source_id: 'old-a', contribution_type: 'created' },
      { source_id: 'old-b', contribution_type: 'created' },
      { source_id: 'old-c', contribution_type: 'created' },
      { source_id: 'new-1', contribution_type: 'updated' },
    ]);
    const row = handle.db.prepare('SELECT source_count FROM pages WHERE page_id = ?').get(page_id) as { source_count: number };
    expect(row.source_count).toBe(4);
  });

  it('a source the prompt budget left out is not credited', async () => {
    handle = setupTestDb();
    const db = handle.db;
    seedCompileProgress(db, 'sess-cut');
    const page_id = seedPage(db, { page_id: 'page-cut', title: 'Cut', page_type: 'entity' });
    const kept = seedSource(db, { source_id: 'kept', onboarding_session_id: 'sess-cut', raw_markdown: 'k'.repeat(600) });
    const dropped = seedSource(db, { source_id: 'dropped', raw_markdown: 'd'.repeat(600) });
    seedPagePlan(db, {
      session_id: 'sess-cut',
      title: 'Cut',
      page_type: 'entity',
      action: 'update',
      existing_page_id: page_id,
      source_ids: [dropped, kept],
      draft_status: 'crossreffed',
      draft_content: DRAFT_MD('Cut'),
      used_source_ids: [kept],
    });
    stubFetchOk();

    expect((await commit('sess-cut')).status).toBe(200);
    expect(provenance(page_id)).toEqual([{ source_id: 'kept', contribution_type: 'updated' }]);
  });

  it('a draft without used_source_ids credits every plan source, still once per page', async () => {
    handle = setupTestDb();
    const { page_id } = seedHubUpdate('sess-hub-legacy', null);
    stubFetchOk();

    expect((await commit('sess-hub-legacy')).status).toBe(200);

    const rows = provenance(page_id);
    expect(rows.filter((r) => r.source_id === 'old-a')).toHaveLength(1);
    expect(rows.map((r) => r.source_id).sort()).toEqual(['new-1', 'old-a', 'old-b', 'old-c']);
  });

  it("a source with only a 'mentioned' link gains an 'updated' row when the draft uses it", async () => {
    handle = setupTestDb();
    const db = handle.db;
    seedCompileProgress(db, 'sess-mention');
    const page_id = seedPage(db, { page_id: 'page-m', title: 'M', page_type: 'entity' });
    const src = seedSource(db, { source_id: 'mentioned-1', raw_markdown: 'm'.repeat(600) });
    seedProvenance(db, page_id, src, 'mentioned');
    seedPagePlan(db, {
      session_id: 'sess-mention',
      title: 'M',
      page_type: 'entity',
      action: 'update',
      existing_page_id: page_id,
      source_ids: [src],
      draft_status: 'crossreffed',
      draft_content: DRAFT_MD('M'),
      used_source_ids: [src],
    });
    stubFetchOk();

    expect((await commit('sess-mention')).status).toBe(200);
    expect(provenance(page_id)).toEqual([
      { source_id: 'mentioned-1', contribution_type: 'mentioned' },
      { source_id: 'mentioned-1', contribution_type: 'updated' },
    ]);
  });
});

describe('approve — provenance from used_source_ids', () => {
  it('approving an update credits only the used sources, once per page', async () => {
    handle = setupTestDb();
    const { page_id, plan_id } = seedHubUpdate('sess-hub-approve', ['new-1'], 'pending_approval');
    stubFetchOk();

    const result = await commitSinglePlan(plan_id);
    expect(result.ok).toBe(true);

    expect(provenance(page_id)).toEqual([
      { source_id: 'old-a', contribution_type: 'created' },
      { source_id: 'old-b', contribution_type: 'created' },
      { source_id: 'old-c', contribution_type: 'created' },
      { source_id: 'new-1', contribution_type: 'updated' },
    ]);
  });
});
