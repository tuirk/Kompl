/**
 * Cross-session topic canonicalisation — regression coverage for the fix that
 * extends the resolver to compare session entities/concepts against existing
 * wiki page titles, and reshapes plan/route.ts Rule 3 to consume the resulting
 * canonical_concepts.
 *
 * These tests exercise plan/route.ts directly with crafted canonical_entities
 * and canonical_concepts bodies — the kind of payload the resolver emits after
 * anchoring via Layer 1/2 against existing_page_titles. No fetch mocking is
 * needed for the plan-side tests because the planner is pure DB logic.
 *
 * The approve-plan test mocks /storage/write-page and /vectors/upsert (same
 * pattern as auto-approve-off.test.ts) because commitSinglePlan hits those.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { POST as planPOST } from '../app/api/compile/plan/route';
import { commitSinglePlan } from '../lib/approve-plan';
import {
  setupTestDb,
  seedSource,
  seedExtraction,
  seedPage,
  seedPagePlan,
  seedCompileProgress,
  type TestDbHandle,
} from './helpers/test-db';
import { bulkInsertAliases, getAllAliases } from '../lib/db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

interface ResolvedGroup {
  canonical: string;
  type: string;
  aliases: string[];
  source_ids: string[];
  method: string;
}

interface PlanResponse {
  pages: Array<{
    title: string;
    page_type: string;
    action: string;
    existing_page_id?: string;
    source_ids: string[];
  }>;
  stats: Record<string, number>;
}

function planRequest(body: Record<string, unknown>): Request {
  return new Request('http://test/api/compile/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 2 (entity) — resolver-anchored canonical lands on existing page
// ─────────────────────────────────────────────────────────────────────────────

describe('plan Rule 2 — entity split-session anchoring', () => {
  it('routes to action=update when resolver canonical matches an existing entity page', async () => {
    handle = setupTestDb();
    const { db } = handle;
    const session_id = 'sess-b';

    // Existing wiki page from a previous session.
    const pageId = seedPage(db, { page_id: 'gpt-4-page', title: 'GPT-4', page_type: 'entity' });

    // New session ingests a source with the variant spelling.
    const sourceId = seedSource(db, {
      onboarding_session_id: session_id,
      compile_status: 'extracted',
      raw_markdown: 'x'.repeat(600),
    });
    // entity_mentions pins "GPT-4" (the canonical the resolver would pick after
    // matching against the existing page title) so threshold gate lets the plan through.
    seedExtraction(db, {
      source_id: sourceId,
      llm_output: { entities: [{ name: 'GPT-4', type: 'PRODUCT' }], concepts: [], relationships: [] },
    });
    seedExtraction(db, {
      source_id: seedSource(db, {
        onboarding_session_id: 'sess-a',
        compile_status: 'active',
        raw_markdown: 'y'.repeat(600),
      }),
      llm_output: { entities: [{ name: 'GPT-4', type: 'PRODUCT' }], concepts: [], relationships: [] },
    });

    // canonical_entities shape: resolver anchored "GPT 4" → canonical "GPT-4" via existing_page_title.
    const canonical_entities: ResolvedGroup[] = [
      {
        canonical: 'GPT-4',
        type: 'PRODUCT',
        aliases: ['GPT 4'],
        source_ids: [sourceId],
        method: 'existing_page_title',
      },
    ];

    const resp = await planPOST(planRequest({ session_id, canonical_entities }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as PlanResponse;
    const entityPlans = data.pages.filter((p) => p.page_type === 'entity');
    expect(entityPlans).toHaveLength(1);
    expect(entityPlans[0].action).toBe('update');
    expect(entityPlans[0].existing_page_id).toBe(pageId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 3 (concept) — new path: plan consumes canonical_concepts
// ─────────────────────────────────────────────────────────────────────────────

describe('plan Rule 3 — canonical_concepts from resolver', () => {
  it('creates a concept page when canonical_concepts has a novel concept above threshold', async () => {
    handle = setupTestDb();
    const { db } = handle;
    const session_id = 'sess-1';

    // Seed 2 sources each mentioning the concept → meets default threshold.
    for (let i = 0; i < 2; i++) {
      const sid = seedSource(db, {
        onboarding_session_id: session_id,
        compile_status: 'extracted',
        raw_markdown: 'x'.repeat(600),
      });
      seedExtraction(db, {
        source_id: sid,
        llm_output: { entities: [], concepts: [{ name: 'Chain of Thought Prompting', description: '' }], relationships: [] },
      });
    }

    const canonical_concepts: ResolvedGroup[] = [
      { canonical: 'Chain of Thought Prompting', type: 'CONCEPT', aliases: [], source_ids: [], method: 'none' },
    ];

    const resp = await planPOST(planRequest({ session_id, canonical_entities: [], canonical_concepts }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as PlanResponse;
    const conceptPlans = data.pages.filter((p) => p.page_type === 'concept');
    expect(conceptPlans).toHaveLength(1);
    expect(conceptPlans[0].title).toBe('Chain of Thought Prompting');
    expect(conceptPlans[0].action).toBe('create');
    expect(conceptPlans[0].existing_page_id).toBeUndefined();
  });

  it('routes to action=update when canonical_concepts matches an existing concept page', async () => {
    handle = setupTestDb();
    const { db } = handle;
    const session_id = 'sess-2';

    // Existing concept page from a prior session.
    const pageId = seedPage(db, {
      page_id: 'transformer-arch-page',
      title: 'Transformer Architecture',
      page_type: 'concept',
    });

    // Two sources mention the concept (resolver would have anchored the new
    // session's "Transformer Networks" to "Transformer Architecture").
    for (let i = 0; i < 2; i++) {
      const sid = seedSource(db, {
        onboarding_session_id: i === 0 ? session_id : 'sess-prior',
        compile_status: i === 0 ? 'extracted' : 'active',
        raw_markdown: 'x'.repeat(600),
      });
      seedExtraction(db, {
        source_id: sid,
        llm_output: { entities: [], concepts: [{ name: 'Transformer Architecture', description: '' }], relationships: [] },
      });
    }

    const canonical_concepts: ResolvedGroup[] = [
      {
        canonical: 'Transformer Architecture',
        type: 'CONCEPT',
        aliases: ['Transformer Networks'],
        source_ids: [],
        method: 'existing_page_title',
      },
    ];

    const resp = await planPOST(planRequest({ session_id, canonical_entities: [], canonical_concepts }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as PlanResponse;
    const conceptPlans = data.pages.filter((p) => p.page_type === 'concept');
    expect(conceptPlans).toHaveLength(1);
    expect(conceptPlans[0].action).toBe('update');
    expect(conceptPlans[0].existing_page_id).toBe(pageId);
  });

  it('tolerates a missing canonical_concepts field (backward compat)', async () => {
    handle = setupTestDb();
    const { db } = handle;
    const session_id = 'sess-3';
    seedSource(db, { onboarding_session_id: session_id, compile_status: 'extracted', raw_markdown: 'x'.repeat(600) });
    seedExtraction(db, {
      source_id: seedSource(db, { onboarding_session_id: session_id, compile_status: 'extracted', raw_markdown: 'y'.repeat(600) }),
      llm_output: { entities: [], concepts: [], relationships: [] },
    });

    // No canonical_concepts in body — plan should still succeed.
    const resp = await planPOST(planRequest({ session_id, canonical_entities: [] }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as PlanResponse;
    expect(data.pages.filter((p) => p.page_type === 'concept')).toHaveLength(0);
  });

  it('skips canonical_concepts below the mention threshold', async () => {
    handle = setupTestDb();
    const { db } = handle;
    const session_id = 'sess-4';

    // Only 1 source → below default threshold of 2.
    const sid = seedSource(db, {
      onboarding_session_id: session_id,
      compile_status: 'extracted',
      raw_markdown: 'x'.repeat(600),
    });
    seedExtraction(db, {
      source_id: sid,
      llm_output: { entities: [], concepts: [{ name: 'Some Concept', description: '' }], relationships: [] },
    });

    const canonical_concepts: ResolvedGroup[] = [
      { canonical: 'Some Concept', type: 'CONCEPT', aliases: [], source_ids: [], method: 'none' },
    ];

    const resp = await planPOST(planRequest({ session_id, canonical_entities: [], canonical_concepts }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as PlanResponse;
    expect(data.pages.filter((p) => p.page_type === 'concept')).toHaveLength(0);
  });

  it('dedupes canonical_concepts by lowercase within the plan', async () => {
    handle = setupTestDb();
    const { db } = handle;
    const session_id = 'sess-5';

    for (let i = 0; i < 2; i++) {
      const sid = seedSource(db, {
        onboarding_session_id: session_id,
        compile_status: 'extracted',
        raw_markdown: 'x'.repeat(600),
      });
      seedExtraction(db, {
        source_id: sid,
        llm_output: { entities: [], concepts: [{ name: 'Tool Use', description: '' }], relationships: [] },
      });
    }

    // Resolver handed us the same canonical twice (should never happen in
    // practice since the resolver dedupes, but the planner must be defensive).
    const canonical_concepts: ResolvedGroup[] = [
      { canonical: 'Tool Use', type: 'CONCEPT', aliases: [], source_ids: [], method: 'none' },
      { canonical: 'tool use', type: 'CONCEPT', aliases: [], source_ids: [], method: 'none' },
    ];

    const resp = await planPOST(planRequest({ session_id, canonical_entities: [], canonical_concepts }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as PlanResponse;
    expect(data.pages.filter((p) => p.page_type === 'concept')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Janitor — approve-plan backfills canonical_page_id for concept pages too
// ─────────────────────────────────────────────────────────────────────────────

function mockNlpFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/storage/write-page')) {
        return new Response(
          JSON.stringify({ current_path: '/data/pages/x.md.gz', previous_path: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (u.includes('/vectors/upsert')) return new Response('{}', { status: 200 });
      throw new Error(`unexpected fetch in test: ${u}`);
    })
  );
}

describe('approve-plan — backfillAliasCanonicalPageId for concept pages', () => {
  it('populates canonical_page_id on aliases rows when a concept draft is committed', async () => {
    handle = setupTestDb();
    const { db } = handle;
    mockNlpFetch();

    const session_id = 'sess-approve-concept';
    seedCompileProgress(db, session_id);

    const sourceId = seedSource(db, {
      onboarding_session_id: session_id,
      compile_status: 'extracted',
      raw_markdown: 'x'.repeat(600),
    });

    // Resolver would have written this alias row during its 3-layer run.
    bulkInsertAliases([{ alias: 'Transformer Networks', canonical: 'Transformer Architecture' }]);

    // Pre-check: row exists, canonical_page_id is NULL.
    const before = getAllAliases().find((a) => a.canonical_name === 'Transformer Architecture');
    expect(before).toBeDefined();
    expect(before?.canonical_page_id).toBeNull();

    const draftMarkdown =
      '---\n' +
      'title: Transformer Architecture\n' +
      'page_type: concept\n' +
      'category: Concepts\n' +
      'summary: Test.\n' +
      '---\n\n' +
      '## Content\nBody here.\n';

    const planId = seedPagePlan(db, {
      session_id,
      title: 'Transformer Architecture',
      page_type: 'concept',
      action: 'create',
      source_ids: [sourceId],
      draft_content: draftMarkdown,
      draft_status: 'pending_approval',
    });

    const result = await commitSinglePlan(planId);
    expect(result.ok).toBe(true);

    // Post-check: canonical_page_id is now populated on the aliases row.
    const after = getAllAliases().find((a) => a.canonical_name === 'Transformer Architecture');
    expect(after).toBeDefined();
    expect(after?.canonical_page_id).not.toBeNull();
    if (result.ok) {
      expect(after?.canonical_page_id).toBe(result.page_id);
    }
  });

  // Silence TS unused-import warnings when commitSinglePlan runs; createHash
  // is imported for future tests that stub content hashes explicitly.
  void createHash;
});
