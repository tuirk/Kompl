/**
 * "How these pages connect" in research_topic's pack (lib/research.ts over
 * lib/relation-among.ts): typed relations touching the pack's pages, both
 * ends real pages, strongest first (specific before "related to", then most
 * sources), each citing sources in the pack's ONE shared numbering, read in
 * a single pass over the relation rows.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/api/wiki/research/route';
import { getRelationsAmong } from '../lib/relations';
import { seedPage, seedProvenance, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  handle?.cleanup();
  handle = null;
});

function stubVectors() {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ matches: [] })));
}

function page(id: string, title: string, body: string, sources: string[], page_type = 'concept') {
  const db = handle!.db;
  seedPage(db, { page_id: id, title, page_type, summary: `${title} summary.` });
  db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run(body, id);
  db.prepare('INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)').run(id, title, body);
  for (const s of sources) seedProvenance(db, id, s);
}

/** One relationship_mentions row; a later `day` is newer. */
function rel(from: string, to: string, type: string, source: string, sentence: string | null, day = 1) {
  handle!.db
    .prepare(
      `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id, description, first_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(from, to, type, source, sentence, `2026-10-${String(day).padStart(2, '0')} 10:00:00`);
}

async function research(topic: string) {
  const res = await GET(new Request(`http://test/api/wiki/research?topic=${encodeURIComponent(topic)}`));
  return (await res.json()) as Record<string, any>;
}

/** Bitcoin and Proof of work match "bitcoin"; the other pages don't. */
function seedWiki() {
  handle = setupTestDb();
  const db = handle.db;
  const ids = { paper: randomUUID(), blog: randomUUID(), forum: randomUUID(), news: randomUUID(), late: randomUUID() };
  for (const [name, id] of Object.entries(ids)) seedSource(db, { source_id: id, title: `The ${name}` });
  page('btc', 'Bitcoin', `Bitcoin is digital cash [^${ids.paper}].`, [ids.paper], 'entity');
  page('pow', 'Proof of work', `Proof of work secures bitcoin [^${ids.blog}].`, [ids.blog]);
  page('sat', 'Satoshi Nakamoto', `A pseudonymous person [^${ids.news}].`, [ids.news], 'entity');
  page('pos', 'Proof of stake', `An alternative to mining [^${ids.news}].`, [ids.news]);
  page('sov', 'Store of value', `Holds value over time [^${ids.news}].`, [ids.news]);
  page('old', 'Old coin', `Archived [^${ids.news}].`, [ids.news], 'archived');
  db.prepare('INSERT INTO aliases (alias, canonical_name, canonical_page_id) VALUES (?, ?, ?)').run('BTC', 'Bitcoin', 'btc');

  // Three sources say Bitcoin uses proof of work; the newest that gives a sentence is the forum.
  rel('Bitcoin', 'Proof of work', 'uses', ids.paper, 'Bitcoin uses proof of work.', 1);
  rel('Bitcoin', 'Proof of work', 'uses', ids.blog, null, 3);
  rel('bitcoin', 'proof of work', 'uses', ids.forum, 'Bitcoin relies on proof of work.', 2);
  rel('Bitcoin', 'Satoshi Nakamoto', 'created_by', ids.late, 'Satoshi Nakamoto created Bitcoin.');
  rel('BTC', 'Store of value', 'part_of', ids.news, null); // written with an alias of the page
  rel('Proof of stake', 'Proof of work', 'competes_with', ids.news, 'Proof of stake competes with proof of work.');
  for (const s of [ids.paper, ids.blog, ids.forum, ids.news]) {
    rel('Bitcoin', 'Proof of work', 'related_to', s, 'Related.'); // the pair already "uses": left out
    rel('Proof of work', 'Store of value', 'related_to', s, 'Related too.');
  }
  rel('Old coin', 'Bitcoin', 'uses', ids.news, 'An archived page.'); // archived end: left out
  rel('Bitcoin', 'Mining pools', 'uses', ids.news, 'No page.'); // a name with no page: left out
  rel('Satoshi Nakamoto', 'Store of value', 'uses', ids.news, 'Neither end in the pack.');
  return ids;
}

describe('research pack connections', () => {
  it('lists relations around the pack, strongest first, in the shared source numbering', async () => {
    const ids = seedWiki();
    stubVectors();
    const body = await research('bitcoin');
    expect(body.pages.map((p: { page_id: string }) => p.page_id).sort()).toEqual(['btc', 'pow']);

    const summary = body.connections.map((c: any) => `${c.from.page_id} ${c.label} ${c.to.page_id} ${c.source_count}`);
    expect(summary).toEqual([
      'btc Uses pow 3',
      'btc Part of sov 1',
      'btc Created by sat 1',
      // Symmetric: read from the pack's page.
      'pow Competes with pos 1',
      // "related to" comes after every specific relation, whatever its sources.
      'pow Related to sov 4',
    ]);

    const numberOf = new Map<string, number>(body.sources.map((s: { n: number; source_id: string }) => [s.source_id, s.n]));
    const uses = body.connections[0];
    expect(uses).toMatchObject({ from: { title: 'Bitcoin' }, to: { title: 'Proof of work' }, type: 'uses', sentence: 'Bitcoin relies on proof of work.' });
    // The sentence's source first, then the newest; at most 3 numbers.
    expect(uses.sources).toEqual([numberOf.get(ids.forum), numberOf.get(ids.blog), numberOf.get(ids.paper)]);
    expect(body.connections[1].sentence).toBeNull();

    // Key-line sources keep their numbers; a relation's new sources join the one list.
    const keyNumbers = new Set<number>(body.pages.flatMap((p: { key_lines: string[] }) => [...p.key_lines.join(' ').matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))));
    expect([...keyNumbers].sort()).toEqual([numberOf.get(ids.paper), numberOf.get(ids.blog)].sort());
    expect(numberOf.get(ids.late)).toBeGreaterThan(Math.max(...keyNumbers));
    expect(body.sources.map((s: { n: number }) => s.n)).toEqual(body.sources.map((_: unknown, i: number) => i + 1));
    const listed = new Set(numberOf.values());
    expect(body.connections.flatMap((c: { sources: number[] }) => c.sources).every((n: number) => listed.has(n))).toBe(true);
    expect(body.sources.find((s: { source_id: string }) => s.source_id === ids.late)).toMatchObject({ title: 'The late', path: `/source/${ids.late}` });
  });

  it('reads the relation rows once, however many pages the pack holds', async () => {
    seedWiki();
    stubVectors();
    const prepare = vi.spyOn(handle!.db, 'prepare');
    await research('bitcoin');
    const reads = prepare.mock.calls.filter(([sql]) => /FROM\s+relationship_mentions/i.test(String(sql)));
    expect(reads).toHaveLength(1);
  });

  it('keeps 12, in the same order on every call, and none for an empty pack', () => {
    handle = setupTestDb();
    const db = handle.db;
    const source = seedSource(db, { title: 'One source' });
    const other = seedSource(db, { title: 'Two source' });
    seedPage(db, { page_id: 'hub', title: 'Hub' });
    for (let i = 0; i < 15; i++) {
      seedPage(db, { page_id: `leaf-${String(i).padStart(2, '0')}`, title: `Leaf ${String(i).padStart(2, '0')}` });
      rel('Hub', `Leaf ${String(i).padStart(2, '0')}`, 'part_of', source, null);
    }
    rel('Hub', 'Leaf 14', 'part_of', other, null); // the only relation with two sources
    const first = getRelationsAmong(['hub'], 12);
    expect(first).toHaveLength(12);
    expect(first[0].to.page_id).toBe('leaf-14');
    expect(first.slice(1).map((r) => r.to.page_id)).toEqual(Array.from({ length: 11 }, (_, i) => `leaf-${String(i).padStart(2, '0')}`));
    expect(getRelationsAmong(['hub'], 12)).toEqual(first);
    expect(getRelationsAmong([], 12)).toEqual([]);
  });

  it('prefers relations between two pack pages when sources tie', () => {
    handle = setupTestDb();
    const db = handle.db;
    const source = seedSource(db, { title: 'Source' });
    for (const [id, title] of [['a', 'Alpha'], ['b', 'Beta'], ['z', 'Zeta']]) seedPage(db, { page_id: id, title });
    rel('Alpha', 'Zeta', 'uses', source, null);
    rel('Alpha', 'Beta', 'uses', source, null);
    rel('Beta', 'Zeta', 'part_of', source, null);
    expect(getRelationsAmong(['a', 'z'], 12).map((r) => `${r.from.page_id}>${r.to.page_id}`)).toEqual(['a>z', 'b>z', 'a>b']);
  });

  it('merges "related to" written both ways, keeps opposite directed relations apart, and never flips an unknown type', () => {
    handle = setupTestDb();
    const db = handle.db;
    const [s1, s2, s3] = ['One', 'Two', 'Three'].map((title) => seedSource(db, { title }));
    const pages = [['eth', 'Ethereum'], ['vb', 'Vitalik Buterin'], ['a', 'Alpha'], ['b', 'Beta'], ['g', 'Gamma']];
    for (const [id, title] of pages) seedPage(db, { page_id: id, title });
    rel('Alpha', 'Gamma', 'related_to', s1, null);
    rel('Gamma', 'Alpha', 'related_to', s2, null);
    rel('Alpha', 'Beta', 'uses', s1, null);
    rel('Beta', 'Alpha', 'uses', s3, null);
    rel('Ethereum', 'Vitalik Buterin', 'founded_by', s1, 'Vitalik Buterin founded Ethereum.');

    const ab = getRelationsAmong(['a'], 12).map((r) => `${r.from.page_id} ${r.type} ${r.to.page_id} ${r.source_ids.length}`);
    expect(ab).toEqual(['a uses b 1', 'b uses a 1', 'a related_to g 2']);

    // Only the founder is in the pack: the relation still reads "Ethereum founded by Vitalik".
    const [founded] = getRelationsAmong(['vb'], 12);
    expect(founded).toMatchObject({ from: { page_id: 'eth' }, to: { page_id: 'vb' }, type: 'founded_by' });
  });

  it('drops "related to" for a pair a specific relation joins, keeps it alone, and gives the slot to the next relation', () => {
    handle = setupTestDb();
    const db = handle.db;
    const [s1, s2, s3] = ['One', 'Two', 'Three'].map((title) => seedSource(db, { title }));
    for (const [id, title] of [['x', 'Xeno'], ['y', 'Yara'], ['z', 'Zola']]) seedPage(db, { page_id: id, title });
    rel('Xeno', 'Yara', 'competes_with', s1, null);
    for (const s of [s1, s2, s3]) rel('Yara', 'Xeno', 'related_to', s, null); // the stronger "related to", but the pair competes
    rel('Xeno', 'Zola', 'related_to', s1, null); // "related to" only
    const shown = (limit: number) => getRelationsAmong(['x'], limit).map((r) => `${r.from.page_id} ${r.type} ${r.to.page_id}`);
    expect(shown(12)).toEqual(['x competes_with y', 'x related_to z']);
    // With two slots, the one the repeated "related to" would take goes to the next relation.
    expect(shown(2)).toEqual(['x competes_with y', 'x related_to z']);
  });

  it('never ends a relation at Saved Links', () => {
    handle = setupTestDb();
    const db = handle.db;
    const source = seedSource(db, { title: 'Source' });
    seedPage(db, { page_id: 'btc', title: 'Bitcoin' });
    seedPage(db, { page_id: 'saved-links', title: 'Saved Links', page_type: 'overview' });
    rel('Bitcoin', 'Saved Links', 'part_of', source, null);
    rel('Saved Links', 'Bitcoin', 'uses', source, null);
    expect(getRelationsAmong(['btc', 'saved-links'], 12)).toEqual([]);
  });
});
