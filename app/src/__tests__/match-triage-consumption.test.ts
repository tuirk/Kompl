/**
 * Match-triage consumption + Rule 4 comparison canonicalization.
 *
 * Validates the next-PR scope after Flag 2:
 *   - Rule 6 now acts on match.decision = 'update' (emit update plan) and
 *     'contradiction' (log rich activity row and emit an update plan, plan
 *     3.5). One update plan per page takes every such source. 'skip'
 *     unchanged.
 *   - Rule 4 reads the relation rows resolve rebuilt on canonical names,
 *     so a relationship written "gpt 4 competes_with Claude" lands on the
 *     "Claude vs GPT-4" page instead of being silently dropped.
 *   - getPageContradictions(pageId) reads activity_log rows and returns
 *     the parsed details in newest-first order — the data the sidebar
 *     /api/wiki/[page_id]/contradictions route consumes.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { POST as planPOST } from '../app/api/compile/plan/route';
import {
  setupTestDb,
  seedSource,
  seedExtraction,
  seedPage,
  type TestDbHandle,
} from './helpers/test-db';
import { getPageContradictions, logActivity } from '../lib/db';

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

interface MatchEntry {
  source_id: string;
  page_id: string;
  page_title: string;
  decision: string;
  reason: string;
}

interface PlanResponse {
  pages: Array<{
    title: string;
    page_type: string;
    action: string;
    existing_page_id?: string;
    source_ids: string[];
  }>;
  stats: Record<string, number>;
}

function planRequest(body: Record<string, unknown>): Request {
  return new Request('http://test/api/compile/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 6 — match-triage consumption
// ─────────────────────────────────────────────────────────────────────────────

describe("Rule 6 — match.decision='update' emits update plan", () => {
  it('emits an update plan pointing at the matched existing page', async () => {
    handle = setupTestDb();
    const { db } = handle;
    const session_id = 'sess-update';

    const pageId = seedPage(db, {
      page_id: 'scaling-laws-page',
      title: 'LLM scaling laws',
      page_type: 'entity',
    });
    const sourceId = seedSource(db, {
      onboarding_session_id: session_id,
      compile_status: 'extracted',
      raw_markdown: 'x'.repeat(600),
    });
    seedExtraction(db, {
      source_id: sourceId,
      llm_output: { entities: [], concepts: [], relationships: [] },
    });

    const matches: MatchEntry[] = [
      {
        source_id: sourceId,
        page_id: pageId,
        page_title: 'LLM scaling laws',
        decision: 'update',
        reason: 'source adds Chinchilla results to the scaling section',
      },
    ];

    const resp = await planPOST(planRequest({ session_id, canonical_entities: [], matches }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as PlanResponse;
    const updatePlans = data.pages.filter((p) => p.action === 'update' && p.existing_page_id === pageId);
    expect(updatePlans).toHaveLength(1);
    expect(updatePlans[0].source_ids).toEqual([sourceId]);
  });
});

describe("Rule 6 — match.decision='contradiction' plans an update and writes the activity row", () => {
  it('logs page_contradiction_detected with full payload and plans an update of the page with the source', async () => {
    handle = setupTestDb();
    const { db } = handle;
    const session_id = 'sess-contradict';

    const pageId = seedPage(db, {
      page_id: 'gpt4-page',
      title: 'GPT-4',
      page_type: 'entity',
    });
    const sourceId = seedSource(db, {
      source_id: 'src-contra',
      title: 'Older GPT-4 whitepaper',
      source_type: 'url',
      source_url: 'https://example.test/whitepaper',
      onboarding_session_id: session_id,
      compile_status: 'extracted',
      raw_markdown: 'x'.repeat(600),
    });
    seedExtraction(db, {
      source_id: sourceId,
      llm_output: { entities: [], concepts: [], relationships: [] },
    });

    const matches: MatchEntry[] = [
      {
        source_id: sourceId,
        page_id: pageId,
        page_title: 'GPT-4',
        decision: 'contradiction',
        reason: 'source claims 32k context; page says 128k',
      },
    ];

    const resp = await planPOST(planRequest({ session_id, canonical_entities: [], matches }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as PlanResponse;

    // One update plan carries the source, so the draft can write the
    // disagreement into the page; the page keeps its type.
    const anyForPair = data.pages.filter(
      (p) => p.existing_page_id === pageId && p.source_ids.includes(sourceId)
    );
    expect(anyForPair).toEqual([
      expect.objectContaining({ title: 'GPT-4', page_type: 'entity', action: 'update', source_ids: [sourceId] }),
    ]);

    // Activity row written with the full details shape the sidebar relies on.
    const row = db
      .prepare(
        `SELECT details FROM activity_log WHERE action_type = 'page_contradiction_detected' LIMIT 1`
      )
      .get() as { details: string } | undefined;
    expect(row).toBeDefined();
    const d = JSON.parse(row!.details) as Record<string, unknown>;
    expect(d.page_id).toBe(pageId);
    expect(d.page_title).toBe('GPT-4');
    expect(d.source_title).toBe('Older GPT-4 whitepaper');
    expect(d.source_url).toBe('https://example.test/whitepaper');
    expect(d.source_type).toBe('url');
    expect(typeof d.date_ingested).toBe('string');
    expect(d.reason).toBe('source claims 32k context; page says 128k');
    expect(d.session_id).toBe(session_id);
    expect(typeof d.detected_at).toBe('string');

    // And it is a possible disagreement in the record, keyed on the new source.
    const found = db
      .prepare(`SELECT found_by, kind, status, source_b, reason FROM disagreements WHERE page_id = ?`)
      .all(pageId);
    expect(found).toEqual([
      { found_by: 'triage', kind: 'contradiction', status: 'possible', source_b: sourceId, reason: 'source claims 32k context; page says 128k' },
    ]);
  });
});

describe('Rule 6 — one update plan per page', () => {
  const extracted = (session_id: string, source_id: string, entities: string[]) => {
    seedSource(handle!.db, { source_id, onboarding_session_id: session_id, compile_status: 'extracted', raw_markdown: 'x'.repeat(600) });
    seedExtraction(handle!.db, {
      source_id,
      llm_output: { entities: entities.map((name) => ({ name, type: 'PRODUCT' })), concepts: [], relationships: [] },
    });
  };
  const verdictFor = (source_id: string, decision: string): MatchEntry => ({
    source_id,
    page_id: 'gpt4-page',
    page_title: 'GPT-4',
    decision,
    reason: 'r',
  });

  it('a contradiction joins the update Rule 2 already plans for the page', async () => {
    handle = setupTestDb();
    const session_id = 'sess-join';
    seedPage(handle.db, { page_id: 'gpt4-page', title: 'GPT-4', page_type: 'entity' });
    extracted(session_id, 's-1', ['GPT-4']);
    extracted(session_id, 's-2', ['GPT-4']);
    extracted(session_id, 's-3', []);
    const canonical_entities: ResolvedGroup[] = [
      { canonical: 'GPT-4', type: 'PRODUCT', aliases: [], source_ids: ['s-1', 's-2'], method: 'existing_page_title' },
    ];

    const resp = await planPOST(
      planRequest({ session_id, canonical_entities, matches: [verdictFor('s-3', 'contradiction')] }),
    );
    const data = (await resp.json()) as PlanResponse;

    const forPage = data.pages.filter((p) => p.existing_page_id === 'gpt4-page');
    expect(forPage).toHaveLength(1);
    expect([...forPage[0].source_ids].sort()).toEqual(['s-1', 's-2', 's-3']);
  });

  it('an update and a contradiction from two sources make one plan with both', async () => {
    handle = setupTestDb();
    const session_id = 'sess-two';
    seedPage(handle.db, { page_id: 'gpt4-page', title: 'GPT-4', page_type: 'concept' });
    extracted(session_id, 's-a', []);
    extracted(session_id, 's-b', []);

    const resp = await planPOST(
      planRequest({
        session_id,
        canonical_entities: [],
        matches: [verdictFor('s-a', 'update'), verdictFor('s-b', 'contradiction')],
      }),
    );
    const data = (await resp.json()) as PlanResponse;

    expect(data.pages.filter((p) => p.existing_page_id === 'gpt4-page')).toEqual([
      expect.objectContaining({ action: 'update', page_type: 'concept', source_ids: ['s-a', 's-b'] }),
    ]);
  });
});

describe('getPageContradictions helper', () => {
  it('returns activity rows for a page in newest-first order with fields parsed', () => {
    handle = setupTestDb();
    const { db } = handle;
    const pageId = seedPage(db, { page_id: 'p1', title: 'Test page', page_type: 'entity' });
    seedPage(db, { page_id: 'p2', title: 'Other page', page_type: 'entity' }); // noise

    // Two rows for p1 at different times.
    logActivity('page_contradiction_detected', {
      source_id: 's1',
      details: {
        page_id: pageId,
        page_title: 'Test page',
        source_title: 'First contradicting source',
        source_url: null,
        source_type: 'note',
        date_ingested: '2026-04-20T10:00:00.000Z',
        reason: 'first reason',
        session_id: 'sess-x',
        detected_at: '2026-04-20T12:00:00.000Z',
      },
    });
    logActivity('page_contradiction_detected', {
      source_id: 's2',
      details: {
        page_id: pageId,
        page_title: 'Test page',
        source_title: 'Second contradicting source',
        source_url: 'https://two.test',
        source_type: 'url',
        date_ingested: '2026-04-22T10:00:00.000Z',
        reason: 'second reason',
        session_id: 'sess-y',
        detected_at: '2026-04-22T12:00:00.000Z',
      },
    });
    // Noise: different page, should not appear.
    logActivity('page_contradiction_detected', {
      source_id: 's3',
      details: {
        page_id: 'p2',
        page_title: 'Other page',
        source_title: 'noise',
        source_url: null,
        source_type: 'note',
        date_ingested: null,
        reason: 'noise',
        session_id: 'sess-z',
        detected_at: '2026-04-21T12:00:00.000Z',
      },
    });

    const items = getPageContradictions(pageId);
    expect(items).toHaveLength(2);
    // Newest first by activity_log timestamp (rowid-implicit when sqlite tiebreaks).
    expect(items[0].reason).toBe('second reason');
    expect(items[0].source_url).toBe('https://two.test');
    expect(items[1].reason).toBe('first reason');
    // p2 row excluded.
    expect(items.every((i) => i.session_id !== 'sess-z')).toBe(true);
    void db;
  });
});

describe("Rule 6 — match.decision='skip' unchanged", () => {
  it('still emits a provenance-only plan (regression guard)', async () => {
    handle = setupTestDb();
    const { db } = handle;
    const session_id = 'sess-skip';

    const pageId = seedPage(db, { page_id: 'p-skip', title: 'Skip target', page_type: 'entity' });
    const sourceId = seedSource(db, {
      onboarding_session_id: session_id,
      compile_status: 'extracted',
      raw_markdown: 'x'.repeat(600),
    });
    seedExtraction(db, {
      source_id: sourceId,
      llm_output: { entities: [], concepts: [], relationships: [] },
    });

    const matches: MatchEntry[] = [
      {
        source_id: sourceId,
        page_id: pageId,
        page_title: 'Skip target',
        decision: 'skip',
        reason: 'already covered',
      },
    ];

    const resp = await planPOST(planRequest({ session_id, canonical_entities: [], matches }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as PlanResponse;
    const provOnly = data.pages.filter((p) => p.action === 'provenance-only');
    expect(provOnly).toHaveLength(1);
    expect(provOnly[0].existing_page_id).toBe(pageId);
    expect(provOnly[0].source_ids).toEqual([sourceId]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rule 4 — comparison relationship canonicalization
// ─────────────────────────────────────────────────────────────────────────────

describe('Rule 4 — non-canonical relationship endpoint survives filter', () => {
  it('reads the canonical names resolve left on the relation rows and emits comparison plan', async () => {
    handle = setupTestDb();
    const { db } = handle;
    const session_id = 'sess-rel';

    // Need ≥ COMPARISON_SOURCE_THRESHOLD (3) sources with the same relationship
    // for a comparison plan to emit. Each source seeds identical llm.relationships.
    const sourceIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const sid = seedSource(db, {
        source_id: `s-rel-${i}`,
        onboarding_session_id: session_id,
        compile_status: 'extracted',
        raw_markdown: 'x'.repeat(600),
      });
      sourceIds.push(sid);
      seedExtraction(db, {
        source_id: sid,
        llm_output: {
          entities: [
            { name: 'GPT-4', type: 'PRODUCT' },
            { name: 'Claude', type: 'PRODUCT' },
          ],
          concepts: [],
          relationships: [
            // Variant spelling on from_entity; resolve renames the row below.
            { from_entity: 'gpt 4', to: 'Claude', type: 'competes_with', description: '' },
          ],
        },
      });
    }

    // Simulate what resolve's mention rebuild does in production after it
    // groups "gpt 4" under "GPT-4": the relationship_mentions rows carry the
    // canonical spelling. The seedExtraction test helper writes raw
    // spellings; production's resolve step canonicalises them before plan
    // runs.
    db.prepare(
      `UPDATE relationship_mentions
          SET from_canonical = 'GPT-4'
        WHERE from_canonical = 'gpt 4' COLLATE NOCASE`
    ).run();
    db.prepare(
      `UPDATE relationship_mentions
          SET to_canonical = 'GPT-4'
        WHERE to_canonical = 'gpt 4' COLLATE NOCASE`
    ).run();

    // canonicalEntities mirror what the resolver would hand us: GPT-4 with
    // 'gpt 4' as a known alias.
    const canonical_entities: ResolvedGroup[] = [
      {
        canonical: 'GPT-4',
        type: 'PRODUCT',
        aliases: ['gpt 4'],
        source_ids: sourceIds,
        method: 'existing_page_title',
      },
      {
        canonical: 'Claude',
        type: 'PRODUCT',
        aliases: [],
        source_ids: sourceIds,
        method: 'none',
      },
    ];

    const resp = await planPOST(planRequest({ session_id, canonical_entities }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as PlanResponse;

    const comparisonPlans = data.pages.filter((p) => p.page_type === 'comparison');
    expect(comparisonPlans).toHaveLength(1);
    // Lowercase alphabetical sort means Claude (c) < GPT-4 (g).
    expect(comparisonPlans[0].title).toBe('Claude vs GPT-4');
  });
});

describe('Rule 4 — endpoint not in canonicalEntities is still filtered out', () => {
  it('regression guard — an end that is no resolved subject drops the pair', async () => {
    handle = setupTestDb();
    const { db } = handle;
    const session_id = 'sess-rel-filter';

    for (let i = 0; i < 3; i++) {
      const sid = seedSource(db, {
        source_id: `s-filter-${i}`,
        onboarding_session_id: session_id,
        compile_status: 'extracted',
        raw_markdown: 'x'.repeat(600),
      });
      seedExtraction(db, {
        source_id: sid,
        llm_output: {
          entities: [{ name: 'GPT-4', type: 'PRODUCT' }],
          concepts: [],
          // "Bard" is never in canonicalEntities — filter should drop the whole relation.
          relationships: [{ from_entity: 'GPT-4', to: 'Bard', type: 'competes_with', description: '' }],
        },
      });
    }

    const canonical_entities: ResolvedGroup[] = [
      {
        canonical: 'GPT-4',
        type: 'PRODUCT',
        aliases: [],
        source_ids: ['s-filter-0', 's-filter-1', 's-filter-2'],
        method: 'none',
      },
    ];

    const resp = await planPOST(planRequest({ session_id, canonical_entities }));
    expect(resp.status).toBe(200);
    const data = (await resp.json()) as PlanResponse;
    expect(data.pages.filter((p) => p.page_type === 'comparison')).toHaveLength(0);
  });
});
