/**
 * compile/draft — existing-content load for 'update' action plans.
 *
 * Before this fix the route passed `plan.draft_content` as the nlp-service's
 * `existing_content` field. That field is only populated via updatePlanDraft
 * AFTER the LLM returns, so on the first draft pass it's always NULL and the
 * Gemini prompt block "Existing page content (update this, don't rewrite
 * from scratch):" was silently skipped — every update was effectively a
 * rewrite. Fix: read the existing page markdown via readPageMarkdown at
 * draft time.
 *
 * These tests mock fetch (nlp-service is out of process in production), POST
 * to the draft handler, and assert the request body's `existing_content`
 * field matches what we'd expect for each plan shape.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as draftPOST } from '../app/api/compile/draft/route';
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

interface FetchBody {
  page_type: string;
  title: string;
  existing_content: string | null;
  source_contents: Array<{ source_id: string; title: string; markdown: string }>;
}

function mockDraftFetch(): { getLastBody: () => FetchBody | null; getCallCount: () => number } {
  let lastBody: FetchBody | null = null;
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : String(url);
      // Draft-page is the call we care about. schema read-file is a separate
      // fetch that returns 404 in tests (no schema.md) — let it fall through.
      if (urlStr.endsWith('/pipeline/draft-page')) {
        calls++;
        lastBody = JSON.parse((init?.body as string) ?? '{}') as FetchBody;
        return new Response(
          JSON.stringify({ markdown: '---\ntitle: "stub"\n---\n\nstub body' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      // /storage/read-file — pretend schema.md doesn't exist.
      return new Response('not found', { status: 404 });
    })
  );
  return { getLastBody: () => lastBody, getCallCount: () => calls };
}

function draftRequest(session_id: string): Request {
  return new Request('http://test/api/compile/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id }),
  });
}

describe('compile/draft — existing_content wiring', () => {
  it("loads existing page markdown for action='update' plans with a resolved page", async () => {
    handle = setupTestDb();
    const session_id = 'sess-update-1';
    seedCompileProgress(handle.db, session_id);

    const source_id = seedSource(handle.db, {
      source_id: 'src-update-1',
      onboarding_session_id: session_id,
      raw_markdown: 'New article with fresh facts about Claude.',
    });
    seedExtraction(handle.db, {
      source_id,
      llm_output: { entities: [{ name: 'Claude', type: 'PRODUCT' }], concepts: [], relationships: [] },
    });

    // Seed existing page with pending_content (readPageMarkdown falls back to
    // pending_content when the gzipped file doesn't exist — our test env has
    // no disk-side content for these seeded pages).
    const page_id = seedPage(handle.db, {
      page_id: 'page-claude',
      title: 'Claude',
      page_type: 'entity',
    });
    const EXISTING_MARKDOWN = '---\ntitle: "Claude"\n---\n\nClaude is an AI model. Priced at $3 per million tokens.';
    handle.db
      .prepare(`UPDATE pages SET pending_content = ? WHERE page_id = ?`)
      .run(EXISTING_MARKDOWN, page_id);

    seedPagePlan(handle.db, {
      session_id,
      title: 'Claude',
      page_type: 'entity',
      action: 'update',
      source_ids: [source_id],
      existing_page_id: page_id,
      draft_status: 'planned',
    });

    const fetchMock = mockDraftFetch();

    const res = await draftPOST(draftRequest(session_id));
    expect(res.status).toBe(200);

    expect(fetchMock.getCallCount()).toBe(1);
    const body = fetchMock.getLastBody();
    expect(body).not.toBeNull();
    expect(body?.existing_content).toBe(EXISTING_MARKDOWN);
  });

  it("sends existing_content=null for action='create' plans", async () => {
    handle = setupTestDb();
    const session_id = 'sess-create-1';
    seedCompileProgress(handle.db, session_id);

    const source_id = seedSource(handle.db, {
      source_id: 'src-create-1',
      onboarding_session_id: session_id,
      raw_markdown: 'New article about a novel topic.',
    });
    seedExtraction(handle.db, {
      source_id,
      llm_output: { entities: [{ name: 'Novel', type: 'CONCEPT' }], concepts: [], relationships: [] },
    });

    seedPagePlan(handle.db, {
      session_id,
      title: 'Novel',
      page_type: 'entity',
      action: 'create',
      source_ids: [source_id],
      existing_page_id: null,
      draft_status: 'planned',
    });

    const fetchMock = mockDraftFetch();

    const res = await draftPOST(draftRequest(session_id));
    expect(res.status).toBe(200);

    expect(fetchMock.getCallCount()).toBe(1);
    const body = fetchMock.getLastBody();
    expect(body?.existing_content).toBeNull();
  });

  it("falls back to null when action='update' but page markdown is missing from disk AND pending_content", async () => {
    handle = setupTestDb();
    const session_id = 'sess-update-missing';
    seedCompileProgress(handle.db, session_id);

    const source_id = seedSource(handle.db, {
      source_id: 'src-update-missing',
      onboarding_session_id: session_id,
      raw_markdown: 'Source for an orphan update.',
    });
    seedExtraction(handle.db, {
      source_id,
      llm_output: { entities: [{ name: 'Orphan', type: 'CONCEPT' }], concepts: [], relationships: [] },
    });

    // Seed page with NO pending_content and no gzipped file on disk.
    const page_id = seedPage(handle.db, {
      page_id: 'page-orphan',
      title: 'Orphan',
      page_type: 'entity',
    });

    seedPagePlan(handle.db, {
      session_id,
      title: 'Orphan',
      page_type: 'entity',
      action: 'update',
      source_ids: [source_id],
      existing_page_id: page_id,
      draft_status: 'planned',
    });

    const fetchMock = mockDraftFetch();

    const res = await draftPOST(draftRequest(session_id));
    expect(res.status).toBe(200);

    // Draft still runs (no crash on the missing markdown), existing_content null.
    expect(fetchMock.getCallCount()).toBe(1);
    const body = fetchMock.getLastBody();
    expect(body?.existing_content).toBeNull();
  });
});
