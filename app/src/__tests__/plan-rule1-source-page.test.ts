/**
 * Rule 1 finds a source's own page through provenance, by source_id.
 *
 * Page titles are not unique and match any page type: a source titled
 * "Ethereum" was planned as an update of the Ethereum entity page and
 * overwrote it as a source summary, and two sources titled "Introduction"
 * shared one summary page (audit 3, B9).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { POST as planPOST } from '../app/api/compile/plan/route';
import {
  setupTestDb,
  seedSource,
  seedExtraction,
  seedPage,
  seedProvenance,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

interface PlanResponse {
  pages: Array<{ title: string; page_type: string; action: string; source_ids: string[]; existing_page_id?: string }>;
}

async function planSourcePage(session_id: string, source_id: string) {
  const resp = await planPOST(
    new Request('http://test/api/compile/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id, canonical_entities: [] }),
    }),
  );
  expect(resp.status).toBe(200);
  const data = (await resp.json()) as PlanResponse;
  return data.pages.find(
    (p) => (p.page_type === 'source-summary' || p.page_type === 'original-source') && p.source_ids.includes(source_id),
  );
}

function sessionSource(title: string, session_id: string): string {
  const { db } = handle!;
  const source_id = seedSource(db, { title, onboarding_session_id: session_id, compile_status: 'extracted', raw_markdown: 'x'.repeat(900) });
  seedExtraction(db, { source_id, llm_output: { entities: [], concepts: [], relationships: [] } });
  return source_id;
}

describe('plan Rule 1: a source page is found by provenance', () => {
  it('a source titled like an entity page gets its own page', async () => {
    handle = setupTestDb();
    const entityPage = seedPage(handle.db, { page_id: 'ethereum', title: 'Ethereum', page_type: 'entity' });
    seedProvenance(handle.db, entityPage, seedSource(handle.db, { compile_status: 'active' }));
    const sid = sessionSource('Ethereum', 'sess-eth');

    const plan = await planSourcePage('sess-eth', sid);
    expect(plan?.action).toBe('create');
    expect(plan?.existing_page_id).toBeUndefined();
  });

  it('updates the page that holds the source, whatever its title now', async () => {
    handle = setupTestDb();
    const sid = sessionSource('Renamed article', 'sess-retitled');
    const own = seedPage(handle.db, { page_id: 'old-title', title: 'Old title', page_type: 'source-summary' });
    seedProvenance(handle.db, own, sid);

    const plan = await planSourcePage('sess-retitled', sid);
    expect(plan?.action).toBe('update');
    expect(plan?.existing_page_id).toBe(own);
  });

  it("two sources with one title do not share a page", async () => {
    handle = setupTestDb();
    const first = seedSource(handle.db, { title: 'Introduction', compile_status: 'active' });
    const firstPage = seedPage(handle.db, { page_id: 'intro-a', title: 'Introduction', page_type: 'source-summary' });
    seedProvenance(handle.db, firstPage, first);
    const second = sessionSource('Introduction', 'sess-intro');

    const plan = await planSourcePage('sess-intro', second);
    expect(plan?.action).toBe('create');
  });

  it('prefers the page that holds only this source', async () => {
    handle = setupTestDb();
    const sid = sessionSource('Ethereum', 'sess-two');
    // An entity page an old bug overwrote as a summary: it holds many sources.
    const mixed = seedPage(handle.db, { page_id: 'mixed', title: 'Ethereum', page_type: 'source-summary' });
    seedProvenance(handle.db, mixed, seedSource(handle.db, { compile_status: 'active' }));
    seedProvenance(handle.db, mixed, sid, 'updated');
    const own = seedPage(handle.db, { page_id: 'own', title: 'Ethereum (article)', page_type: 'source-summary' });
    seedProvenance(handle.db, own, sid);

    const plan = await planSourcePage('sess-two', sid);
    expect(plan?.existing_page_id).toBe(own);
  });

  it('a summary page with no provenance is still found by its title', async () => {
    handle = setupTestDb();
    const legacy = seedPage(handle.db, { page_id: 'legacy', title: 'Old notes', page_type: 'original-source' });
    const sid = sessionSource('Old notes', 'sess-legacy');

    const plan = await planSourcePage('sess-legacy', sid);
    expect(plan?.action).toBe('update');
    expect(plan?.existing_page_id).toBe(legacy);
  });

  it('the title fallback skips pages of other types and pages that hold a source', async () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'notes-entity', title: 'Notes', page_type: 'entity' });
    const held = seedPage(handle.db, { page_id: 'notes-held', title: 'Notes', page_type: 'source-summary' });
    seedProvenance(handle.db, held, seedSource(handle.db, { compile_status: 'active' }));
    const sid = sessionSource('Notes', 'sess-notes');

    const plan = await planSourcePage('sess-notes', sid);
    expect(plan?.action).toBe('create');
  });
});
