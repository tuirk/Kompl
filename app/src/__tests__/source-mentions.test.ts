/**
 * replaceSourceMentions: the extract route swaps a source's entity_mentions
 * and relationship_mentions for the new extraction's in one transaction.
 * Before, the deletes and inserts ran one by one, so a failure in between
 * left the source with no mention rows while its extraction row stayed,
 * and the next compile would not extract it again.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceSourceMentions } from '../lib/db';
import { seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function mentions(): { entities: string[]; relations: string[] } {
  const db = handle!.db;
  return {
    entities: (
      db.prepare('SELECT source_id, canonical_name FROM entity_mentions ORDER BY source_id, canonical_name').all() as Array<{
        source_id: string;
        canonical_name: string;
      }>
    ).map((r) => `${r.source_id}:${r.canonical_name}`),
    relations: (
      db
        .prepare(
          `SELECT source_id, from_canonical, relationship_type, to_canonical, description
             FROM relationship_mentions ORDER BY source_id, from_canonical, to_canonical`
        )
        .all() as Array<{ source_id: string; from_canonical: string; relationship_type: string; to_canonical: string; description: string | null }>
    ).map((r) => `${r.source_id}:${r.from_canonical} ${r.relationship_type} ${r.to_canonical} (${r.description})`),
  };
}

function seedOldRows(): void {
  handle = setupTestDb();
  seedSource(handle.db, { source_id: 'src' });
  seedSource(handle.db, { source_id: 'other' });
  replaceSourceMentions(
    'src',
    [{ canonical_name: 'Bitcoin', source_id: 'src', entity_type: 'PRODUCT' }],
    [{ from_canonical: 'Bitcoin', to_canonical: 'Proof of work', relationship_type: 'uses', source_id: 'src', description: 'Old.' }]
  );
  replaceSourceMentions(
    'other',
    [{ canonical_name: 'Ethereum', source_id: 'other', entity_type: 'PRODUCT' }],
    [{ from_canonical: 'Ethereum', to_canonical: 'Solidity', relationship_type: 'uses', source_id: 'other', description: 'Kept.' }]
  );
}

describe('replaceSourceMentions', () => {
  it("replaces the source's rows and leaves other sources alone", () => {
    seedOldRows();
    replaceSourceMentions(
      'src',
      [{ canonical_name: 'Lightning Network', source_id: 'src', entity_type: 'PRODUCT' }],
      [{ from_canonical: 'Lightning Network', to_canonical: 'Bitcoin', relationship_type: 'part_of', source_id: 'src', description: 'New.' }]
    );
    expect(mentions()).toEqual({
      entities: ['other:Ethereum', 'src:Lightning Network'],
      relations: ['other:Ethereum uses Solidity (Kept.)', 'src:Lightning Network part_of Bitcoin (New.)'],
    });
  });

  it('keeps the old rows when a write fails part-way', () => {
    seedOldRows();
    const before = mentions();
    expect(() =>
      replaceSourceMentions(
        'src',
        [{ canonical_name: 'Lightning Network', source_id: 'src', entity_type: 'PRODUCT' }],
        // from_canonical is NOT NULL: this insert fails after the deletes and the entity insert ran
        [{ from_canonical: null as unknown as string, to_canonical: 'Bitcoin', relationship_type: 'part_of', source_id: 'src', description: null }]
      )
    ).toThrow(/NOT NULL/);
    expect(mentions()).toEqual(before);
  });

  it('is how the extract route writes mentions (no separate deletes)', () => {
    const route = readFileSync(join(__dirname, '../app/api/compile/extract/route.ts'), 'utf8');
    expect(route).toContain('replaceSourceMentions(source_id,');
    expect(route).not.toMatch(/delete(Entity|Relationship)MentionsForSource\(/);
    expect(route).not.toMatch(/insert(Entity|Relationship)Mentions\(/);
  });
});
