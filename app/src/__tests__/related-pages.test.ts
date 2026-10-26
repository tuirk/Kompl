/**
 * GET /api/wiki/[page_id]/related — the "You might also read" panel.
 *
 * Pins what the Settings text promises: the source minimum (0 removes it),
 * archived sources not counting, no LLM call (only /vectors/search), and that
 * only real matches are listed: never the page itself, Saved Links, archived
 * pages, or anything below the similarity floor. A failing NLP service is
 * logged and hides the panel instead of holding the page.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/api/wiki/[page_id]/related/route';
import { setRelatedPagesMinSources, setSourceStatus } from '../lib/db';
import { seedPage, seedProvenance, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  handle?.cleanup();
  handle = null;
});

type Match = { page_id: string; similarity: number };

function mockSearch(result: { matches?: Match[]; status?: number; error?: Error }) {
  const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    if (!String(url).endsWith('/vectors/search')) return new Response('unexpected call', { status: 599 });
    if (result.error) throw result.error;
    if (result.status !== undefined && result.status !== 200) return new Response('down', { status: result.status });
    return Response.json({ matches: result.matches ?? [] });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function related(pageId: string) {
  const res = await GET(new Request(`http://test/api/wiki/${pageId}/related`), {
    params: Promise.resolve({ page_id: pageId }),
  });
  return {
    status: res.status,
    body: (await res.json()) as { items: Array<{ page_id: string }>; count: number; enabled: boolean },
  };
}

/** `sources` active sources, plus pages whose fate the tests below check. */
function seedWiki(sources: number) {
  handle = setupTestDb();
  const db = handle.db;
  const active = Array.from({ length: sources }, (_, i) => seedSource(db, { title: `Source ${i}` }));
  for (const id of ['subject', 'close', 'closer', 'weak', 'retired']) {
    seedPage(db, { page_id: id, title: id.toUpperCase(), page_type: id === 'retired' ? 'archived' : 'concept' });
    seedProvenance(db, id, active[0]);
  }
  seedPage(db, { page_id: 'saved-links', title: 'Saved Links', page_type: 'overview' });
  // 'hidden' only has a source that gets archived, so the wiki hides it.
  const lone = seedSource(db, { title: 'Lone source' });
  seedPage(db, { page_id: 'hidden', title: 'HIDDEN', page_type: 'concept' });
  seedProvenance(db, 'hidden', lone);
  setSourceStatus(lone, 'archived');
}

describe('related pages', () => {
  it('lists only real matches: no self, Saved Links, archived pages or weak matches', async () => {
    seedWiki(10);
    const fetchMock = mockSearch({
      matches: [
        { page_id: 'subject', similarity: 1 },
        { page_id: 'saved-links', similarity: 0.9 },
        { page_id: 'closer', similarity: 0.7 },
        { page_id: 'retired', similarity: 0.65 },
        { page_id: 'hidden', similarity: 0.6 },
        { page_id: 'close', similarity: 0.5 },
        { page_id: 'weak', similarity: 0.2 },
      ],
    });

    const { status, body } = await related('subject');

    expect(status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.items.map((i) => i.page_id)).toEqual(['closer', 'close']);
    expect(body.count).toBe(2);
    // One embedding search, no LLM call; extra candidates make up for the filters.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toMatchObject({ n_results: 12 });
  });

  it('stays hidden below the source minimum, which archived sources do not count towards; 0 removes it', async () => {
    seedWiki(9); // 9 active sources; the archived one does not count
    const fetchMock = mockSearch({ matches: [{ page_id: 'close', similarity: 0.5 }] });

    expect((await related('subject')).body).toEqual({ items: [], count: 0, enabled: false });
    expect(fetchMock).not.toHaveBeenCalled();

    setRelatedPagesMinSources(0);
    const { body } = await related('subject');
    expect(body.enabled).toBe(true);
    expect(body.items.map((i) => i.page_id)).toEqual(['close']);
  });

  it('logs a failing search and returns nothing to show', async () => {
    seedWiki(10);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockSearch({ status: 500 });
    expect((await related('subject')).body).toEqual({ items: [], count: 0, enabled: true });

    mockSearch({ error: new Error('The operation was aborted due to timeout') });
    expect((await related('subject')).body).toEqual({ items: [], count: 0, enabled: true });

    const events = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as { event: string; page_id: string });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.event === 'related_pages_search_failed' && e.page_id === 'subject')).toBe(true);
  });

  it('answers 404 for an unknown page', async () => {
    seedWiki(10);
    mockSearch({});
    expect((await related('missing')).status).toBe(404);
  });
});
