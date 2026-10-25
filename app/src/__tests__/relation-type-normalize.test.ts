/**
 * The extract LLM's relation `type` is a free string (DeepSeek's JSON mode
 * enforces no schema), so "Competes with" or "part-of" can come back. The
 * extract route's row builder (relation-rows.ts) stores the six prompt types
 * however they were spelled, so they are sorted, read two-way and counted
 * like the canonical spelling. Other types are kept as written, and the
 * description backfill still finds rows stored before this under the type
 * as the LLM wrote it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { countSourcesForRelationship, insertRelationshipMentions } from '../lib/db';
import { backfillRelationDescriptions } from '../lib/relation-backfill';
import { buildRelationRows, normalizeRelationType } from '../lib/relation-rows';
import { getPageConnections, getRelationEdges } from '../lib/relations';
import { seedPage, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe('normalizeRelationType', () => {
  it('reads case, space and hyphen variants of the six prompt types as that type', () => {
    expect(
      ['Uses', 'part of', 'competes with', 'Competes_With', 'PART-OF', ' created  by ', 'Related-To', 'CONTRADICTS', 'part _ of'].map(
        normalizeRelationType
      )
    ).toEqual(['uses', 'part_of', 'competes_with', 'competes_with', 'part_of', 'created_by', 'related_to', 'contradicts', 'part_of']);
  });

  it('maps a few synonyms of those types', () => {
    expect(
      ['utilizes', 'is part of', 'Competitor of', 'conflicts with', 'related', 'made by'].map(normalizeRelationType)
    ).toEqual(['uses', 'part_of', 'competes_with', 'contradicts', 'related_to', 'created_by']);
  });

  it('keeps inverse wordings and other types as written', () => {
    expect(
      ['used_by', 'Includes', 'Located in', 'influenced_by', '  founded-by ', 'constructor', '__proto__'].map(
        normalizeRelationType
      )
    ).toEqual(['used_by', 'Includes', 'Located in', 'influenced_by', 'founded-by', 'constructor', '__proto__']);
  });
});

describe('buildRelationRows with variant types', () => {
  it('stores the prompt type, sorted when direction-agnostic, one row per spelling', () => {
    const rows = buildRelationRows(
      [
        { from_entity: 'Bitcoin', to: 'Proof of work', type: 'Uses', description: 'First.' },
        { from_entity: 'Bitcoin', to: 'Proof of work', type: 'uses', description: 'Duplicate.' },
        { from_entity: 'Lightning', to: 'Bitcoin', type: 'part of' },
        { from_entity: 'Zcash', to: 'Monero', type: 'competes with' },
        { from_entity: 'Vilnius', to: 'Lithuania', type: 'Located in' },
      ],
      's',
      (n) => n
    );
    expect(rows.map((r) => [r.from_canonical, r.to_canonical, r.relationship_type, r.description])).toEqual([
      ['Bitcoin', 'Proof of work', 'uses', 'First.'],
      ['Lightning', 'Bitcoin', 'part_of', null],
      ['Monero', 'Zcash', 'competes_with', null],
      ['Vilnius', 'Lithuania', 'Located in', null],
    ]);
  });

  it('reads two-way and counts with the canonical spelling', () => {
    handle = setupTestDb();
    const db = handle.db;
    seedPage(db, { page_id: 'claude', title: 'Claude' });
    seedPage(db, { page_id: 'chatgpt', title: 'ChatGPT' });
    const extracted: Array<[string, string, string, string]> = [
      ['s1', 'Claude', 'ChatGPT', 'Competes with'],
      ['s2', 'ChatGPT', 'Claude', 'competes_with'],
      ['s3', 'Claude', 'ChatGPT', 'COMPETES-WITH'],
    ];
    for (const [source_id, from_entity, to, type] of extracted) {
      seedSource(db, { source_id });
      insertRelationshipMentions(buildRelationRows([{ from_entity, to, type }], source_id, (n) => n));
    }

    expect(countSourcesForRelationship('ChatGPT', 'Claude', 'competes_with')).toBe(3);
    expect(getRelationEdges().edges).toEqual([
      {
        source: 'chatgpt',
        target: 'claude',
        relations: [{ type: 'competes_with', direction: 'out', source_count: 3 }],
        wikilink: false,
        weight: 3,
      },
    ]);
    for (const [page, other] of [['claude', 'chatgpt'], ['chatgpt', 'claude']]) {
      expect(getPageConnections(page).groups).toMatchObject([
        { label: 'Competes with', items: [{ page_id: other, source_count: 3 }] },
      ]);
    }
  });
});

describe('description backfill and older rows', () => {
  it('still fills a row stored before this fix under the type as the LLM wrote it', () => {
    handle = setupTestDb();
    const db = handle.db;
    const source_id = seedSource(db, { source_id: 'old' });
    db.prepare(`INSERT INTO extractions (source_id, ner_output, profile, llm_output) VALUES (?, '{}', 'default', ?)`).run(
      source_id,
      JSON.stringify({
        relationships: [
          { from_entity: 'Zcash', to: 'Monero', type: 'Competes with', description: 'Both are privacy coins.' },
          { from_entity: 'Zcash', to: 'Bitcoin', type: 'Competes with', description: 'Zcash forked Bitcoin ideas.' },
        ],
      })
    );
    // As the extract route stored them before: type as written, never sorted.
    const insert = db.prepare(
      `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id) VALUES (?, ?, ?, ?)`
    );
    insert.run('Zcash', 'Monero', 'Competes with', source_id);
    insert.run('Zcash', 'Bitcoin', 'Competes with', source_id);

    expect(backfillRelationDescriptions(db)).toEqual({ filled: 2, unmatched: 0 });
  });
});
