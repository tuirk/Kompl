/**
 * Comparison page threshold — compile/plan/route.ts:280-332.
 *
 * A 'comparison' page is only emitted when the SAME relationship pair appears
 * in COMPARISON_SOURCE_THRESHOLD (3) distinct sources. This prevents one
 * article's opinion ("X competes with Y") from spawning a synthesis page;
 * three independent sources noting the same rivalry is the bar.
 *
 * Both entities must also be in the resolved canonical_entities list — random
 * relationship targets that didn't survive entity resolution are filtered out.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { POST as planPOST } from '../app/api/compile/plan/route';
import { COMPARISON_SOURCE_THRESHOLD } from '../app/api/compile/plan/route';
import {
  setupTestDb,
  seedSource,
  seedExtraction,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

interface ResolvedGroup {
  canonical: string;
  type: string;
  aliases: string[];
  source_ids: string[];
  method: string;
}

interface PlanResponse {
  pages: Array<{ title: string; page_type: string; source_ids: string[] }>;
  stats: {
    comparison_pages: number;
    comparison_threshold: number;
    relationships_found: number;
    relationships_below_threshold: number;
  };
}

function planRequestWith(
  session_id: string,
  canonical_entities: ResolvedGroup[]
): Request {
  return new Request('http://test/api/compile/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id, canonical_entities }),
  });
}

// Helper: stand up N source rows and seed each with a relationship between
// `from` and `to` of the given type. Returns the list of source_ids.
function seedSourcesWithRelationship(
  db: TestDbHandle['db'],
  session_id: string,
  count: number,
  rel: { from_entity: string; to: string; type: string }
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const source_id = seedSource(db, {
      source_id: `src-${i}-${rel.type}`,
      onboarding_session_id: session_id,
      compile_status: 'pending',
      raw_markdown: 'x'.repeat(600), // > Gate 1 threshold so we're not testing Gate 1 here
    });
    seedExtraction(db, {
      source_id,
      llm_output: { concepts: [], relationships: [rel] },
    });
    ids.push(source_id);
  }
  return ids;
}

const ALPHA: ResolvedGroup = {
  canonical: 'Alpha',
  type: 'PRODUCT',
  aliases: ['alpha'],
  source_ids: ['src-0-competes_with', 'src-1-competes_with', 'src-2-competes_with'],
  method: 'exact',
};
const BETA: ResolvedGroup = {
  canonical: 'Beta',
  type: 'PRODUCT',
  aliases: ['beta'],
  source_ids: ['src-0-competes_with', 'src-1-competes_with', 'src-2-competes_with'],
  method: 'exact',
};

describe('Comparison page threshold', () => {
  it('exports COMPARISON_SOURCE_THRESHOLD = 3', () => {
    expect(COMPARISON_SOURCE_THRESHOLD).toBe(3);
  });

  it('does NOT emit a comparison page when only 2 sources share the relationship', async () => {
    handle = setupTestDb();
    const session_id = 'sess-cmp-2';
    seedSourcesWithRelationship(handle.db, session_id, 2, {
      from_entity: 'Alpha',
      to: 'Beta',
      type: 'competes_with',
    });

    const res = await planPOST(
      planRequestWith(session_id, [
        { ...ALPHA, source_ids: ['src-0-competes_with', 'src-1-competes_with'] },
        { ...BETA, source_ids: ['src-0-competes_with', 'src-1-competes_with'] },
      ])
    );
    const body = (await res.json()) as PlanResponse;

    expect(body.stats.comparison_pages).toBe(0);
    expect(body.stats.relationships_below_threshold).toBe(1);
    expect(body.pages.find((p) => p.page_type === 'comparison')).toBeUndefined();
  });

  it('emits a comparison page when 3 sources share the relationship', async () => {
    handle = setupTestDb();
    const session_id = 'sess-cmp-3';
    seedSourcesWithRelationship(handle.db, session_id, 3, {
      from_entity: 'Alpha',
      to: 'Beta',
      type: 'competes_with',
    });

    const res = await planPOST(planRequestWith(session_id, [ALPHA, BETA]));
    const body = (await res.json()) as PlanResponse;

    expect(body.stats.comparison_pages).toBe(1);
    expect(body.stats.relationships_below_threshold).toBe(0);

    const comparison = body.pages.find((p) => p.page_type === 'comparison');
    expect(comparison?.title).toBe('Alpha vs Beta');
  });

  it("treats 'contradicts' relationships the same as 'competes_with'", async () => {
    handle = setupTestDb();
    const session_id = 'sess-cmp-contradict';
    seedSourcesWithRelationship(handle.db, session_id, 3, {
      from_entity: 'Alpha',
      to: 'Beta',
      type: 'contradicts',
    });

    const res = await planPOST(
      planRequestWith(session_id, [
        { ...ALPHA, source_ids: ['src-0-contradicts', 'src-1-contradicts', 'src-2-contradicts'] },
        { ...BETA, source_ids: ['src-0-contradicts', 'src-1-contradicts', 'src-2-contradicts'] },
      ])
    );
    const body = (await res.json()) as PlanResponse;

    expect(body.stats.comparison_pages).toBe(1);
  });

  it("collapses 'A vs B' and 'B vs A' into one bucket", async () => {
    handle = setupTestDb();
    const session_id = 'sess-cmp-bidir';
    // 2 sources say "Alpha competes with Beta", 1 says "Beta competes with Alpha".
    // Sorted-name dedup collapses them to one bucket — should hit the threshold.
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const source_id = seedSource(handle.db, {
        source_id: `src-fwd-${i}`,
        onboarding_session_id: session_id,
        compile_status: 'pending',
        raw_markdown: 'x'.repeat(600),
      });
      seedExtraction(handle.db, {
        source_id,
        llm_output: {
          concepts: [],
          relationships: [{ from_entity: 'Alpha', to: 'Beta', type: 'competes_with' }],
        },
      });
      ids.push(source_id);
    }
    const reverse_id = seedSource(handle.db, {
      source_id: 'src-rev',
      onboarding_session_id: session_id,
      compile_status: 'pending',
      raw_markdown: 'x'.repeat(600),
    });
    seedExtraction(handle.db, {
      source_id: reverse_id,
      llm_output: {
        concepts: [],
        relationships: [{ from_entity: 'Beta', to: 'Alpha', type: 'competes_with' }],
      },
    });
    ids.push(reverse_id);

    const res = await planPOST(
      planRequestWith(session_id, [
        { ...ALPHA, source_ids: ids },
        { ...BETA, source_ids: ids },
      ])
    );
    const body = (await res.json()) as PlanResponse;

    expect(body.stats.comparison_pages).toBe(1);
  });

  it("ignores relationships whose entities aren't in canonical_entities", async () => {
    handle = setupTestDb();
    const session_id = 'sess-cmp-orphan';
    // 3 sources reference Alpha vs Gamma, but Gamma never made it to the
    // resolved entity list. The relationship must be dropped.
    seedSourcesWithRelationship(handle.db, session_id, 3, {
      from_entity: 'Alpha',
      to: 'Gamma',
      type: 'competes_with',
    });

    const res = await planPOST(
      planRequestWith(session_id, [
        { ...ALPHA, source_ids: ['src-0-competes_with', 'src-1-competes_with', 'src-2-competes_with'] },
        // No Gamma in canonical_entities
      ])
    );
    const body = (await res.json()) as PlanResponse;

    expect(body.stats.comparison_pages).toBe(0);
    expect(body.stats.relationships_found).toBe(0);
  });

  it('reports comparison_threshold = 3 in the stats response', async () => {
    handle = setupTestDb();
    const session_id = 'sess-cmp-stats';
    seedSource(handle.db, {
      onboarding_session_id: session_id,
      compile_status: 'pending',
      raw_markdown: 'x'.repeat(600),
    });

    const res = await planPOST(planRequestWith(session_id, []));
    const body = (await res.json()) as PlanResponse;

    expect(body.stats.comparison_threshold).toBe(3);
  });
});
