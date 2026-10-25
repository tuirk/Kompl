/**
 * One definition of a "missing page" (lib/missing-pages.ts) for the graph's
 * "Show missing pages" (getRelationEdges) and wiki_status / the health
 * check (runHealthChecks): names the extraction named in enough sources,
 * as something a page could be about (not a date, amount or number), that
 * no page or alias covers, archived pages included; ranked by how many
 * pages name them, then by sources. Each place keeps its own threshold:
 * the graph from 2 sources, wiki_status from 3.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { archivePage } from '../lib/db';
import { findMissingPages } from '../lib/missing-pages';
import { getRelationEdges } from '../lib/relation-edges';
import { runHealthChecks } from '../lib/wiki-health';
import { seedPage, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function seed() {
  handle = setupTestDb();
  const db = handle.db;
  const sources = Array.from({ length: 5 }, (_, i) => seedSource(db, { source_id: `src-${i}`, title: `Source ${i}` }));
  for (const [id, title] of [['bitcoin', 'Bitcoin'], ['ethereum', 'Ethereum'], ['old', 'Mt. Gox']]) {
    seedPage(db, { page_id: id, title, page_type: 'entity', category: 'Crypto' });
  }
  archivePage('old');
  db.prepare(`INSERT INTO aliases (alias, canonical_name, canonical_page_id) VALUES ('ETH', 'Ethereum', 'ethereum')`).run();
  const mention = db.prepare('INSERT INTO entity_mentions (canonical_name, source_id, entity_type) VALUES (?, ?, ?)');
  const named = (name: string, type: string | null, count: number) => {
    for (let i = 0; i < count; i++) mention.run(name, sources[i], type);
  };
  const rel = db.prepare('INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id) VALUES (?, ?, ?, ?)');
  named('Satoshi Nakamoto', 'PERSON', 3); // named with one page, 3 sources
  rel.run('Satoshi Nakamoto', 'Bitcoin', 'created_by', sources[0]);
  named('Vitalik Buterin', 'PERSON', 3); // named with two pages, 3 sources: first
  rel.run('Ethereum', 'Vitalik Buterin', 'created_by', sources[0]);
  rel.run('Bitcoin', 'Vitalik Buterin', 'related_to', sources[1]);
  named('Hal Finney', 'PERSON', 5); // most sources, but named with no page: wiki_status only
  named('Proof of stake', 'CONCEPT', 2); // 2 sources: below the threshold on both
  rel.run('Ethereum', 'Proof of stake', 'uses', sources[0]);
  named('2009', 'DATE', 4); // a date is no topic
  rel.run('Bitcoin', '2009', 'related_to', sources[0]);
  named('$20,000', 'MONEY', 4);
  rel.run('Bitcoin', '$20,000', 'related_to', sources[1]);
  named('eth', 'ORG', 4); // covered by an alias, whatever the case
  rel.run('Bitcoin', 'eth', 'competes_with', sources[2]);
  named('mt. gox', 'ORG', 4); // covered by an archived page: put away, not missing
  rel.run('Bitcoin', 'Mt. Gox', 'related_to', sources[2]);
  return db;
}

describe('missing pages', () => {
  it('lists the same names in the same order on the graph and in wiki_status, at one threshold', () => {
    const db = seed();
    expect(getRelationEdges().missing).toEqual([
      { name: 'Vitalik Buterin', source_count: 3, page_ids: ['bitcoin', 'ethereum'] },
      { name: 'Satoshi Nakamoto', source_count: 3, page_ids: ['bitcoin'] },
    ]);
    expect(runHealthChecks(db).missing_cross_refs).toEqual([
      { entity_text: 'Vitalik Buterin', mention_count: 3 },
      { entity_text: 'Satoshi Nakamoto', mention_count: 3 },
      { entity_text: 'Hal Finney', mention_count: 5 },
    ]);
  });

  it('leaves out dates and amounts, and names a page or alias covers, archived pages included', () => {
    const db = seed();
    const names = findMissingPages(db, { minSources: 1, limit: 50 }).map((m) => m.name.toLowerCase());
    for (const covered of ['2009', '$20,000', 'eth', 'mt. gox', 'bitcoin', 'ethereum']) expect(names).not.toContain(covered);
  });

  it('counts only the mentions typed as a topic', () => {
    const db = seed();
    // Two more sources call Satoshi a date: they do not count toward the name.
    db.prepare(`INSERT INTO entity_mentions (canonical_name, source_id, entity_type) VALUES ('Satoshi Nakamoto', 'src-3', 'DATE'), ('Satoshi Nakamoto', 'src-4', 'date')`).run();
    expect(findMissingPages(db, { minSources: 1, limit: 50 }).find((m) => m.name === 'Satoshi Nakamoto')?.source_count).toBe(3);
  });

  it('stops at the limit, keeping the most named', () => {
    const db = seed();
    expect(findMissingPages(db, { minSources: 3, limit: 1 }).map((m) => m.name)).toEqual(['Vitalik Buterin']);
  });
});
