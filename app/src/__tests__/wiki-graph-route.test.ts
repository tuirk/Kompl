/**
 * GET /api/wiki/graph — the knowledge graph page's data (lib/wiki-graph.ts):
 * every page with its category and degree, one line per page pair from the
 * relations read model (typed relations, wikilink, weight), the missing
 * names, archived pages only on request and Saved Links never.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '../app/api/wiki/graph/route';
import { setSourceStatus } from '../lib/db';
import type { WikiGraph } from '../lib/wiki-graph';
import { seedPage, seedProvenance, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

async function graph(query = ''): Promise<WikiGraph> {
  const res = await GET(new Request(`http://test/api/wiki/graph${query}`));
  expect(res.status).toBe(200);
  return (await res.json()) as WikiGraph;
}

function fixture(): void {
  handle = setupTestDb();
  const db = handle.db;
  for (const n of [1, 2, 3]) seedSource(db, { source_id: `src-${n}`, title: `Source ${n}` });
  seedPage(db, { page_id: 'bitcoin', title: 'Bitcoin', category: 'Crypto', summary: 'A coin.' });
  seedPage(db, { page_id: 'pow', title: 'Proof of work', page_type: 'concept', category: 'Crypto' });
  seedPage(db, { page_id: 'vilnius', title: 'Vilnius', category: '  ' });
  seedPage(db, { page_id: 'old-exchange', title: 'Old Exchange', category: 'Crypto' });
  seedPage(db, { page_id: 'saved-links', title: 'Saved Links', page_type: 'overview' });
  seedSource(db, { source_id: 'src-arch' });
  seedProvenance(db, 'old-exchange', 'src-arch');
  setSourceStatus('src-arch', 'archived');

  const rel = db.prepare(
    `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id, description, first_seen_at)
     VALUES (?, ?, ?, ?, ?, '2026-01-01 00:00:00')`
  );
  rel.run('Bitcoin', 'Proof of work', 'uses', 'src-1', 'Bitcoin uses proof of work.');
  rel.run('Bitcoin', 'Proof of work', 'uses', 'src-2', null);
  rel.run('Bitcoin', 'Satoshi Nakamoto', 'created_by', 'src-1', null);
  rel.run('Old Exchange', 'Bitcoin', 'uses', 'src-3', 'It traded Bitcoin.');
  const link = db.prepare(`INSERT INTO page_links (source_page_id, target_page_id, link_type) VALUES (?, ?, 'wikilink')`);
  for (const [a, b] of [['bitcoin', 'pow'], ['pow', 'bitcoin'], ['vilnius', 'bitcoin'], ['bitcoin', 'saved-links']]) link.run(a, b);
  const mention = db.prepare('INSERT INTO entity_mentions (canonical_name, source_id) VALUES (?, ?)');
  mention.run('Satoshi Nakamoto', 'src-1');
  mention.run('Satoshi Nakamoto', 'src-2');
  mention.run('Satoshi Nakamoto', 'src-3');
}

describe('GET /api/wiki/graph', () => {
  it('returns pages with category and degree, one line per page pair, and the missing names', async () => {
    fixture();
    const body = await graph();
    expect(Object.keys(body).sort()).toEqual(['links', 'missing', 'nodes']);
    expect(body.nodes).toEqual([
      { id: 'bitcoin', label: 'Bitcoin', group: 'entity', category: 'Crypto', source_count: 1, summary: 'A coin.', last_updated: expect.any(String), degree: 2 },
      { id: 'pow', label: 'Proof of work', group: 'concept', category: 'Crypto', source_count: 1, summary: null, last_updated: expect.any(String), degree: 1 },
      { id: 'vilnius', label: 'Vilnius', group: 'entity', category: 'Uncategorized', source_count: 1, summary: null, last_updated: expect.any(String), degree: 1 },
    ]);
    expect(body.links).toEqual([
      { source: 'bitcoin', target: 'pow', relations: [{ type: 'uses', direction: 'out', source_count: 2 }], wikilink: true, weight: 2 },
      { source: 'bitcoin', target: 'vilnius', relations: [], wikilink: true, weight: 0 },
    ]);
    expect(body.missing).toEqual([{ name: 'Satoshi Nakamoto', source_count: 3, page_ids: ['bitcoin'] }]);
  });

  it('adds archived pages, flagged, with include_archived=true', async () => {
    fixture();
    const body = await graph('?include_archived=true');
    const old = body.nodes.find((n) => n.id === 'old-exchange');
    expect(old).toMatchObject({ archived: true, degree: 1 });
    expect(body.nodes.find((n) => n.id === 'bitcoin')).not.toHaveProperty('archived');
    expect(body.links).toContainEqual({
      source: 'bitcoin', target: 'old-exchange', relations: [{ type: 'uses', direction: 'in', source_count: 1 }], wikilink: false, weight: 1,
    });
    expect(body.nodes.find((n) => n.id === 'bitcoin')?.degree).toBe(3);
  });

  it('never shows Saved Links, and every line joins two listed pages', async () => {
    fixture();
    for (const body of [await graph(), await graph('?include_archived=true')]) {
      const ids = new Set(body.nodes.map((n) => n.id));
      expect(ids.has('saved-links')).toBe(false);
      for (const l of body.links) expect(ids.has(l.source) && ids.has(l.target)).toBe(true);
    }
  });

  it('answers an empty wiki with empty lists', async () => {
    handle = setupTestDb();
    expect(await graph()).toEqual({ nodes: [], links: [], missing: [] });
  });
});
