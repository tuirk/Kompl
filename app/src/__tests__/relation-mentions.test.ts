/**
 * Schema v28: relationship_mentions.description, the extract LLM's
 * one-sentence explanation of each relation.
 *
 * Covers:
 *   - the column exists in the test schema, and migrate.py adds it behind a
 *     PRAGMA guard at the version schema.sql is seeded with
 *   - the extract route's row builder (lib/relation-rows.ts) carries the
 *     description: trimmed, clipped to 300 chars, empty -> null; names pinned
 *     and competes_with/contradicts sorted as before
 *   - insertRelationshipMentions stores it, and a re-insert refreshes it
 *     without touching the other columns
 *   - the resolve mention rebuild keeps it through the rename, also when a
 *     variant without one collapses onto the canonical row
 *   - the backup export includes it
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAllRelationshipMentions, insertRelationshipMentions } from '../lib/db';
import { buildRelationRows, cleanRelationDescription, RELATION_DESCRIPTION_MAX_CHARS } from '../lib/relation-rows';
import { rebuildMentionsLikeResolve } from './helpers/rebuild-mentions';
import { seedExtraction, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

const gpt4Group = (source_id: string) => ({ canonical: 'GPT-4', type: 'PRODUCT', aliases: ['GPT 4'], source_ids: [source_id] });

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function descriptions(): Array<{ from: string; to: string; description: string | null }> {
  return (
    handle!.db
      .prepare(
        `SELECT from_canonical AS "from", to_canonical AS "to", description
           FROM relationship_mentions ORDER BY from_canonical, to_canonical`
      )
      .all() as Array<{ from: string; to: string; description: string | null }>
  );
}

describe('schema v28', () => {
  it('relationship_mentions has a nullable description column', () => {
    handle = setupTestDb();
    const cols = handle.db.prepare('PRAGMA table_info(relationship_mentions)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    const col = cols.find((c) => c.name === 'description');
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0);
  });

  it('migrate.py adds the column behind a PRAGMA guard at the version schema.sql is seeded with', () => {
    const migrate = readFileSync(join(__dirname, '../../../scripts/migrate.py'), 'utf8');
    const schema = readFileSync(join(__dirname, 'helpers/schema.sql'), 'utf8');
    const version = /^SCHEMA_VERSION = (\d+)/m.exec(migrate)?.[1];
    expect(Number(version)).toBeGreaterThanOrEqual(28);
    expect(schema).toContain(`VALUES ('schema_version', '${version}')`);
    expect(migrate).toContain('if current < 28:');
    expect(migrate).toContain('PRAGMA table_info(relationship_mentions)');
    expect(migrate).toContain('ALTER TABLE relationship_mentions ADD COLUMN description TEXT');
  });
});

describe('buildRelationRows (extract route)', () => {
  const pin = (name: string) => (name.toLowerCase() === 'gpt4' ? 'GPT-4' : name);

  it('carries the description, trimmed, clipped and empty -> null', () => {
    const long = `${'word '.repeat(80)}end.`;
    const rows = buildRelationRows(
      [
        { from_entity: ' Bitcoin ', to: 'Proof of work', type: 'uses', description: '  Bitcoin uses proof of work.  ' },
        { from_entity: 'Ethereum', to: 'Vitalik Buterin', type: 'created_by', description: '   ' },
        { from_entity: 'Solana', to: 'Rust', type: 'uses', description: long },
        { from_entity: 'Cardano', to: 'Haskell', type: 'uses' },
      ],
      'src-1',
      pin
    );
    expect(rows.map((r) => r.description)).toEqual([
      'Bitcoin uses proof of work.',
      null,
      expect.any(String),
      null,
    ]);
    expect(rows[2].description!.length).toBeLessThanOrEqual(RELATION_DESCRIPTION_MAX_CHARS);
    expect(rows[0]).toMatchObject({ from_canonical: 'Bitcoin', to_canonical: 'Proof of work', source_id: 'src-1' });
    expect(cleanRelationDescription(42)).toBeNull();
  });

  it('pins names and sorts competes_with / contradicts, keeping directional order', () => {
    const rows = buildRelationRows(
      [
        { from_entity: 'Zcash', to: 'Monero', type: 'competes_with', description: 'Both are privacy coins.' },
        { from_entity: 'Zcash', to: 'gpt4', type: 'contradicts', description: 'x' },
        { from_entity: 'Zcash', to: 'Monero', type: 'part_of', description: 'y' },
      ],
      's',
      pin
    );
    expect(rows.map((r) => [r.from_canonical, r.to_canonical, r.relationship_type])).toEqual([
      ['Monero', 'Zcash', 'competes_with'],
      ['GPT-4', 'Zcash', 'contradicts'],
      ['Zcash', 'Monero', 'part_of'],
    ]);
  });

  it('keeps one row per (from, to, type); a later duplicate only fills a missing description', () => {
    const rows = buildRelationRows(
      [
        { from_entity: 'A', to: 'B', type: 'uses', description: '' },
        { from_entity: 'a', to: 'b', type: 'uses', description: 'Second says it.' },
        { from_entity: 'A', to: 'B', type: 'uses', description: 'Third is ignored.' },
        { from_entity: '', to: 'B', type: 'uses', description: 'no from' },
        null,
        'junk',
      ],
      's',
      (n) => n
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from_canonical: 'A', to_canonical: 'B', description: 'Second says it.' });
    expect(buildRelationRows('not an array', 's', (n) => n)).toEqual([]);
  });
});

describe('insertRelationshipMentions with description', () => {
  it('stores it, refreshes it on a re-insert, and never clears it with null', () => {
    handle = setupTestDb();
    const source_id = seedSource(handle.db);
    insertRelationshipMentions([
      { from_canonical: 'Bitcoin', to_canonical: 'Proof of work', relationship_type: 'uses', source_id, description: 'First.' },
      { from_canonical: 'Ethereum', to_canonical: 'Solidity', relationship_type: 'uses', source_id },
    ]);
    expect(descriptions()).toEqual([
      { from: 'Bitcoin', to: 'Proof of work', description: 'First.' },
      { from: 'Ethereum', to: 'Solidity', description: null },
    ]);

    handle.db.prepare(`UPDATE relationship_mentions SET first_seen_at = '2026-01-01 00:00:00'`).run();
    insertRelationshipMentions([
      { from_canonical: 'bitcoin', to_canonical: 'PROOF OF WORK', relationship_type: 'uses', source_id, description: 'Refreshed.' },
      { from_canonical: 'Ethereum', to_canonical: 'Solidity', relationship_type: 'uses', source_id, description: null },
    ]);
    expect(descriptions()).toEqual([
      { from: 'Bitcoin', to: 'Proof of work', description: 'Refreshed.' },
      { from: 'Ethereum', to: 'Solidity', description: null },
    ]);
    const firstSeen = handle.db.prepare('SELECT DISTINCT first_seen_at AS t FROM relationship_mentions').all();
    expect(firstSeen).toEqual([{ t: '2026-01-01 00:00:00' }]);

    insertRelationshipMentions([
      { from_canonical: 'Bitcoin', to_canonical: 'Proof of work', relationship_type: 'uses', source_id, description: null },
    ]);
    expect(descriptions()[0].description).toBe('Refreshed.');
  });

  it('the resolve rebuild keeps the description through the rename', () => {
    handle = setupTestDb();
    const source_id = seedSource(handle.db, { onboarding_session_id: 'sess-1' });
    seedExtraction(handle.db, {
      source_id,
      llm_output: {
        entities: [{ name: 'GPT 4', type: 'PRODUCT' }, { name: 'OpenAI', type: 'ORG' }],
        relationships: [{ from_entity: 'GPT 4', to: 'OpenAI', type: 'created_by', description: 'GPT 4 was made by OpenAI.' }],
      },
    });
    rebuildMentionsLikeResolve('sess-1', [gpt4Group(source_id)]);
    expect(descriptions()).toEqual([{ from: 'GPT-4', to: 'OpenAI', description: 'GPT 4 was made by OpenAI.' }]);
  });

  it('the resolve rebuild keeps a sentence when a variant collapses onto the canonical row', () => {
    handle = setupTestDb();
    const source_id = seedSource(handle.db, { onboarding_session_id: 'sess-1' });
    seedExtraction(handle.db, {
      source_id,
      llm_output: {
        entities: [{ name: 'GPT-4', type: 'PRODUCT' }, { name: 'GPT 4', type: 'PRODUCT' }],
        relationships: [
          // from side: the variant without a sentence collapses onto the canonical
          { from_entity: 'GPT-4', to: 'OpenAI', type: 'created_by', description: 'OpenAI made GPT-4.' },
          { from_entity: 'GPT 4', to: 'OpenAI', type: 'created_by' },
          // to side: a later entry's sentence fills the first one's gap
          { from_entity: 'Azure', to: 'gpt 4', type: 'uses' },
          { from_entity: 'Azure', to: 'GPT-4', type: 'uses', description: 'Azure uses GPT-4.' },
          // both have one: the first entry's stays (buildRelationRows)
          { from_entity: 'GPT-4', to: 'Bing', type: 'part_of', description: 'Canonical sentence.' },
          { from_entity: 'GPT 4', to: 'Bing', type: 'part_of', description: 'Variant sentence.' },
        ],
      },
    });
    rebuildMentionsLikeResolve('sess-1', [gpt4Group(source_id)]);
    expect(descriptions()).toEqual([
      { from: 'Azure', to: 'GPT-4', description: 'Azure uses GPT-4.' },
      { from: 'GPT-4', to: 'Bing', description: 'Canonical sentence.' },
      { from: 'GPT-4', to: 'OpenAI', description: 'OpenAI made GPT-4.' },
    ]);
  });

  it('the backup export includes it', () => {
    handle = setupTestDb();
    const source_id = seedSource(handle.db);
    insertRelationshipMentions([
      { from_canonical: 'A', to_canonical: 'B', relationship_type: 'uses', source_id, description: 'A uses B.' },
    ]);
    expect(getAllRelationshipMentions()[0].description).toBe('A uses B.');
  });
});
