/**
 * compile/draft — the category list offered to drafts grows as each draft
 * finishes (plan 2.3, owner decision D7), not once per layer.
 *
 * Before: labels were harvested after a whole layer, so the eleventh entity
 * page of a layer (drafts run ten at a time) never saw the label an earlier
 * entity draft had just chosen, and invented its own.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as draftPOST } from '../app/api/compile/draft/route';
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
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

interface HeldDraft {
  title: string;
  categories: string[];
  release: () => void;
}

/** Holds every draft-page call until the test releases it. */
function holdDrafts(): HeldDraft[] {
  const held: HeldDraft[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (!String(url).endsWith('/pipeline/draft-page')) return new Response('not found', { status: 404 });
      const body = JSON.parse(String(init?.body)) as { title: string; existing_categories: string[] };
      return new Promise<Response>((resolve) => {
        held.push({
          title: body.title,
          categories: body.existing_categories,
          release: () =>
            resolve(
              new Response(
                JSON.stringify({ markdown: `---\ntitle: "${body.title}"\ncategory: Label of ${body.title}\n---\n\nBody.` }),
                { status: 200, headers: { 'Content-Type': 'application/json' } }
              )
            ),
        });
      });
    })
  );
  return held;
}

async function heldCount(held: HeldDraft[], n: number): Promise<void> {
  await vi.waitFor(() => {
    if (held.length < n) throw new Error(`${held.length} drafts started`);
  }, { timeout: 5_000, interval: 5 });
}

describe('compile/draft — category list', () => {
  it('a draft that starts after another finished is offered that draft\'s label', async () => {
    handle = setupTestDb();
    const session_id = 'sess-labels-live';
    seedCompileProgress(handle.db, session_id);
    seedPage(handle.db, { page_id: 'old', title: 'Old page', category: 'Travel' });
    const source_id = seedSource(handle.db, {
      onboarding_session_id: session_id,
      raw_markdown: 'An article about many things.',
    });
    seedExtraction(handle.db, { source_id, llm_output: { entities: [], concepts: [], relationships: [] } });
    // Drafts run ten at a time: the eleventh starts when one of the first ten finishes.
    for (let i = 0; i < 11; i++) {
      seedPagePlan(handle.db, { session_id, title: `Entity ${i}`, page_type: 'entity', source_ids: [source_id] });
    }
    const held = holdDrafts();

    const response = draftPOST(
      new Request('http://test/api/compile/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id }),
      })
    );

    await heldCount(held, 10);
    expect(held.every((h) => h.categories.join() === 'Travel')).toBe(true);
    const first = held[3];
    first.release();
    await heldCount(held, 11);
    const eleventh = held[10];
    expect(eleventh.categories).toEqual(['Travel', `Label of ${first.title}`]);

    for (const h of held) if (h !== first) h.release();
    const res = await response;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { drafted: number }).drafted).toBe(11);
  });
});
