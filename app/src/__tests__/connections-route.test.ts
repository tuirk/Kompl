/**
 * GET /api/wiki/[page_id]/connections — the page's connections for the graph
 * panels: the same JSON as the data route's `connections` field, plain names
 * kept, archived sources flagged, 404 for an unknown page.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '../app/api/wiki/[page_id]/connections/route';
import { GET as getData } from '../app/api/wiki/[page_id]/data/route';
import { insertPageLink, setSourceStatus } from '../lib/db';
import { seedPage, seedProvenance, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

async function connections(pageId: string) {
  const res = await GET(new Request(`http://test/api/wiki/${pageId}/connections`), {
    params: Promise.resolve({ page_id: pageId }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function fixture(): void {
  handle = setupTestDb();
  const db = handle.db;
  seedSource(db, { source_id: 'src-1', title: 'Whitepaper' });
  seedSource(db, { source_id: 'src-2', title: 'Old blog post' });
  seedPage(db, { page_id: 'bitcoin', title: 'Bitcoin' });
  seedPage(db, { page_id: 'pow', title: 'Proof of work' });
  seedPage(db, { page_id: 'vilnius', title: 'Vilnius' });
  seedProvenance(db, 'bitcoin', 'src-1');
  seedProvenance(db, 'bitcoin', 'src-2');
  const rel = db.prepare(
    `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id, description, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  rel.run('Bitcoin', 'Proof of work', 'uses', 'src-1', 'Bitcoin uses proof of work.', '2026-01-01 00:00:00');
  rel.run('Bitcoin', 'Proof of work', 'uses', 'src-2', 'Mining is proof of work.', '2026-01-02 00:00:00');
  rel.run('Bitcoin', 'Satoshi Nakamoto', 'created_by', 'src-1', null, '2026-01-01 00:00:00');
  insertPageLink('vilnius', 'bitcoin', 'wikilink');
  setSourceStatus('src-2', 'archived');
}

describe('GET /api/wiki/[page_id]/connections', () => {
  it('returns the groups and the plain links, flagging archived sources', async () => {
    fixture();
    const { status, body } = await connections('bitcoin');
    expect(status).toBe(200);
    expect(body).toEqual({
      groups: [
        {
          label: 'Created by',
          items: [
            {
              page_id: null,
              title: 'Satoshi Nakamoto',
              type: 'created_by',
              direction: 'out',
              source_count: 1,
              evidence: [{ source_id: 'src-1', source_title: 'Whitepaper', source_archived: false, sentence: null }],
            },
          ],
        },
        {
          label: 'Uses',
          items: [
            {
              page_id: 'pow',
              title: 'Proof of work',
              type: 'uses',
              direction: 'out',
              source_count: 2,
              evidence: [
                { source_id: 'src-2', source_title: 'Old blog post', source_archived: true, sentence: 'Mining is proof of work.' },
                { source_id: 'src-1', source_title: 'Whitepaper', source_archived: false, sentence: 'Bitcoin uses proof of work.' },
              ],
            },
          ],
        },
      ],
      linked_only: [{ page_id: 'vilnius', title: 'Vilnius' }],
    });
  });

  it('matches the data route field for field', async () => {
    fixture();
    const res = await getData(new Request('http://test/api/wiki/bitcoin/data'), {
      params: Promise.resolve({ page_id: 'bitcoin' }),
    });
    const data = (await res.json()) as { connections: unknown };
    expect((await connections('bitcoin')).body).toEqual(data.connections);
  });

  it('returns empty lists for a page with no connections', async () => {
    fixture();
    seedPage(handle!.db, { page_id: 'alone', title: 'Alone' });
    expect(await connections('alone')).toEqual({ status: 200, body: { groups: [], linked_only: [] } });
  });

  it('answers 404 for an unknown page', async () => {
    fixture();
    expect(await connections('missing')).toEqual({ status: 404, body: { error: 'Page not found' } });
  });
});
