/**
 * Plan Rule 4 (plan 3.5): a comparison page counts competes_with and
 * contradicts together toward COMPARISON_SOURCE_THRESHOLD, on the canonical
 * names resolve leaves in the relation rows, and either end may be a
 * concept. One comparison plan per pair.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { POST as planPOST } from '../app/api/compile/plan/route';
import { setupTestDb, seedSource, seedExtraction, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

interface Group {
  canonical: string;
  type: string;
  aliases: string[];
  source_ids: string[];
  method: string;
}

interface PlanBody {
  pages: Array<{ plan_id: string; title: string; page_type: string; source_ids: string[]; related_plan_ids: string[] }>;
  stats: { comparison_pages: number; relationships_found: number; relationships_below_threshold: number };
}

const SESSION = 'sess-rivalry';

/** A session source naming `entities` (PRODUCT) and `concepts`, with one relation. */
function source(
  source_id: string,
  rel: { from_entity: string; to: string; type: string },
  entities: string[],
  concepts: string[] = [],
): string {
  seedSource(handle!.db, { source_id, onboarding_session_id: SESSION, compile_status: 'extracted', raw_markdown: 'x'.repeat(600) });
  seedExtraction(handle!.db, {
    source_id,
    llm_output: {
      entities: entities.map((name) => ({ name, type: 'PRODUCT' })),
      concepts: concepts.map((name) => ({ name, description: '' })),
      relationships: [{ ...rel, description: '' }],
    },
  });
  return source_id;
}

const group = (canonical: string, type: string, source_ids: string[], aliases: string[] = []): Group => ({
  canonical,
  type,
  aliases,
  source_ids,
  method: 'exact',
});

async function plan(canonical_entities: Group[], canonical_concepts: Group[] = []): Promise<PlanBody> {
  const res = await planPOST(
    new Request('http://test/api/compile/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: SESSION, canonical_entities, canonical_concepts }),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as PlanBody;
}

describe('Rule 4: competes_with and contradicts count together', () => {
  it('plans the comparison when two sources say compete and one says contradict', async () => {
    handle = setupTestDb();
    const ids = [
      source('s-1', { from_entity: 'Alpha', to: 'Beta', type: 'competes_with' }, ['Alpha', 'Beta']),
      source('s-2', { from_entity: 'Beta', to: 'Alpha', type: 'competes_with' }, ['Alpha', 'Beta']),
      source('s-3', { from_entity: 'Alpha', to: 'Beta', type: 'contradicts' }, ['Alpha', 'Beta']),
    ];

    const body = await plan([group('Alpha', 'PRODUCT', ids), group('Beta', 'PRODUCT', ids)]);

    const comparisons = body.pages.filter((p) => p.page_type === 'comparison');
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0].title).toBe('Alpha vs Beta');
    expect([...comparisons[0].source_ids].sort()).toEqual(ids);
  });

  it('makes one comparison plan for a pair that reaches the threshold with both types', async () => {
    handle = setupTestDb();
    const ids = ['c-1', 'c-2', 'c-3', 'd-1', 'd-2', 'd-3'].map((id) =>
      source(id, { from_entity: 'Alpha', to: 'Beta', type: id.startsWith('c') ? 'competes_with' : 'contradicts' }, ['Alpha', 'Beta']),
    );

    const body = await plan([group('Alpha', 'PRODUCT', ids), group('Beta', 'PRODUCT', ids)]);

    const comparisons = body.pages.filter((p) => p.page_type === 'comparison');
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0].source_ids).toHaveLength(6);
    expect(body.stats.relationships_found).toBe(1);
  });

  it('counts a row stored in the other order', async () => {
    handle = setupTestDb();
    const ids = [
      source('s-1', { from_entity: 'Alpha', to: 'Beta', type: 'competes_with' }, ['Alpha', 'Beta']),
      source('s-2', { from_entity: 'Alpha', to: 'Beta', type: 'competes_with' }, ['Alpha', 'Beta']),
      source('s-3', { from_entity: 'Alpha', to: 'Beta', type: 'contradicts' }, ['Alpha', 'Beta']),
    ];
    // A row from before relation rows were kept sorted.
    handle.db
      .prepare("UPDATE relationship_mentions SET from_canonical = 'Beta', to_canonical = 'Alpha' WHERE source_id = 's-3'")
      .run();

    const body = await plan([group('Alpha', 'PRODUCT', ids), group('Beta', 'PRODUCT', ids)]);

    expect(body.pages.filter((p) => p.page_type === 'comparison').map((p) => p.source_ids.length)).toEqual([3]);
  });

  it('stays below the threshold with two sources', async () => {
    handle = setupTestDb();
    const ids = [
      source('s-1', { from_entity: 'Alpha', to: 'Beta', type: 'competes_with' }, ['Alpha', 'Beta']),
      source('s-2', { from_entity: 'Alpha', to: 'Beta', type: 'contradicts' }, ['Alpha', 'Beta']),
    ];

    const body = await plan([group('Alpha', 'PRODUCT', ids), group('Beta', 'PRODUCT', ids)]);

    expect(body.stats.comparison_pages).toBe(0);
    expect(body.stats.relationships_below_threshold).toBe(1);
  });
});

describe('Rule 4: concept ends', () => {
  it('plans a comparison of two concepts, linked to both concept plans', async () => {
    handle = setupTestDb();
    const rel = { from_entity: 'Proof of Work', to: 'Proof of Stake', type: 'competes_with' };
    const ids = ['s-1', 's-2', 's-3'].map((id) => source(id, rel, [], ['Proof of Work', 'Proof of Stake']));

    const body = await plan([], [group('Proof of Work', 'CONCEPT', ids), group('Proof of Stake', 'CONCEPT', ids)]);

    const comparison = body.pages.find((p) => p.page_type === 'comparison');
    expect(comparison?.title).toBe('Proof of Stake vs Proof of Work');
    const related = body.pages.filter((p) => comparison?.related_plan_ids.includes(p.plan_id)).map((p) => p.title).sort();
    expect(related).toEqual(['Proof of Stake', 'Proof of Work']);
  });

  it('plans a comparison of an entity and a concept', async () => {
    handle = setupTestDb();
    const rel = { from_entity: 'Bitcoin', to: 'Fiat money', type: 'contradicts' };
    const ids = ['s-1', 's-2', 's-3'].map((id) => source(id, rel, ['Bitcoin'], ['Fiat money']));

    const body = await plan([group('Bitcoin', 'PRODUCT', ids)], [group('Fiat money', 'CONCEPT', ids)]);

    expect(body.pages.filter((p) => p.page_type === 'comparison').map((p) => p.title)).toEqual(['Bitcoin vs Fiat money']);
  });
});

describe('Rule 4: canonical names', () => {
  it('uses the name resolve gave the relation end, not the spelling a source used', async () => {
    handle = setupTestDb();
    const ids = ['s-1', 's-2', 's-3'].map((id) =>
      source(id, { from_entity: 'ETH', to: 'Bitcoin', type: 'competes_with' }, ['ETH', 'Bitcoin']),
    );
    // What resolve's mention rebuild leaves: ETH grouped under Ethereum.
    handle.db.prepare("UPDATE entity_mentions SET canonical_name = 'Ethereum' WHERE canonical_name = 'ETH'").run();
    handle.db.prepare("UPDATE relationship_mentions SET to_canonical = 'Ethereum' WHERE to_canonical = 'ETH'").run();
    handle.db.prepare("UPDATE relationship_mentions SET from_canonical = 'Ethereum' WHERE from_canonical = 'ETH'").run();

    const body = await plan([group('Ethereum', 'PRODUCT', ids, ['ETH']), group('Bitcoin', 'PRODUCT', ids)]);

    expect(body.pages.filter((p) => p.page_type === 'comparison').map((p) => p.title)).toEqual(['Bitcoin vs Ethereum']);
  });
});
