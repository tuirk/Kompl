/**
 * Page kind by majority (owner decision D6).
 *
 * A subject gets one plan whichever resolver bucket names it. A new page
 * takes the kind most of its sources give; an existing page changes kind
 * only when the other kind has at least two thirds of the sources and at
 * least three of them. Comparison and overview pages keep their own type.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { POST as planPOST } from '../app/api/compile/plan/route';
import { decidePageKind } from '../lib/page-kind';
import {
  setupTestDb,
  seedSource,
  seedExtraction,
  seedPage,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

interface PlannedPage {
  title: string;
  page_type: string;
  action: string;
  source_ids: string[];
  existing_page_id?: string;
}

interface Group {
  canonical: string;
  type: string;
  aliases: string[];
  source_ids: string[];
  method: string;
}

const group = (canonical: string, type: string, source_ids: string[]): Group => ({
  canonical,
  type,
  aliases: [],
  source_ids,
  method: 'none',
});

/** A source whose extraction names `name` as an entity of `type`, or as a concept. */
function source(session_id: string, name: string, type: string): string {
  const { db } = handle!;
  const source_id = seedSource(db, {
    onboarding_session_id: session_id,
    compile_status: session_id.startsWith('old') ? 'active' : 'extracted',
    raw_markdown: 'x'.repeat(900),
  });
  const llm_output =
    type === 'CONCEPT'
      ? { entities: [], concepts: [{ name, description: `${name} explained` }], relationships: [] }
      : { entities: [{ name, type }], concepts: [], relationships: [] };
  seedExtraction(db, { source_id, llm_output });
  return source_id;
}

async function topicPlans(
  session_id: string,
  canonical_entities: Group[],
  canonical_concepts: Group[],
): Promise<PlannedPage[]> {
  const resp = await planPOST(
    new Request('http://test/api/compile/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id, canonical_entities, canonical_concepts }),
    }),
  );
  expect(resp.status).toBe(200);
  const data = (await resp.json()) as { pages: PlannedPage[] };
  return data.pages.filter((p) => p.page_type !== 'source-summary' && p.page_type !== 'original-source');
}

describe('decidePageKind', () => {
  it('a new page takes the kind most sources give; a tie is an entity', () => {
    expect(decidePageKind(null, { entity: 2, concept: 1 })).toBe('entity');
    expect(decidePageKind(null, { entity: 1, concept: 2 })).toBe('concept');
    expect(decidePageKind(null, { entity: 1, concept: 1 })).toBe('entity');
  });

  it('an existing page flips only with two thirds of the sources and at least three', () => {
    expect(decidePageKind('entity', { entity: 1, concept: 3 })).toBe('concept');
    expect(decidePageKind('entity', { entity: 2, concept: 4 })).toBe('concept'); // exactly 2/3
    expect(decidePageKind('entity', { entity: 2, concept: 3 })).toBe('entity'); // 3 of 5
    expect(decidePageKind('entity', { entity: 0, concept: 2 })).toBe('entity'); // only 2
    expect(decidePageKind('concept', { entity: 3, concept: 1 })).toBe('entity');
    expect(decidePageKind('concept', { entity: 3, concept: 3 })).toBe('concept');
  });
});

describe('plan Rules 2 and 3: one plan per subject, kind by majority', () => {
  it('a subject in both buckets gets one plan, of the kind most sources give', async () => {
    handle = setupTestDb();
    const s = 'sess-sp';
    const asProduct = source(s, 'S&P 500', 'PRODUCT');
    const asConcept1 = source(s, 'S&P 500', 'CONCEPT');
    const asConcept2 = source(s, 'S&P 500', 'CONCEPT');

    const plans = await topicPlans(
      s,
      [group('S&P 500', 'PRODUCT', [asProduct])],
      [group('S&P 500', 'CONCEPT', [asConcept1, asConcept2])],
    );
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ title: 'S&P 500', page_type: 'concept', action: 'create' });
    expect(plans[0].source_ids.sort()).toEqual([asProduct, asConcept1, asConcept2].sort());
  });

  it('an entity page flips to concept when three of four sources call it a concept', async () => {
    handle = setupTestDb();
    const pageId = seedPage(handle.db, { page_id: 'apca', title: 'APCA', page_type: 'entity' });
    source('old-1', 'APCA', 'PRODUCT');
    source('old-2', 'APCA', 'CONCEPT');
    source('old-3', 'APCA', 'CONCEPT');
    const now = source('sess-apca', 'APCA', 'CONCEPT');

    const plans = await topicPlans('sess-apca', [], [group('APCA', 'CONCEPT', [now])]);
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ page_type: 'concept', action: 'update', existing_page_id: pageId });
  });

  it('an entity page stays an entity when three of five sources call it a concept', async () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'apca', title: 'APCA', page_type: 'entity' });
    source('old-1', 'APCA', 'PRODUCT');
    source('old-2', 'APCA', 'PRODUCT');
    source('old-3', 'APCA', 'CONCEPT');
    source('old-4', 'APCA', 'CONCEPT');
    const now = source('sess-apca', 'APCA', 'CONCEPT');

    const plans = await topicPlans('sess-apca', [], [group('APCA', 'CONCEPT', [now])]);
    expect(plans[0]).toMatchObject({ page_type: 'entity', action: 'update' });
  });

  it("a source's own extraction gives its kind, not the bucket its group landed in", async () => {
    handle = setupTestDb();
    const s = 'sess-merged';
    const sources = [source(s, 'Chroma', 'CONCEPT'), source(s, 'Chroma', 'CONCEPT'), source(s, 'Chroma', 'PRODUCT')];
    // Layer 3 merged names of both kinds into one group typed by its first name.
    const plans = await topicPlans(s, [group('Chroma', 'PRODUCT', sources)], []);
    expect(plans[0]).toMatchObject({ title: 'Chroma', page_type: 'concept' });
  });

  it('this session counts by its bucket where no mention is stored under the subject', async () => {
    handle = setupTestDb();
    source('old-1', 'Rollups', 'TECHNOLOGY');
    source('old-2', 'Rollups', 'TECHNOLOGY');
    // This session's sources name a variant spelling the resolver folded in.
    const s = 'sess-rollups';
    const now = [source(s, 'roll-ups', 'CONCEPT'), source(s, 'roll-ups', 'CONCEPT'), source(s, 'roll-ups', 'CONCEPT')];

    const plans = await topicPlans(s, [], [{ ...group('Rollups', 'CONCEPT', now), aliases: ['roll-ups'] }]);
    expect(plans[0]).toMatchObject({ title: 'Rollups', page_type: 'concept', action: 'create' });
  });

  it('an overview page with the same title keeps its type', async () => {
    handle = setupTestDb();
    const pageId = seedPage(handle.db, { page_id: 'a11y', title: 'Accessibility', page_type: 'overview' });
    const s = 'sess-a11y';
    const now = [source(s, 'Accessibility', 'CONCEPT'), source(s, 'Accessibility', 'CONCEPT'), source(s, 'Accessibility', 'CONCEPT')];

    const plans = await topicPlans(s, [], [group('Accessibility', 'CONCEPT', now)]);
    expect(plans[0]).toMatchObject({ page_type: 'overview', action: 'update', existing_page_id: pageId });
  });

  it("a source page with the subject's title is not turned into the subject's page", async () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'eth-article', title: 'Ethereum', page_type: 'source-summary' });
    const s = 'sess-eth';
    const now = [source(s, 'Ethereum', 'PRODUCT'), source(s, 'Ethereum', 'PRODUCT')];

    const plans = await topicPlans(s, [group('Ethereum', 'PRODUCT', now)], []);
    expect(plans[0]).toMatchObject({ title: 'Ethereum', page_type: 'entity', action: 'create' });
  });
});
