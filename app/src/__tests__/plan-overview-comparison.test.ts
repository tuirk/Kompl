/**
 * Plan Rules 4 and 5 (plan 2.4, flow audit note 22).
 *
 *   - Rule 5 makes overview pages only for entity types with a category:
 *     WORK_OF_ART, OTHER and other unmapped types made a "General
 *     Overview" catch-all.
 *   - Rules 4 and 5 find an existing comparison or overview page the way
 *     Rules 2 and 3 find theirs (getTopicPageByTitle): a source page with
 *     the same title is not that page, so it is never rewritten as one.
 *   - Approving a new comparison or overview draft checks for a duplicate
 *     the same way.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as planPOST } from '../app/api/compile/plan/route';
import { commitSinglePlan } from '../lib/approve-plan';
import {
  setupTestDb,
  seedSource,
  seedExtraction,
  seedPage,
  seedPagePlan,
  type TestDbHandle,
} from './helpers/test-db';
import { post } from './helpers/compile-run-harness';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

interface Group {
  canonical: string;
  type: string;
  aliases: string[];
  source_ids: string[];
  method: string;
}

interface PlanResp {
  pages: Array<{ title: string; page_type: string; action: string; existing_page_id?: string }>;
}

/** Two session sources that both mention every entity, so each is promoted (threshold 2). */
function seedEntities(session_id: string, entities: Array<{ name: string; type: string }>): Group[] {
  const { db } = handle!;
  const source_ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const source_id = seedSource(db, {
      onboarding_session_id: session_id,
      compile_status: 'extracted',
      raw_markdown: 'x'.repeat(600),
    });
    seedExtraction(db, { source_id, llm_output: { entities, concepts: [], relationships: [] } });
    source_ids.push(source_id);
  }
  return entities.map((e) => ({ canonical: e.name, type: e.type, aliases: [], source_ids, method: 'none' }));
}

async function plan(session_id: string, canonical_entities: Group[]): Promise<PlanResp> {
  const res = await planPOST(post({ session_id, canonical_entities }));
  expect(res.status).toBe(200);
  return (await res.json()) as PlanResp;
}

const overviews = (r: PlanResp) => r.pages.filter((p) => p.page_type === 'overview');

describe('Rule 5: overview categories', () => {
  it('makes no overview for unmapped entity types', async () => {
    handle = setupTestDb();
    const groups = seedEntities('sess-works', [
      { name: 'Hamlet', type: 'WORK_OF_ART' },
      { name: 'Macbeth', type: 'WORK_OF_ART' },
      { name: 'Othello', type: 'WORK_OF_ART' },
      { name: 'Ada Lovelace', type: 'PERSON' },
      { name: 'Alan Turing', type: 'PERSON' },
      { name: 'Grace Hopper', type: 'PERSON' },
    ]);

    const r = await plan('sess-works', groups);

    expect(r.pages.filter((p) => p.page_type === 'entity')).toHaveLength(6);
    expect(overviews(r).map((p) => p.title)).toEqual(['People Overview']);
  });

  it('a source page titled like the overview is not updated as it', async () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'people-article', title: 'People Overview', page_type: 'source-summary' });
    const groups = seedEntities('sess-src-title', [
      { name: 'Ada Lovelace', type: 'PERSON' },
      { name: 'Alan Turing', type: 'PERSON' },
      { name: 'Grace Hopper', type: 'PERSON' },
    ]);

    const [overview] = overviews(await plan('sess-src-title', groups));
    expect(overview).toMatchObject({ title: 'People Overview', action: 'create' });
    expect(overview.existing_page_id).toBeUndefined();
  });

  it('an existing overview page is updated', async () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'people-overview', title: 'People Overview', page_type: 'overview' });
    const groups = seedEntities('sess-overview', [
      { name: 'Ada Lovelace', type: 'PERSON' },
      { name: 'Alan Turing', type: 'PERSON' },
      { name: 'Grace Hopper', type: 'PERSON' },
    ]);

    const [overview] = overviews(await plan('sess-overview', groups));
    expect(overview).toMatchObject({ action: 'update', existing_page_id: 'people-overview' });
  });
});

describe('Rule 4: the existing comparison page', () => {
  /** Three sources saying Claude competes with GPT-4, the comparison threshold. */
  function seedRivalry(session_id: string): Group[] {
    const { db } = handle!;
    const source_ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const source_id = seedSource(db, {
        onboarding_session_id: session_id,
        compile_status: 'extracted',
        raw_markdown: 'x'.repeat(600),
      });
      seedExtraction(db, {
        source_id,
        llm_output: {
          entities: [
            { name: 'GPT-4', type: 'PRODUCT' },
            { name: 'Claude', type: 'PRODUCT' },
          ],
          concepts: [],
          relationships: [{ from_entity: 'Claude', to: 'GPT-4', type: 'competes_with', description: '' }],
        },
      });
      source_ids.push(source_id);
    }
    return ['GPT-4', 'Claude'].map((canonical) => ({ canonical, type: 'PRODUCT', aliases: [], source_ids, method: 'none' }));
  }

  it('a source page with the same title is not updated as the comparison', async () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'versus-article', title: 'Claude vs GPT-4', page_type: 'source-summary' });

    const r = await plan('sess-versus-src', seedRivalry('sess-versus-src'));
    const [comparison] = r.pages.filter((p) => p.page_type === 'comparison');
    expect(comparison).toMatchObject({ title: 'Claude vs GPT-4', action: 'create' });
    expect(comparison.existing_page_id).toBeUndefined();
  });

  it('an existing comparison page is updated', async () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'claude-vs-gpt4', title: 'Claude vs GPT-4', page_type: 'comparison' });

    const r = await plan('sess-versus', seedRivalry('sess-versus'));
    const [comparison] = r.pages.filter((p) => p.page_type === 'comparison');
    expect(comparison).toMatchObject({ action: 'update', existing_page_id: 'claude-vs-gpt4' });
  });
});

describe('approving a new comparison or overview draft', () => {
  const DRAFT = `---\ntitle: "Claude vs GPT-4"\n---\n${'Comparison text. '.repeat(60)}`;

  function mockNlp(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = url.toString();
        if (u.includes('/storage/write-page')) return Response.json({ current_path: '/data/pages/x.md.gz', previous_path: null });
        if (u.includes('/vectors/upsert')) return new Response('{}', { status: 200 });
        throw new Error(`unexpected fetch in test: ${u}`);
      }),
    );
  }

  function pendingCreate(title: string, page_type: string): string {
    return seedPagePlan(handle!.db, {
      session_id: 'sess-pending',
      title,
      page_type,
      action: 'create',
      source_ids: [seedSource(handle!.db, { compile_status: 'active' })],
      draft_status: 'pending_approval',
      draft_content: DRAFT,
    });
  }

  it('a source page with the same title does not block it', async () => {
    handle = setupTestDb();
    mockNlp();
    seedPage(handle.db, { page_id: 'versus-article', title: 'Claude vs GPT-4', page_type: 'source-summary' });

    expect(await commitSinglePlan(pendingCreate('Claude vs GPT-4', 'comparison'))).toMatchObject({ ok: true });
  });

  it('an existing overview page with the title refuses it as a duplicate', async () => {
    handle = setupTestDb();
    mockNlp();
    seedPage(handle.db, { page_id: 'people-overview', title: 'People Overview', page_type: 'overview' });

    expect(await commitSinglePlan(pendingCreate('People Overview', 'overview'))).toMatchObject({
      ok: false,
      error: 'page_exists',
    });
  });
});
