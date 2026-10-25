/**
 * GET /api/wiki/[page_id]/connections/evidence — every source behind one
 * connection of a page, for the graph panels' "+N more sources" (the
 * connections route keeps three per connection). Names the other end by
 * page id or, for a name with no page, by name; 400 without a type and
 * exactly one end, 404 for an unknown page.
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { EvidenceList } from '../app/wiki/graph/panel-parts';
import { evidenceUrl } from '../app/wiki/graph/useMoreEvidence';
import { GET } from '../app/api/wiki/[page_id]/connections/evidence/route';
import { getConnectionEvidence, getPageConnections } from '../lib/relations';
import { seedPage, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

/** Bitcoin uses proof of work in five sources, and was created by Satoshi (no page) in two. */
function fixture(): void {
  handle = setupTestDb();
  const db = handle.db;
  seedPage(db, { page_id: 'bitcoin', title: 'Bitcoin' });
  seedPage(db, { page_id: 'pow', title: 'Proof of work' });
  const rel = db.prepare(
    `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id, description, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (let i = 1; i <= 5; i++) {
    seedSource(db, { source_id: `src-${i}`, title: `Source ${i}` });
    rel.run('Bitcoin', 'Proof of work', 'uses', `src-${i}`, `Sentence ${i}.`, `2026-01-0${i} 00:00:00`);
  }
  rel.run('Bitcoin', 'Satoshi Nakamoto', 'created_by', 'src-1', null, '2026-01-01 00:00:00');
  rel.run('Bitcoin', 'Satoshi Nakamoto', 'created_by', 'src-2', null, '2026-01-02 00:00:00');
}

async function call(pageId: string, query: string) {
  const res = await GET(new Request(`http://test/api/wiki/${pageId}/connections/evidence?${query}`), {
    params: Promise.resolve({ page_id: pageId }),
  });
  return { status: res.status, body: (await res.json()) as { items?: Array<{ evidence: unknown[]; source_count: number }>; count?: number; error?: string } };
}

describe('getConnectionEvidence', () => {
  it('keeps three sources per connection in the page read model, and gives one connection all of them', () => {
    fixture();
    const [uses] = getPageConnections('bitcoin').groups.find((g) => g.label === 'Uses')!.items;
    expect(uses).toMatchObject({ source_count: 5 });
    expect(uses.evidence).toHaveLength(3);
    const [all] = getConnectionEvidence('bitcoin', { page_id: 'pow' }, 'uses', 'out');
    expect(all.evidence.map((e) => e.source_id).sort()).toEqual(['src-1', 'src-2', 'src-3', 'src-4', 'src-5']);
    expect(getConnectionEvidence('bitcoin', { page_id: 'pow' }, 'uses', 'in')).toEqual([]);
  });

  it('finds a name with no page by name, in any case', () => {
    fixture();
    const [item] = getConnectionEvidence('bitcoin', { name: 'satoshi nakamoto' }, 'created_by', 'out');
    expect(item).toMatchObject({ page_id: null, title: 'Satoshi Nakamoto', source_count: 2 });
    expect(item.evidence).toHaveLength(2);
  });
});

describe('GET /api/wiki/[page_id]/connections/evidence', () => {
  it('returns the matching connection with every source', async () => {
    fixture();
    const { status, body } = await call('bitcoin', 'type=uses&direction=out&page=pow');
    expect(status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.items?.[0].evidence).toHaveLength(5);
    expect((await call('bitcoin', 'type=created_by&direction=out&name=Satoshi%20Nakamoto')).body.items?.[0].evidence).toHaveLength(2);
  });

  it('answers 400 without a type, a direction or exactly one end', async () => {
    fixture();
    for (const q of ['direction=out&page=pow', 'type=uses&page=pow', 'type=uses&direction=sideways&page=pow', 'type=uses&direction=out', 'type=uses&direction=out&page=pow&name=x']) {
      expect((await call('bitcoin', q)).status).toBe(400);
    }
  });

  it('answers 404 for an unknown page', async () => {
    fixture();
    expect((await call('missing', 'type=uses&direction=out&page=pow')).status).toBe(404);
  });
});

describe('the graph panels\' "+N more sources"', () => {
  const item = (page_id: string | null, title: string, evidence: number, source_count: number) => ({
    page_id, title, type: 'created_by', direction: 'out' as const, source_count,
    evidence: Array.from({ length: evidence }, (_, i) => ({
      source_id: `s${i}`, source_title: `Source ${i}`, source_archived: false, sentence: null, quote: null,
    })),
  });

  it('asks for one connection by page, or by name for a name with no page', () => {
    expect(evidenceUrl('bit coin', item('pow', 'Proof of work', 3, 5)))
      .toBe('/api/wiki/bit%20coin/connections/evidence?type=created_by&direction=out&page=pow');
    expect(evidenceUrl('bitcoin', item(null, 'Satoshi & co', 3, 5)))
      .toBe('/api/wiki/bitcoin/connections/evidence?type=created_by&direction=out&name=Satoshi+%26+co');
  });

  it('offers the rest as a button that opens them, and nothing when all are shown', () => {
    const html = renderToString(createElement(EvidenceList, { item: item('pow', 'Proof of work', 3, 6), pageId: 'bitcoin' }));
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>\+3 more sources<\/button>/);
    const all = renderToString(createElement(EvidenceList, { item: item('pow', 'Proof of work', 2, 2), pageId: 'bitcoin' }));
    expect(all).not.toContain('<button');
  });
});
