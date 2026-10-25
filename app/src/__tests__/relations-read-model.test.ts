/**
 * Connections read model (lib/relations.ts): relationship_mentions resolved
 * to pages by exact title or alias, grouped by the shared vocabulary for a
 * page, and merged into one edge per page pair for the graph.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { setSourceStatus } from '../lib/db';
import { getPageConnections, getRelationEdges, resolveNames } from '../lib/relations';
import { relationLabel } from '../lib/relation-labels';
import { seedPage, seedProvenance, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function fixture(): void {
  handle = setupTestDb();
  const db = handle.db;
  for (const n of [1, 2, 3, 4]) seedSource(db, { source_id: `src-${n}`, title: `Source ${n}` });
  seedPage(db, { page_id: 'bitcoin', title: 'Bitcoin', category: 'Crypto' });
  seedPage(db, { page_id: 'pow', title: 'Proof of work', page_type: 'concept' });
  seedPage(db, { page_id: 'lightning', title: 'Lightning Network' });
  seedPage(db, { page_id: 'ethereum', title: 'Ethereum' });
  seedPage(db, { page_id: 'vilnius', title: 'Vilnius' });
  seedPage(db, { page_id: 'mtgox', title: 'Mt. Gox', page_type: 'archived' });
  seedPage(db, { page_id: 'old-exchange', title: 'Old Exchange' });
  seedPage(db, { page_id: 'saved-links', title: 'Saved Links', page_type: 'overview' });
  seedSource(db, { source_id: 'src-arch' });
  seedProvenance(db, 'old-exchange', 'src-arch');
  setSourceStatus('src-arch', 'archived'); // also resets the archived-pages cache

  const alias = db.prepare('INSERT INTO aliases (alias, canonical_name, canonical_page_id) VALUES (?, ?, ?)');
  alias.run('BTC', 'Bitcoin', null);
  alias.run('Satoshi coin', 'Bitcoin', 'bitcoin');
  alias.run('Bitcoin 2', 'Bitcoin', null); // numbers differ: never resolves

  const rel = db.prepare(
    `INSERT INTO relationship_mentions
       (from_canonical, to_canonical, relationship_type, source_id, description, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const rows: Array<[string, string, string, string, string | null, string]> = [
    ['Bitcoin', 'Proof of work', 'uses', 'src-1', 'Bitcoin uses proof of work.', '2026-01-01 00:00:00'],
    ['BTC', 'Proof of work', 'uses', 'src-2', null, '2026-01-03 00:00:00'],
    ['bitcoin', 'proof of work', 'uses', 'src-3', 'Mining is proof of work.', '2026-01-02 00:00:00'],
    ['Satoshi coin', 'Proof of work', 'uses', 'src-4', 'Satoshi coin relies on PoW.', '2026-01-04 00:00:00'],
    ['Lightning Network', 'Bitcoin', 'part_of', 'src-1', 'Lightning runs on Bitcoin.', '2026-01-01 00:00:00'],
    ['Bitcoin', 'Satoshi Nakamoto', 'created_by', 'src-1', 'Satoshi created Bitcoin.', '2026-01-01 00:00:00'],
    ['Bitcoin', 'Ethereum', 'competes_with', 'src-2', 'They compete.', '2026-01-02 00:00:00'],
    ['Ethereum', 'Bitcoin', 'related_to', 'src-3', 'Older related sentence.', '2026-01-02 00:00:00'],
    ['Bitcoin', 'Ethereum', 'related_to', 'src-4', 'Newer related sentence.', '2026-01-04 00:00:00'],
    ['Bitcoin', 'Cypherpunks', 'influenced_by', 'src-2', 'Cypherpunk ideas shaped Bitcoin.', '2026-01-02 00:00:00'],
    ['Bitcoin', 'Mt. Gox', 'related_to', 'src-1', 'Mt. Gox traded Bitcoin.', '2026-01-01 00:00:00'],
    ['Old Exchange', 'Bitcoin', 'uses', 'src-1', 'It used Bitcoin.', '2026-01-01 00:00:00'],
    ['BTC', 'Bitcoin', 'related_to', 'src-1', 'Self.', '2026-01-01 00:00:00'],
    ['Bitcoin 2', 'Proof of work', 'uses', 'src-1', 'Not Bitcoin.', '2026-01-01 00:00:00'],
  ];
  for (const r of rows) rel.run(...r);

  const link = db.prepare(`INSERT INTO page_links (source_page_id, target_page_id, link_type) VALUES (?, ?, 'wikilink')`);
  for (const [a, b] of [
    ['bitcoin', 'pow'], ['vilnius', 'bitcoin'], ['bitcoin', 'ethereum'], ['ethereum', 'bitcoin'],
    ['bitcoin', 'mtgox'], ['bitcoin', 'saved-links'], ['pow', 'vilnius'],
  ]) link.run(a, b);

  const mention = db.prepare('INSERT INTO entity_mentions (canonical_name, source_id) VALUES (?, ?)');
  mention.run('Satoshi Nakamoto', 'src-1');
  mention.run('satoshi nakamoto', 'src-2');
  mention.run('Satoshi Nakamoto', 'src-3');
  mention.run('Cypherpunks', 'src-2');
}

describe('relation labels', () => {
  it('reads labels from the page side; unknown types get a readable label', () => {
    expect(relationLabel('part_of', 'out')).toBe('Part of');
    expect(relationLabel('part_of', 'in')).toBe('Includes');
    expect(relationLabel('created_by', 'in')).toBe('Created');
    expect(relationLabel('uses', 'in')).toBe('Used by');
    expect(relationLabel('competes_with', 'in')).toBe('Competes with');
    // Unknown types are directional (relation-direction.test.ts has the rest).
    expect(relationLabel('influenced_by', 'out')).toBe('Influenced by');
    expect(relationLabel('influenced_by', 'in')).toBe('Influenced');
  });
});

describe('resolveNames', () => {
  it('maps titles and aliases case-insensitively, archived pages only on request', () => {
    fixture();
    const names = resolveNames(handle!.db);
    expect(names.get('bitcoin')).toBe('bitcoin');
    expect(names.get('btc')).toBe('bitcoin');
    expect(names.get('satoshi coin')).toBe('bitcoin');
    expect(names.has('bitcoin 2')).toBe(false);
    expect(names.has('mt. gox')).toBe(false);
    expect(names.has('old exchange')).toBe(false);
    expect(names.has('saved links')).toBe(false);
    expect(resolveNames(handle!.db, { includeArchived: true }).get('mt. gox')).toBe('mtgox');
  });
});

describe('getPageConnections', () => {
  it('groups by label in vocabulary order, with plain names and an unknown type', () => {
    fixture();
    const { groups } = getPageConnections('bitcoin');
    // Ethereum is related to Bitcoin too, but Competes with already lists it.
    expect(groups.map((g) => g.label)).toEqual([
      'Includes', 'Created by', 'Uses', 'Competes with', 'Influenced by',
    ]);
    const item = (label: string) => groups.find((g) => g.label === label)!.items;
    expect(item('Includes')).toMatchObject([{ page_id: 'lightning', title: 'Lightning Network', type: 'part_of', direction: 'in' }]);
    expect(item('Created by')).toMatchObject([{ page_id: null, title: 'Satoshi Nakamoto', direction: 'out' }]);
    expect(item('Influenced by')).toMatchObject([{ page_id: null, title: 'Cypherpunks', type: 'influenced_by' }]);
  });

  it('merges rows reached through aliases and keeps 3 evidence entries, sentences first, newest first', () => {
    fixture();
    const uses = getPageConnections('bitcoin').groups.find((g) => g.label === 'Uses')!.items;
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ page_id: 'pow', title: 'Proof of work', source_count: 4, direction: 'out' });
    expect(uses[0].evidence).toEqual([
      { source_id: 'src-4', source_title: 'Source 4', source_archived: false, sentence: 'Satoshi coin relies on PoW.', quote: null },
      { source_id: 'src-3', source_title: 'Source 3', source_archived: false, sentence: 'Mining is proof of work.', quote: null },
      { source_id: 'src-1', source_title: 'Source 1', source_archived: false, sentence: 'Bitcoin uses proof of work.', quote: null },
    ]);
  });

  it('merges both directions of a symmetric type into one item', () => {
    fixture();
    handle!.db.prepare("DELETE FROM relationship_mentions WHERE relationship_type = 'competes_with'").run();
    const related = getPageConnections('bitcoin').groups.find((g) => g.label === 'Related to')!.items;
    expect(related).toHaveLength(1);
    expect(related[0]).toMatchObject({ page_id: 'ethereum', source_count: 2, direction: 'out' });
    expect(related[0].evidence[0].sentence).toBe('Newer related sentence.');
  });

  it('lists a page under "Related to" only when no other relation joins them', () => {
    fixture();
    const ethereum = getPageConnections('ethereum').groups;
    expect(ethereum.map((g) => g.label)).toEqual(['Competes with']);
    expect(ethereum[0].items).toMatchObject([{ page_id: 'bitcoin', type: 'competes_with', source_count: 1 }]);
  });

  it('labels the other side by direction', () => {
    fixture();
    const { groups } = getPageConnections('pow');
    expect(groups.map((g) => g.label)).toEqual(['Used by']);
    // "Bitcoin 2" is an alias whose numbers differ from Bitcoin's, so it
    // stays a plain name instead of landing on the Bitcoin page.
    expect(groups[0].items).toMatchObject([
      { page_id: 'bitcoin', title: 'Bitcoin', direction: 'in', source_count: 4 },
      { page_id: null, title: 'Bitcoin 2', direction: 'in', source_count: 1 },
    ]);
    expect(getPageConnections('lightning').groups).toMatchObject([{ label: 'Part of', items: [{ page_id: 'bitcoin' }] }]);
  });

  it('leaves out archived pages, Saved Links, self links and grouped pages from linked_only', () => {
    fixture();
    const result = getPageConnections('bitcoin');
    const all = result.groups.flatMap((g) => g.items.map((i) => i.title));
    expect(all).not.toContain('Mt. Gox');
    expect(all).not.toContain('Old Exchange');
    expect(all).not.toContain('Bitcoin');
    expect(all).not.toContain('Bitcoin 2');
    expect(result.linked_only).toEqual([{ page_id: 'vilnius', title: 'Vilnius' }]);
    expect(getPageConnections('pow').linked_only).toEqual([{ page_id: 'vilnius', title: 'Vilnius' }]);
  });

  it('a live page alias beats an archived page title of the same name', () => {
    handle = setupTestDb();
    const db = handle.db;
    seedSource(db, { source_id: 'src-1', title: 'Source 1' });
    seedPage(db, { page_id: 'bitcoin', title: 'Bitcoin' });
    seedPage(db, { page_id: 'btc-old', title: 'BTC', page_type: 'archived' });
    seedPage(db, { page_id: 'pow', title: 'PoW' });
    db.prepare('INSERT INTO aliases (alias, canonical_name, canonical_page_id) VALUES (?, ?, ?)').run('BTC', 'Bitcoin', 'bitcoin');
    db.prepare(
      `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id, description)
       VALUES ('BTC', 'PoW', 'uses', 'src-1', 'BTC uses PoW.')`
    ).run();
    setSourceStatus('src-1', 'active'); // resets the archived-pages cache

    expect(resolveNames(db, { includeArchived: true }).get('btc')).toBe('bitcoin');
    expect(getPageConnections('bitcoin').groups).toMatchObject([
      { label: 'Uses', items: [{ page_id: 'pow', source_count: 1, evidence: [{ sentence: 'BTC uses PoW.' }] }] },
    ]);
    for (const edges of [getRelationEdges().edges, getRelationEdges({ includeArchived: true }).edges]) {
      expect(edges).toEqual([
        { source: 'bitcoin', target: 'pow', relations: [{ type: 'uses', direction: 'out', source_count: 1 }], wikilink: false, weight: 1 },
      ]);
    }
  });

  it('keeps evidence from an archived source and flags it', () => {
    handle = setupTestDb();
    const db = handle.db;
    seedSource(db, { source_id: 'src-live', title: 'Live source' });
    seedSource(db, { source_id: 'src-old', title: 'Old source' });
    seedPage(db, { page_id: 'bitcoin', title: 'Bitcoin' });
    seedPage(db, { page_id: 'pow', title: 'Proof of work' });
    seedProvenance(db, 'bitcoin', 'src-live');
    seedProvenance(db, 'bitcoin', 'src-old');
    const rel = db.prepare(
      `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id, description, first_seen_at)
       VALUES ('Bitcoin', 'Proof of work', 'uses', ?, ?, ?)`
    );
    rel.run('src-live', 'Bitcoin uses proof of work.', '2026-01-01 00:00:00');
    rel.run('src-old', 'Miners run proof of work.', '2026-01-02 00:00:00');
    setSourceStatus('src-old', 'archived');

    const [item] = getPageConnections('bitcoin').groups[0].items;
    expect(item).toMatchObject({ page_id: 'pow', source_count: 2 });
    expect(item.evidence).toEqual([
      { source_id: 'src-old', source_title: 'Old source', source_archived: true, sentence: 'Miners run proof of work.', quote: null },
      { source_id: 'src-live', source_title: 'Live source', source_archived: false, sentence: 'Bitcoin uses proof of work.', quote: null },
    ]);
  });

  it('returns empty lists for an unknown page', () => {
    fixture();
    expect(getPageConnections('nope')).toEqual({ groups: [], linked_only: [] });
  });
});

describe('getRelationEdges', () => {
  it('merges reciprocal rows and wikilinks into one edge per page pair, weighted by sources', () => {
    fixture();
    const { edges } = getRelationEdges();
    expect(edges.map((e) => `${e.source}-${e.target}`)).toEqual([
      'bitcoin-ethereum', 'bitcoin-lightning', 'bitcoin-pow', 'bitcoin-vilnius', 'pow-vilnius',
    ]);
    const edge = (s: string, t: string) => edges.find((e) => e.source === s && e.target === t)!;
    expect(edge('bitcoin', 'ethereum')).toEqual({
      source: 'bitcoin',
      target: 'ethereum',
      relations: [
        { type: 'related_to', direction: 'out', source_count: 2 },
        { type: 'competes_with', direction: 'out', source_count: 1 },
      ],
      wikilink: true,
      weight: 2,
    });
    expect(edge('bitcoin', 'pow')).toMatchObject({ relations: [{ type: 'uses', direction: 'out', source_count: 4 }], wikilink: true, weight: 4 });
    expect(edge('bitcoin', 'lightning')).toMatchObject({ relations: [{ type: 'part_of', direction: 'in' }], wikilink: false, weight: 1 });
    expect(edge('bitcoin', 'vilnius')).toMatchObject({ relations: [], wikilink: true, weight: 0 });
  });

  it('lists names with no page that are named in 3+ sources', () => {
    fixture();
    expect(getRelationEdges().missing).toEqual([{ name: 'Satoshi Nakamoto', source_count: 3, page_ids: ['bitcoin'] }]);
  });

  it('includes archived pages on request', () => {
    fixture();
    const pairs = getRelationEdges({ includeArchived: true }).edges.map((e) => `${e.source}-${e.target}`);
    expect(pairs).toContain('bitcoin-mtgox');
    expect(pairs).toContain('bitcoin-old-exchange');
    expect(pairs.some((p) => p.includes('saved-links'))).toBe(false);
  });
});
