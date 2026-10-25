/**
 * Plan and resolve take drafts waiting for approval into account (plan 1.8).
 *
 * With auto-approve off, a compile's drafts wait for approval, and the plan
 * step only looked at pages. A second compile naming the same subject
 * planned a second "create X", and approving both gave two X pages
 * (audit 3, B10). A pending draft that creates a page now counts as that
 * page: the plan step plans no second create of it, and the resolver binds
 * names to its title as it does to a page's.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as planPOST } from '../app/api/compile/plan/route';
import { POST as resolvePOST } from '../app/api/compile/resolve/route';
import { getResolverPageTitles } from '../lib/db';
import {
  setupTestDb,
  seedSource,
  seedExtraction,
  seedPage,
  seedPagePlan,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

interface PlannedPage {
  title: string;
  page_type: string;
  action: string;
  source_ids: string[];
}

async function plan(session_id: string, canonical_entities: unknown[], canonical_concepts: unknown[] = []) {
  const resp = await planPOST(
    new Request('http://test/api/compile/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id, canonical_entities, canonical_concepts }),
    }),
  );
  expect(resp.status).toBe(200);
  return (await resp.json()) as { pages: PlannedPage[]; stats: Record<string, number> };
}

function source(session_id: string, entities: Array<{ name: string; type: string }>, title?: string): string {
  const source_id = seedSource(handle!.db, {
    title,
    onboarding_session_id: session_id,
    compile_status: session_id === 'sess-b' ? 'extracted' : 'active',
    raw_markdown: 'x'.repeat(900),
  });
  seedExtraction(handle!.db, { source_id, llm_output: { entities, concepts: [], relationships: [] } });
  return source_id;
}

const pending = (title: string, page_type: string, source_ids: string[], status = 'pending_approval') =>
  seedPagePlan(handle!.db, {
    session_id: 'sess-a',
    title,
    page_type,
    action: 'create',
    source_ids,
    draft_status: status,
    draft_content: `---\ntitle: "${title}"\n---\nbody`,
  });

describe('plan: no second create while one waits for approval', () => {
  it('a subject whose new page waits for approval is not planned again', async () => {
    handle = setupTestDb();
    const old = source('sess-a', [{ name: 'Gemini', type: 'PRODUCT' }]);
    pending('Gemini', 'entity', [old]);
    const now = source('sess-b', [{ name: 'Gemini', type: 'PRODUCT' }]);

    const data = await plan('sess-b', [{ canonical: 'gemini', type: 'PRODUCT', aliases: [], source_ids: [now], method: 'existing_page_title' }]);
    expect(data.pages.filter((p) => p.title.toLowerCase() === 'gemini')).toEqual([]);
    expect(data.stats.pending_creates_skipped).toBe(1);
  });

  it('a rejected or committed draft does not hold the subject back', async () => {
    handle = setupTestDb();
    const old = source('sess-a', [{ name: 'Gemini', type: 'PRODUCT' }]);
    pending('Gemini', 'entity', [old], 'rejected');
    const now = source('sess-b', [{ name: 'Gemini', type: 'PRODUCT' }]);

    const data = await plan('sess-b', [{ canonical: 'Gemini', type: 'PRODUCT', aliases: [], source_ids: [now], method: 'none' }]);
    expect(data.pages.filter((p) => p.title === 'Gemini').map((p) => p.action)).toEqual(['create']);
    expect(data.stats.pending_creates_skipped).toBe(0);
  });

  it("a source still gets its page plan while an older one waits (approval refuses the second)", async () => {
    handle = setupTestDb();
    const sid = source('sess-b', [], 'An article');
    pending('An article', 'source-summary', [sid]);

    const data = await plan('sess-b', []);
    // Commit activates the sources its plans name, so every session source keeps one.
    expect(data.pages.filter((p) => p.source_ids.includes(sid)).map((p) => p.action)).toEqual(['create']);
  });

  it('an existing page is still updated whatever waits for approval', async () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'gemini', title: 'Gemini', page_type: 'entity' });
    const old = source('sess-a', [{ name: 'Gemini', type: 'PRODUCT' }]);
    pending('Gemini', 'entity', [old]);
    const now = source('sess-b', [{ name: 'Gemini', type: 'PRODUCT' }]);

    const data = await plan('sess-b', [{ canonical: 'Gemini', type: 'PRODUCT', aliases: [], source_ids: [now], method: 'existing_page_title' }]);
    expect(data.pages.filter((p) => p.title === 'Gemini').map((p) => p.action)).toEqual(['update']);
  });
});

describe('resolve: a page waiting for approval is matched like a page', () => {
  it('lists the titles of pending new entity and concept pages with the pages', () => {
    handle = setupTestDb();
    seedPage(handle.db, { title: 'Mercury', page_type: 'entity', summary: 'The planet closest to the Sun.' });
    pending('Gemini', 'entity', []);
    pending('Contrast ratio', 'concept', []);
    pending('Gemini vs Claude', 'comparison', []);
    pending('Old idea', 'concept', [], 'rejected');

    expect(getResolverPageTitles()).toEqual([
      { title: 'Contrast ratio', page_type: 'concept', summary: null },
      { title: 'Gemini', page_type: 'entity', summary: null },
      { title: 'Mercury', page_type: 'entity', summary: 'The planet closest to the Sun.' },
    ]);
  });

  it('sends them to Layer 1', async () => {
    handle = setupTestDb();
    const session_id = 'sess-b';
    source(session_id, [{ name: 'Gemini', type: 'PRODUCT' }]);
    pending('Gemini', 'entity', []);

    let titles: unknown = null;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.endsWith('/resolve/fuzzy')) {
        titles = body.existing_page_titles;
        return Response.json({ resolved: [], unresolved: body.entities });
      }
      if (url.endsWith('/resolve/embedding')) return Response.json({ resolved: [], ambiguous: [], unresolved: body.entities });
      throw new Error(`unexpected fetch: ${url}`);
    }));

    const res = await resolvePOST(new Request('http://test/api/compile/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id }),
    }));
    expect(res.status).toBe(200);
    expect(titles).toEqual([{ title: 'Gemini', page_type: 'entity', summary: null }]);
  });
});
