/**
 * compile/draft under the prompt budget (plan 2.1, audit B4).
 *
 * The nlp-service fits the source documents to the prompt budget and
 * reports what it used and cut. The draft route marks this session's
 * sources (is_new) and sends them first, stores used_source_ids on the plan
 * for the commit, reports the cuts in its response and the step detail, and
 * drafts an overview from the pages it lists instead of every source.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as draftPOST } from '../app/api/compile/draft/route';
import { describePromptCuts, orderDraftSources } from '../lib/compile/draft-sources';
import {
  setupTestDb,
  seedSource,
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

interface DraftBody {
  page_type: string;
  source_contents: Array<{ source_id: string; title: string; is_new?: boolean; citation_label?: string }>;
  related_pages: Array<{ title: string; type: string; summary: string }>;
}

function mockDraft(reply: Record<string, unknown>): { bodies: DraftBody[] } {
  const bodies: DraftBody[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/pipeline/draft-page')) {
        bodies.push(JSON.parse((init?.body as string) ?? '{}') as DraftBody);
        return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return { bodies };
}

async function draft(session_id: string): Promise<Response> {
  return draftPOST(
    new Request('http://test/api/compile/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id }),
    }),
  );
}

const STUB_MD = '---\ntitle: "Bitcoin"\nsummary: "s"\n---\n\nbody';

/** An update of "Bitcoin" whose plan lists two older sources before this session's. */
function seedUpdate(session_id: string): { plan_id: string } {
  const db = handle!.db;
  seedCompileProgress(db, session_id);
  const page_id = seedPage(db, { page_id: 'page-bitcoin', title: 'Bitcoin', page_type: 'entity' });
  db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run(
    '---\ntitle: "Bitcoin"\n---\n\nBitcoin is a cryptocurrency.',
    page_id,
  );
  seedSource(db, { source_id: 'old-b', title: 'Old B', raw_markdown: 'Older Bitcoin text B.' });
  seedSource(db, { source_id: 'old-a', title: 'Old A', raw_markdown: 'Older Bitcoin text A.' });
  db.prepare("UPDATE sources SET date_ingested = '2026-01-01 00:00:00' WHERE source_id = 'old-b'").run();
  db.prepare("UPDATE sources SET date_ingested = '2026-06-01 00:00:00' WHERE source_id = 'old-a'").run();
  seedSource(db, {
    source_id: 'zz-new',
    title: 'New article',
    onboarding_session_id: session_id,
    raw_markdown: 'Fresh Bitcoin news.',
  });
  const plan_id = seedPagePlan(db, {
    session_id,
    title: 'Bitcoin',
    page_type: 'entity',
    action: 'update',
    source_ids: ['old-b', 'old-a', 'zz-new'],
    existing_page_id: page_id,
    draft_status: 'planned',
  });
  return { plan_id };
}

describe('compile/draft — source order and used sources', () => {
  it("sends this session's source first, marked new, then older sources newest first", async () => {
    handle = setupTestDb();
    seedUpdate('sess-order');
    const fetchMock = mockDraft({ markdown: STUB_MD, used_source_ids: ['zz-new', 'old-a', 'old-b'], cut_sources: [] });

    expect((await draft('sess-order')).status).toBe(200);

    const sent = fetchMock.bodies[0].source_contents;
    expect(sent.map((s) => [s.source_id, s.is_new])).toEqual([
      ['zz-new', true],
      ['old-a', false],
      ['old-b', false],
    ]);
  });

  it('stores used_source_ids and reports the cuts in the response and the step detail', async () => {
    handle = setupTestDb();
    const { plan_id } = seedUpdate('sess-cuts');
    // seedCompileProgress stores steps as '[]'; the route writes keyed steps.
    handle.db.prepare("UPDATE compile_progress SET steps = '{}' WHERE session_id = 'sess-cuts'").run();
    mockDraft({
      markdown: STUB_MD,
      used_source_ids: ['zz-new', 'old-a'],
      cut_sources: [{ source_id: 'old-b', sent_chars: 0, cut_chars: 5000 }],
    });

    const res = await draft('sess-cuts');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prompt_cuts: unknown };
    expect(body.prompt_cuts).toEqual([
      {
        plan_id,
        title: 'Bitcoin',
        sources: [{ source_id: 'old-b', source_title: 'Old B', sent_chars: 0, cut_chars: 5000 }],
      },
    ]);

    const plan = handle.db.prepare('SELECT used_source_ids FROM page_plans WHERE plan_id = ?').get(plan_id) as {
      used_source_ids: string | null;
    };
    expect(JSON.parse(plan.used_source_ids!)).toEqual(['zz-new', 'old-a']);

    const progress = handle.db.prepare('SELECT steps FROM compile_progress WHERE session_id = ?').get('sess-cuts') as {
      steps: string;
    };
    const detail = (JSON.parse(progress.steps) as Record<string, { detail?: string }>).draft.detail;
    expect(detail).toBe('1/1 pages drafted; prompt budget: 1 source left out on "Bitcoin" (5,000 chars): "Old B"');
  });

  it('an nlp-service reply without used_source_ids credits every plan source', async () => {
    handle = setupTestDb();
    const { plan_id } = seedUpdate('sess-legacy-reply');
    mockDraft({ markdown: STUB_MD });

    expect((await draft('sess-legacy-reply')).status).toBe(200);
    const plan = handle.db.prepare('SELECT used_source_ids FROM page_plans WHERE plan_id = ?').get(plan_id) as {
      used_source_ids: string | null;
    };
    expect(plan.used_source_ids).toBeNull();
  });
});

describe('compile/draft — overview pages draft from the pages they list', () => {
  function seedOverview(session_id: string, related: Array<{ title: string; status: string; summary?: string }>) {
    const db = handle!.db;
    seedCompileProgress(db, session_id);
    const s1 = seedSource(db, { source_id: 'ov-s1', onboarding_session_id: session_id, raw_markdown: 'One.' });
    const s2 = seedSource(db, { source_id: 'ov-s2', onboarding_session_id: session_id, raw_markdown: 'Two.' });
    const relatedIds = related.map((r) =>
      seedPagePlan(db, {
        session_id,
        title: r.title,
        page_type: 'entity',
        source_ids: [s1],
        draft_status: r.status,
        draft_content: r.summary === undefined ? null : `---\ntitle: "${r.title}"\nsummary: "${r.summary}"\n---\n\nbody`,
      }),
    );
    const plan_id = seedPagePlan(db, {
      session_id,
      title: 'People Overview',
      page_type: 'overview',
      source_ids: [s1, s2],
      related_plan_ids: relatedIds,
      draft_status: 'planned',
    });
    return { plan_id };
  }

  it('sends no source documents and lists the related pages, committed ones included', async () => {
    handle = setupTestDb();
    const { plan_id } = seedOverview('sess-ov', [
      { title: 'Ada Lovelace', status: 'committed', summary: 'Wrote the first program.' },
      { title: 'Alan Turing', status: 'crossreffed', summary: 'Defined computability.' },
      { title: 'Grace Hopper', status: 'draft_too_thin', summary: 'Too thin to commit.' },
    ]);
    const fetchMock = mockDraft({ markdown: STUB_MD, used_source_ids: [], cut_sources: [] });

    expect((await draft('sess-ov')).status).toBe(200);

    const body = fetchMock.bodies[0];
    expect(body.page_type).toBe('overview');
    expect(body.source_contents).toEqual([]);
    expect(body.related_pages).toEqual([
      { title: 'Ada Lovelace', type: 'entity', summary: 'Wrote the first program.' },
      { title: 'Alan Turing', type: 'entity', summary: 'Defined computability.' },
    ]);
    // Credited with the sources behind its pages (every plan source), so
    // the overview keeps its link to them.
    const plan = handle.db.prepare('SELECT draft_status, used_source_ids FROM page_plans WHERE plan_id = ?').get(plan_id) as {
      draft_status: string;
      used_source_ids: string | null;
    };
    expect(plan).toEqual({ draft_status: 'drafted', used_source_ids: null });
  });

  it('fails an overview with no page to list', async () => {
    handle = setupTestDb();
    const { plan_id } = seedOverview('sess-ov-empty', [{ title: 'Grace Hopper', status: 'draft_too_thin', summary: 'Too thin to commit.' }]);
    const fetchMock = mockDraft({ markdown: STUB_MD, used_source_ids: [], cut_sources: [] });

    expect((await draft('sess-ov-empty')).status).toBe(200);
    expect(fetchMock.bodies).toHaveLength(0);
    const plan = handle.db.prepare('SELECT draft_status, draft_error FROM page_plans WHERE plan_id = ?').get(plan_id) as {
      draft_status: string;
      draft_error: string;
    };
    expect(plan.draft_status).toBe('failed');
    expect(plan.draft_error).toContain('no_pages_to_list');
  });
});

describe('orderDraftSources', () => {
  it('puts new sources first in plan order, then older ones newest first, ties in plan order', () => {
    const order = orderDraftSources([
      { id: 'o1', is_new: false, date_ingested: '2026-01-01' },
      { id: 'n1', is_new: true, date_ingested: null },
      { id: 'o2', is_new: false, date_ingested: '2026-03-01' },
      { id: 'o3', is_new: false, date_ingested: '2026-01-01' },
      { id: 'n2', is_new: true, date_ingested: null },
    ]);
    expect(order.map((s) => s.id)).toEqual(['n1', 'n2', 'o2', 'o1', 'o3']);
  });
});

describe('describePromptCuts', () => {
  const cut = (source_title: string, sent_chars: number, cut_chars: number) => ({
    source_id: source_title.toLowerCase(),
    source_title,
    sent_chars,
    cut_chars,
  });

  it('is empty when nothing was cut', () => {
    expect(describePromptCuts([])).toBe('');
  });

  it('names a shortened source', () => {
    expect(describePromptCuts([{ plan_id: 'p', title: 'Bitcoin', sources: [cut('Paper', 40_000, 12_345)] }])).toBe(
      'prompt budget: 1 source shortened on "Bitcoin" (12,345 chars): "Paper"',
    );
  });

  it('sums several pages and shows three titles', () => {
    expect(
      describePromptCuts([
        { plan_id: 'p1', title: 'Bitcoin', sources: [cut('A', 0, 1000), cut('B', 0, 2000), cut('C', 500, 3000)] },
        { plan_id: 'p2', title: 'Ethereum', sources: [cut('D', 0, 4000), cut('A', 0, 1000)] },
      ]),
    ).toBe('prompt budget: 4 sources left out, 1 shortened on 2 pages (11,000 chars): "A", "B", "C" +1 more');
  });
});
