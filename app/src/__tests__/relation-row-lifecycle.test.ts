/**
 * relationship_mentions rows over a wiki's life:
 *   - deleting a source (deleteOneSourceWithCascade) removes its rows, so the
 *     connections card counts one source fewer, or loses a connection only
 *     that source gave
 *   - an alias merge can turn a row into a self-loop (BTC -> Bitcoin); the
 *     graph never draws it, with or without archived pages, and the card
 *     never lists a page as its own connection
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../lib/recompile', () => ({
  recompilePage: vi.fn(async () => ({ outcome: 'rewritten' as const })),
}));

import { insertRelationshipMentions } from '../lib/db';
import { getPageConnections, getRelationEdges } from '../lib/relations';
import { deleteOneSourceWithCascade } from '../lib/source-delete';
import { seedPage, seedProvenance, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

describe('source delete', () => {
  it("removes the source's relation rows and the card follows", async () => {
    handle = setupTestDb();
    const db = handle.db;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })));
    for (const id of ['life-1', 'life-2', 'life-3']) seedSource(db, { source_id: id, title: id });
    seedPage(db, { page_id: 'bitcoin', title: 'Bitcoin' });
    seedPage(db, { page_id: 'pow', title: 'Proof of work' });
    seedPage(db, { page_id: 'lightning', title: 'Lightning Network' });
    // The pages rest on the first two sources, so deleting the third touches no page.
    for (const page of ['bitcoin', 'pow', 'lightning']) {
      seedProvenance(db, page, 'life-1');
      seedProvenance(db, page, 'life-2');
    }
    const uses = (source_id: string) => ({
      from_canonical: 'Bitcoin', to_canonical: 'Proof of work', relationship_type: 'uses', source_id, description: `${source_id} says so.`,
    });
    insertRelationshipMentions([
      uses('life-1'),
      uses('life-2'),
      uses('life-3'),
      { from_canonical: 'Lightning Network', to_canonical: 'Bitcoin', relationship_type: 'part_of', source_id: 'life-3', description: 'Only here.' },
    ]);
    expect(getPageConnections('bitcoin').groups).toMatchObject([
      { label: 'Includes', items: [{ page_id: 'lightning', source_count: 1 }] },
      { label: 'Uses', items: [{ page_id: 'pow', source_count: 3 }] },
    ]);

    const result = await deleteOneSourceWithCascade('life-3');

    expect(result).toMatchObject({ status: 'ok', pages_deleted: 0, pages_rewritten: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM relationship_mentions WHERE source_id = 'life-3'`).get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM relationship_mentions').get()).toEqual({ n: 2 });
    const groups = getPageConnections('bitcoin').groups;
    expect(groups).toMatchObject([{ label: 'Uses', items: [{ page_id: 'pow', source_count: 2 }] }]);
    expect(groups[0].items[0].evidence.map((e) => e.source_id).sort()).toEqual(['life-1', 'life-2']);
    expect(getRelationEdges().edges.map((e) => `${e.source}-${e.target}`)).toEqual(['bitcoin-pow']);
  });
});

describe('self-loops after an alias merge', () => {
  it('never become an edge, a missing page or a connection, in either graph view', () => {
    handle = setupTestDb();
    const db = handle.db;
    seedSource(db, { source_id: 'loop-1' });
    seedPage(db, { page_id: 'bitcoin', title: 'Bitcoin' });
    seedPage(db, { page_id: 'ethereum', title: 'Ethereum' });
    seedPage(db, { page_id: 'mtgox', title: 'Mt. Gox', page_type: 'archived' });
    const alias = db.prepare('INSERT INTO aliases (alias, canonical_name, canonical_page_id) VALUES (?, ?, ?)');
    alias.run('BTC', 'Bitcoin', null);
    alias.run('MtGox', 'Mt. Gox', 'mtgox');
    insertRelationshipMentions([
      { from_canonical: 'BTC', to_canonical: 'Bitcoin', relationship_type: 'related_to', source_id: 'loop-1', description: null },
      { from_canonical: 'bitcoin', to_canonical: 'BTC', relationship_type: 'competes_with', source_id: 'loop-1', description: null },
      { from_canonical: 'Bitcoin', to_canonical: 'Bitcoin', relationship_type: 'uses', source_id: 'loop-1', description: null },
      { from_canonical: 'MtGox', to_canonical: 'Mt. Gox', relationship_type: 'part_of', source_id: 'loop-1', description: null },
      { from_canonical: 'Bitcoin', to_canonical: 'Ethereum', relationship_type: 'competes_with', source_id: 'loop-1', description: null },
    ]);
    // Named in two sources, so a self-loop end would qualify as a missing page.
    seedSource(db, { source_id: 'loop-2' });
    const mention = db.prepare('INSERT INTO entity_mentions (canonical_name, source_id) VALUES (?, ?)');
    for (const name of ['BTC', 'MtGox', 'Mt. Gox']) {
      mention.run(name, 'loop-1');
      mention.run(name, 'loop-2');
    }

    for (const view of [getRelationEdges(), getRelationEdges({ includeArchived: true })]) {
      expect(view.edges.filter((e) => e.source === e.target)).toEqual([]);
      expect(view.edges.map((e) => `${e.source}-${e.target}`)).toEqual(['bitcoin-ethereum']);
      expect(view.missing).toEqual([]);
    }
    expect(getPageConnections('bitcoin').groups).toMatchObject([
      { label: 'Competes with', items: [{ page_id: 'ethereum' }] },
    ]);
    expect(getPageConnections('mtgox').groups).toEqual([]);
  });
});
