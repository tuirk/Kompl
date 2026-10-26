/**
 * The connections read model (lib/relation-names.ts buildNameMap) and the
 * relation-description backfill use active aliases only, as getAliases()
 * does (schema v29; NULL status is active). A suspended or retired alias no
 * longer joins a relation's name to a page on the Connections card, the
 * graph or the MCP research pack, and the graph-report and wiki-health
 * caches notice a status change.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { setSourceStatus } from '../lib/db';
import { runHere } from '../lib/graph-betweenness';
import { graphReportCached } from '../lib/graph-report';
import { backfillRelationDescriptions } from '../lib/relation-backfill';
import { getPageConnections, getRelationEdges, getRelationsAmong, resolveNames } from '../lib/relations';
import { runHealthChecksCached } from '../lib/wiki-health';
import { seedPage, seedProvenance, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

/** Pages Bitcoin and Proof of work; one source says "BTC uses Proof of work"; alias BTC -> Bitcoin with `status`. */
function fixture(status: string | null): void {
  handle = setupTestDb();
  const db = handle.db;
  const src = seedSource(db, { source_id: 'src-1', title: 'Source 1' });
  seedPage(db, { page_id: 'bitcoin', title: 'Bitcoin', category: 'Crypto' });
  seedPage(db, { page_id: 'pow', title: 'Proof of work', page_type: 'concept', category: 'Crypto' });
  seedProvenance(db, 'bitcoin', src);
  seedProvenance(db, 'pow', src);
  db.prepare('INSERT INTO aliases (alias, canonical_name, canonical_page_id, status) VALUES (?, ?, ?, ?)').run(
    'BTC', 'Bitcoin', 'bitcoin', status
  );
  db.prepare(
    `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id, description)
     VALUES ('BTC', 'Proof of work', 'uses', 'src-1', 'BTC uses proof of work.')`
  ).run();
  setSourceStatus(src, 'active'); // resets the archived-pages cache
}

describe('connections read model', () => {
  it.each([['active'], [null]])('an active alias (%s) joins its name to the page', (status) => {
    fixture(status);
    expect(resolveNames(handle!.db).get('btc')).toBe('bitcoin');
    expect(getPageConnections('bitcoin').groups).toMatchObject([{ label: 'Uses', items: [{ page_id: 'pow' }] }]);
    expect(getRelationEdges().edges).toMatchObject([{ source: 'bitcoin', target: 'pow' }]);
    expect(getRelationsAmong(['bitcoin'], 12)).toHaveLength(1);
  });

  it.each([['suspended'], ['retired']])('a %s alias joins nothing: card, graph and MCP pack', (status) => {
    fixture(status);
    expect(resolveNames(handle!.db).get('btc')).toBeUndefined();
    expect(getPageConnections('bitcoin').groups).toEqual([]); // Connections card
    expect(getRelationEdges().edges).toEqual([]); // graph
    expect(getRelationsAmong(['bitcoin'], 12)).toEqual([]); // MCP research_topic
  });
});

describe('caches', () => {
  it('wiki-health and the graph report rebuild when an alias is set aside', async () => {
    fixture('active');
    const db = handle!.db;
    const checks = runHealthChecksCached(db);
    const report = await graphReportCached(db, runHere);
    expect(runHealthChecksCached(db)).toBe(checks);
    expect(await graphReportCached(db, runHere)).toBe(report);

    db.prepare(`UPDATE aliases SET status = 'suspended' WHERE alias = 'BTC'`).run();
    expect(runHealthChecksCached(db)).not.toBe(checks);
    expect(await graphReportCached(db, runHere)).not.toBe(report);
  });
});

describe('relation description backfill', () => {
  it.each([
    ['active', 2],
    ['suspended', 0],
    ['retired', 0],
  ] as const)('reads a row pinned through an alias only when the alias is active (%s)', (status, filled) => {
    handle = setupTestDb();
    const db = handle.db;
    const sid = seedSource(db);
    db.prepare('INSERT INTO aliases (alias, canonical_name, status) VALUES (?, ?, ?)').run('BTC', 'Bitcoin', status);
    db.prepare(`INSERT INTO extractions (source_id, ner_output, profile, llm_output) VALUES (?, '{}', 'default', ?)`).run(
      sid,
      JSON.stringify({
        relationships: [
          { from_entity: 'BTC', to: 'Proof of work', type: 'uses', description: 'BTC uses proof of work.' },
          { from_entity: 'Monero', to: 'RingCT', type: 'uses', description: 'Monero uses RingCT.' },
        ],
      })
    );
    const row = db.prepare(
      `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id) VALUES (?, ?, 'uses', ?)`
    );
    row.run('Bitcoin', 'Proof of work', sid); // pinned through the alias at extract time
    row.run('Zcash', 'Halo', sid); // matches nothing by name
    // With the alias, the first row matches by name and the last pair is left one-to-one;
    // without it, two rows and two relations stay unmatched and nothing is guessed.
    expect(backfillRelationDescriptions(db).filled).toBe(filled);
  });
});
