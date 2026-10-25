/**
 * replaceSourceMentions: the extract route swaps a source's entity_mentions
 * and relationship_mentions for the new extraction's in one transaction.
 * Before, the deletes and inserts ran one by one, so a failure in between
 * left the source with no mention rows while its extraction row stayed,
 * and the next compile would not extract it again.
 *
 * saveExtraction: the extract route also writes the extraction row and the
 * 'extracted' status in that transaction. Before, those were written first,
 * so a crash before the mention rows left the source extracted with none.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { POST as extractPOST } from '../app/api/compile/extract/route';
import { getExtraction, getSource, replaceSourceMentions } from '../lib/db';
import { seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('a failed mention write in extract leaves the source unextracted, so the retry extracts it again', async () => {
    handle = setupTestDb();
    const sid = seedSource(handle.db, { raw_markdown: 'Ethereum runs Solidity contracts.' });
    const replies: Record<string, unknown> = {
      '/extract/ner': { source_id: sid, entities: [], entity_count: 0, entity_density: 'low' },
      '/extract/route': { profile: 'default', methods: [], skip: [] },
      '/pipeline/extract-llm': {
        entities: [{ name: 'Ethereum', type: 'PRODUCT' }, { name: 'Solidity', type: 'PRODUCT' }],
        concepts: [],
        claims: [],
        relationships: [{ from_entity: 'Ethereum', to: 'Solidity', type: 'uses', description: 'Ethereum runs Solidity contracts.' }],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const suffix = Object.keys(replies).find((s) => String(input).endsWith(s));
      return suffix ? Response.json(replies[suffix]) : new Response('not found', { status: 404 });
    }));
    const extract = () =>
      extractPOST(new Request('http://test/api/compile/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_id: sid }),
      }));
    handle.db.exec(
      `CREATE TRIGGER fail_relations BEFORE INSERT ON relationship_mentions
       BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`
    );

    expect((await extract()).status).toBe(500);
    expect(getExtraction(sid)).toBeNull();
    expect(getSource(sid)?.compile_status).toBe('pending');
    expect(mentions()).toEqual({ entities: [], relations: [] });

    handle.db.exec('DROP TRIGGER fail_relations');
    expect((await extract()).status).toBe(200);
    expect(getSource(sid)?.compile_status).toBe('extracted');
    expect(mentions()).toEqual({
      entities: [`${sid}:Ethereum`, `${sid}:Solidity`],
      relations: [`${sid}:Ethereum uses Solidity (Ethereum runs Solidity contracts.)`],
    });
  });

  it('is how the extract route writes mentions, with the extraction (no separate deletes)', () => {
    const route = readFileSync(join(__dirname, '../app/api/compile/extract/route.ts'), 'utf8');
    const db = readFileSync(join(__dirname, '../lib/db.ts'), 'utf8');
    expect(route).toContain('saveExtraction(');
    expect(db).toMatch(/export function saveExtraction[\s\S]*?replaceSourceMentions\(data\.source_id,/);
    expect(route).not.toMatch(/delete(Entity|Relationship)MentionsForSource\(|replaceSourceMentions\(/);
    expect(route).not.toMatch(/insert(Entity|Relationship)Mentions\(|insertExtraction\(|markSourceExtracted\(/);
  });
});
