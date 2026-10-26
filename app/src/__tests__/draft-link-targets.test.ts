/**
 * compile/draft and compile/crossref — source pages are cited, never linked,
 * and drafts are cleaned before they are stored.
 *
 * In the 2026-10-09 e2e wiki 19% of links pointed at source notes
 * ("[[Bitcoin Basics|Bitcoin]]") because every page title, source notes
 * included, was offered as a link target; drafts also stored invented
 * frontmatter and "[S2] states that…" sentences.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as draftPOST } from '../app/api/compile/draft/route';
import { POST as crossrefPOST } from '../app/api/compile/crossref/route';
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

interface DraftBody {
  title: string;
  existing_page_titles: string[];
  related_pages: Array<{ title: string; type: string }>;
}

const DRAFTED = [
  '---',
  'title: Proof-of-work',
  'page_type: concept',
  'category: Cryptocurrency',
  'summary: Proof-of-work secures Bitcoin.',
  'sources:',
  '  - source_id: S1',
  '    title: Bitcoin Basics',
  'last_updated: 2025-06-01',
  'status: stable',
  '---',
  '',
  '[S1] states that Bitcoin uses proof-of-work, which consumes significant energy and secures the network for every participant in the system.',
  '',
  '## Contradictions',
  'None.',
  '',
].join('\n');

function mockDraftFetch(markdown: string): { bodies: DraftBody[] } {
  const bodies: DraftBody[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/pipeline/draft-page')) {
        bodies.push(JSON.parse((init?.body as string) ?? '{}') as DraftBody);
        return new Response(JSON.stringify({ markdown }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return { bodies };
}

function post(handler: (r: Request) => Promise<Response>, path: string, session_id: string): Promise<Response> {
  return handler(
    new Request(`http://test${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id }),
    }),
  );
}

function seedSession(h: TestDbHandle, session_id: string): { sourceId: string; conceptPlan: string } {
  seedCompileProgress(h.db, session_id);
  const sourceId = seedSource(h.db, {
    source_id: `src-${session_id}`,
    title: 'Bitcoin Basics',
    onboarding_session_id: session_id,
    raw_markdown: 'Bitcoin uses proof-of-work consensus. Bitcoin mining consumes significant energy.',
  });
  seedExtraction(h.db, {
    source_id: sourceId,
    llm_output: { entities: [{ name: 'Bitcoin', type: 'PRODUCT' }], concepts: [], relationships: [] },
  });
  seedPage(h.db, { page_id: `eo-${session_id}`, title: 'Ethereum Overview', page_type: 'original-source' });
  seedPage(h.db, { page_id: `sn-${session_id}`, title: 'Satoshi Nakamoto', page_type: 'entity' });
  seedPagePlan(h.db, {
    session_id,
    title: 'Bitcoin Basics',
    page_type: 'original-source',
    action: 'create',
    source_ids: [sourceId],
    draft_status: 'planned',
  });
  const conceptPlan = seedPagePlan(h.db, {
    session_id,
    title: 'Proof-of-work',
    page_type: 'concept',
    action: 'create',
    source_ids: [sourceId],
    draft_status: 'planned',
  });
  return { sourceId, conceptPlan };
}

describe('compile/draft — link targets and stored draft', () => {
  it('offers no source pages as link targets or related pages', async () => {
    handle = setupTestDb();
    seedSession(handle, 'sess-links-1');
    const fetchMock = mockDraftFetch(DRAFTED);

    const res = await post(draftPOST, '/api/compile/draft', 'sess-links-1');
    expect(res.status).toBe(200);

    const body = fetchMock.bodies.find((b) => b.title === 'Proof-of-work');
    expect(body).toBeDefined();
    expect(body!.existing_page_titles).toContain('Satoshi Nakamoto');
    expect(body!.existing_page_titles).not.toContain('Bitcoin Basics');
    expect(body!.existing_page_titles).not.toContain('Ethereum Overview');
    expect(body!.related_pages.map((p) => p.title)).not.toContain('Bitcoin Basics');
  });

  it('stores the draft with four frontmatter keys, reworded labels and no empty contradictions', async () => {
    handle = setupTestDb();
    const { sourceId, conceptPlan } = seedSession(handle, 'sess-links-2');
    mockDraftFetch(DRAFTED);

    await post(draftPOST, '/api/compile/draft', 'sess-links-2');
    const row = handle.db
      .prepare('SELECT draft_content FROM page_plans WHERE plan_id = ?')
      .get(conceptPlan) as { draft_content: string };

    expect(row.draft_content).not.toContain('last_updated');
    expect(row.draft_content).not.toContain('source_id: S1');
    expect(row.draft_content).not.toContain('status: stable');
    expect(row.draft_content).toContain('summary: Proof-of-work secures Bitcoin.');
    expect(row.draft_content).toContain(`One source[^${sourceId}] states that Bitcoin uses proof-of-work`);
    expect(row.draft_content).not.toContain('## Contradictions');
  });
});

describe('compile/crossref — link hygiene', () => {
  it('never links source pages and links each page once', async () => {
    handle = setupTestDb();
    const session_id = 'sess-crossref-1';
    seedCompileProgress(handle.db, session_id);
    const sourceId = seedSource(handle.db, {
      source_id: 'src-crossref-1',
      title: 'Bitcoin Basics',
      onboarding_session_id: session_id,
      raw_markdown: 'Bitcoin uses proof-of-work. Satoshi Nakamoto created it.',
    });
    seedPage(handle.db, { page_id: 'bb-page', title: 'Bitcoin Basics', page_type: 'original-source' });
    seedPage(handle.db, { page_id: 'sn-page', title: 'Satoshi Nakamoto', page_type: 'entity' });
    const plan = seedPagePlan(handle.db, {
      session_id,
      title: 'Proof-of-work',
      page_type: 'concept',
      action: 'create',
      source_ids: [sourceId],
      draft_status: 'drafted',
    });
    const draft = [
      '---',
      'title: Proof-of-work',
      '---',
      '',
      'As [[Bitcoin Basics]] notes, Bitcoin uses it. [[Satoshi Nakamoto]] designed it; Satoshi Nakamoto is pseudonymous.',
      'Later, [[Satoshi Nakamoto]] left.',
      '',
      '## Related Concepts',
      '- [[Bitcoin Basics]]',
      '- [[Satoshi Nakamoto]]',
      '',
    ].join('\n');
    handle.db.prepare('UPDATE page_plans SET draft_content = ? WHERE plan_id = ?').run(draft, plan);

    const res = await post(crossrefPOST, '/api/compile/crossref', session_id);
    expect(res.status).toBe(200);
    const row = handle.db
      .prepare('SELECT draft_content FROM page_plans WHERE plan_id = ?')
      .get(plan) as { draft_content: string };

    expect(row.draft_content).toBe(
      [
        '---',
        'title: Proof-of-work',
        '---',
        '',
        'As Bitcoin Basics notes, Bitcoin uses it. [[Satoshi Nakamoto]] designed it; Satoshi Nakamoto is pseudonymous.',
        'Later, Satoshi Nakamoto left.',
        '',
        '## Related Concepts',
        '- [[Satoshi Nakamoto]]',
        '',
      ].join('\n'),
    );
  });
});
