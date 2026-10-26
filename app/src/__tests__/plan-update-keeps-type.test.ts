/**
 * An update plan keeps the existing page's own type unless most sources say
 * otherwise (D6: the other kind needs two thirds of the sources and at least
 * three; plan-page-kind.test.ts covers the flip).
 *
 * Commit writes plan.page_type onto the page, and sources disagree on kind.
 * 2026-10-17, session e55c740b: "APCA" (entity page) was re-drafted by a
 * Rule 3 concept plan and became a concept; "WCAG 2.1" (concept page) was
 * re-drafted by a Rule 6 triage update and became an entity.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { POST as planPOST } from '../app/api/compile/plan/route';
import {
  setupTestDb,
  seedSource,
  seedExtraction,
  seedPage,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

interface PlanResponse {
  pages: Array<{ title: string; page_type: string; action: string; existing_page_id?: string }>;
}

function planRequest(body: Record<string, unknown>): Request {
  return new Request('http://test/api/compile/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('plan — updates keep the page type', () => {
  it('a concept canonical updating an entity page stays entity (Rule 3)', async () => {
    handle = setupTestDb();
    const { db } = handle;
    const session_id = 'sess-apca';
    const pageId = seedPage(db, { page_id: 'apca-page', title: 'APCA', page_type: 'entity' });

    // Two sources mention APCA as a concept → meets the promotion threshold.
    for (const sess of [session_id, 'sess-old']) {
      seedExtraction(db, {
        source_id: seedSource(db, {
          onboarding_session_id: sess,
          compile_status: sess === session_id ? 'extracted' : 'active',
          raw_markdown: 'x'.repeat(600),
        }),
        llm_output: {
          entities: [],
          concepts: [{ name: 'APCA', description: 'contrast algorithm' }],
          relationships: [],
        },
      });
    }

    const canonical_concepts = [
      { canonical: 'APCA', type: 'CONCEPT', aliases: [], source_ids: [], method: 'existing_page_title' },
    ];
    const resp = await planPOST(planRequest({ session_id, canonical_entities: [], canonical_concepts }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as PlanResponse;
    const plan = data.pages.find((p) => p.existing_page_id === pageId);
    expect(plan?.action).toBe('update');
    expect(plan?.page_type).toBe('entity');
  });

  it('an entity canonical updating a concept page stays concept (Rule 2)', async () => {
    handle = setupTestDb();
    const { db } = handle;
    const session_id = 'sess-wcag2';
    const pageId = seedPage(db, { page_id: 'wcag-2-page', title: 'WCAG 2', page_type: 'concept' });
    for (const sess of [session_id, 'sess-old']) {
      seedExtraction(db, {
        source_id: seedSource(db, {
          onboarding_session_id: sess,
          compile_status: sess === session_id ? 'extracted' : 'active',
          raw_markdown: 'x'.repeat(600),
        }),
        llm_output: { entities: [{ name: 'WCAG 2', type: 'PRODUCT' }], concepts: [], relationships: [] },
      });
    }

    const canonical_entities = [
      { canonical: 'WCAG 2', type: 'PRODUCT', aliases: [], source_ids: [], method: 'existing_page_title' },
    ];
    const resp = await planPOST(planRequest({ session_id, canonical_entities }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as PlanResponse;
    const plan = data.pages.find((p) => p.existing_page_id === pageId);
    expect(plan?.action).toBe('update');
    expect(plan?.page_type).toBe('concept');
  });

  it('a triage update of a concept page stays concept (Rule 6)', async () => {
    handle = setupTestDb();
    const { db } = handle;
    const session_id = 'sess-wcag';
    const pageId = seedPage(db, { page_id: 'wcag-21-page', title: 'WCAG 2.1', page_type: 'concept' });
    const sourceId = seedSource(db, {
      onboarding_session_id: session_id,
      compile_status: 'extracted',
      raw_markdown: 'x'.repeat(600),
    });
    seedExtraction(db, {
      source_id: sourceId,
      llm_output: { entities: [], concepts: [], relationships: [] },
    });

    const matches = [
      { source_id: sourceId, page_id: pageId, page_title: 'WCAG 2.1', decision: 'update', reason: 'adds 1.4.11' },
    ];
    const resp = await planPOST(planRequest({ session_id, canonical_entities: [], matches }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as PlanResponse;
    const plan = data.pages.find((p) => p.existing_page_id === pageId && p.action === 'update');
    expect(plan?.page_type).toBe('concept');
  });
});
