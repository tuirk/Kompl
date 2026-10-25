/**
 * original-source pages take the category of their most mentioned entity
 * (plan 2.4).
 *
 * The draft route picked the top entity by comparing `mentions` as a
 * number, but extraction stores mentions as a list of text spans
 * (ExtractionEntity.mentions: list[str]). `['Anthropic'] > 0` is false, so
 * no entity ever won and every original-source page became "Uncategorized".
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as draftPOST } from '../app/api/compile/draft/route';
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

async function draftNote(entities: Array<{ name: string; type: string; mentions: string[] }>): Promise<string> {
  handle = setupTestDb();
  const session = `sess-note-${Math.random().toString(36).slice(2, 8)}`;
  seedCompileProgress(handle.db, session);
  const sid = seedSource(handle.db, { onboarding_session_id: session, raw_markdown: 'My notes about the lab.' });
  seedExtraction(handle.db, {
    source_id: sid,
    llm_output: {
      entities: entities.map((e) => ({ ...e, context: 'c' })),
      concepts: [],
      claims: [{ claim: 'The lab ships models.' }],
      relationships: [],
      contradictions: [],
    },
  });
  const planId = seedPagePlan(handle.db, {
    session_id: session,
    title: 'Lab notes',
    page_type: 'original-source',
    action: 'create',
    source_ids: [sid],
    draft_status: 'planned',
  });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not used', { status: 404 })));

  const res = await draftPOST(
    new Request('http://test/api/compile/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session }),
    }),
  );
  expect(res.status).toBe(200);
  const row = handle.db.prepare('SELECT draft_content FROM page_plans WHERE plan_id = ?').get(planId) as {
    draft_content: string;
  };
  return row.draft_content;
}

describe('original-source category', () => {
  it('comes from the entity with the most mentions', async () => {
    const draft = await draftNote([
      { name: 'Claude', type: 'PRODUCT', mentions: ['Claude'] },
      { name: 'Anthropic', type: 'ORG', mentions: ['Anthropic', 'Anthropic PBC', 'the company'] },
    ]);
    expect(draft).toContain('\ncategory: Organizations\n');
  });

  it('a single entity mentioned once still sets it', async () => {
    const draft = await draftNote([{ name: 'Ada Lovelace', type: 'PERSON', mentions: ['Ada Lovelace'] }]);
    expect(draft).toContain('\ncategory: People\n');
  });

  it('stays Uncategorized without entities', async () => {
    const draft = await draftNote([]);
    expect(draft).toContain('\ncategory: Uncategorized\n');
  });
});
