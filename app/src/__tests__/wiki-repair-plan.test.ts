/**
 * The wiki repair's plan and estimate (lib/wiki-repair/plan.ts, estimate.ts,
 * mentions.ts) and the dry run (GET /api/wiki/repair/plan): what a run would
 * do, worked out without changing anything, with the cost range on the
 * compile model.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as overviewGET } from '../app/api/wiki/repair/route';
import { GET as planGET } from '../app/api/wiki/repair/plan/route';
import { getDb, getSourceIdsMentioning, rebuildWikiMentions } from '../lib/db';
import { buildJudgePairs, judgeBatches, listAliasesToJudge } from '../lib/wiki-repair/aliases';
import { estimateRepair } from '../lib/wiki-repair/estimate';
import { MAX_REPAIR_ALIASES, REPAIR_ALIAS_BATCH } from '../lib/wiki-repair/limits';
import { mergePendingPages, readWikiExtractions } from '../lib/wiki-repair/mentions';
import { computeRepairPlan } from '../lib/wiki-repair/plan';
import { __resetWikiRepairStateForTesting } from '../lib/wiki-repair/state';
import { EF, ETH, PRICING, S, mockRepairNlp, seedRepairWiki } from './helpers/repair-wiki';
import { seedExtraction, seedPage, seedProvenance, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  __resetWikiRepairStateForTesting();
  handle?.cleanup();
  handle = null;
});

function snapshot(): string {
  const db = handle!.db;
  return JSON.stringify([
    db.prepare('SELECT * FROM aliases ORDER BY id').all(),
    db.prepare('SELECT canonical_name, source_id FROM entity_mentions ORDER BY source_id, canonical_name').all(),
    db.prepare('SELECT * FROM relationship_mentions ORDER BY source_id').all(),
    db.prepare('SELECT * FROM provenance ORDER BY id').all(),
    db.prepare('SELECT page_id, category, last_updated, pending_content FROM pages ORDER BY page_id').all(),
    db.prepare("SELECT * FROM settings WHERE key LIKE 'wiki_repair%'").all(),
    db.prepare('SELECT COUNT(*) AS n FROM activity_log').get(),
  ]);
}

describe('the repair plan', () => {
  it('names the set-aside matches to ask about, never retired ones, and the pages that change', () => {
    handle = setupTestDb();
    seedRepairWiki(handle.db);
    const plan = computeRepairPlan(handle.db);

    expect(plan.aliases.map((a) => a.alias)).toEqual(['ETH', 'The Ethereum Foundation', 'ETC']);
    expect(plan.aliases_over_cap).toBe(0);
    expect(plan.name_check_calls).toBe(1);
    expect(plan.sources).toBe(7);
    // "Ethereum" has its own page: three sources leave the foundation whatever
    // the AI says, so both pages change for certain.
    expect(plan.pages.map((p) => [p.page_id, p.certain])).toEqual([
      [ETH, true],
      [EF, true],
    ]);
    expect(plan.pages_low).toBe(2);
    expect(plan.pages_high).toBe(2);
    const ef = plan.pages.find((p) => p.page_id === EF)!;
    expect(ef.remove.sort()).toEqual([S.eth1, S.eth2, S.eth3, S.theEf, S.ethTicker].sort());
    expect(plan.pages.find((p) => p.page_id === ETH)!.add.sort()).toEqual([S.eth1, S.eth2, S.eth3].sort());
    expect(plan.labels.sort()).toEqual(['Crypto', 'Cryptocurrency']);
  });

  it("counts a page whose sources depend on the AI's answer as possible, not certain", () => {
    handle = setupTestDb();
    seedRepairWiki(handle.db);
    // Its one source reaches it only through a set-aside match: it keeps the
    // source if the AI confirms the match, and loses it if not.
    seedSource(handle.db, { source_id: 'src-vb', raw_markdown: 'Vitalik B wrote the white paper.' });
    seedExtraction(handle.db, { source_id: 'src-vb', llm_output: { entities: [{ name: 'Vitalik B', type: 'PERSON' }] } });
    handle.db.prepare("UPDATE entity_mentions SET canonical_name = 'Vitalik Buterin' WHERE source_id = 'src-vb'").run();
    seedPage(handle.db, { page_id: 'page-vb', title: 'Vitalik Buterin', page_type: 'entity' });
    seedProvenance(handle.db, 'page-vb', 'src-vb');
    handle.db.prepare("INSERT INTO aliases (alias, canonical_name, status) VALUES ('Vitalik B', 'Vitalik Buterin', 'suspended')").run();
    const plan = computeRepairPlan(handle.db);
    expect(plan.pages.find((p) => p.page_id === 'page-vb')?.certain).toBe(false);
    expect(plan.pages_low).toBe(2);
    expect(plan.pages_high).toBe(3);
  });

  it('is empty on a wiki with nothing to repair', () => {
    handle = setupTestDb();
    seedSource(handle.db, { source_id: 'a', raw_markdown: 'text' });
    seedExtraction(handle.db, { source_id: 'a', llm_output: { entities: [{ name: 'Rust', type: 'PRODUCT' }] } });
    const plan = computeRepairPlan(handle.db);
    expect(plan.aliases).toEqual([]);
    expect(plan.pages_high).toBe(0);
  });

  it(`asks about at most ${MAX_REPAIR_ALIASES} matches, ${REPAIR_ALIAS_BATCH} per call, entity and concept pairs apart`, () => {
    handle = setupTestDb();
    seedRepairWiki(handle.db);
    const insert = handle.db.prepare("INSERT INTO aliases (alias, canonical_name, status) VALUES (?, ?, 'suspended')");
    for (let i = 0; i < MAX_REPAIR_ALIASES + 7; i++) insert.run(`Name ${i}`, `Other ${i}`);
    const plan = computeRepairPlan(handle.db);
    expect(plan.aliases).toHaveLength(MAX_REPAIR_ALIASES);
    expect(plan.aliases_over_cap).toBe(3 + 7);
    const pairs = buildJudgePairs(handle.db, listAliasesToJudge(handle.db).slice(0, 25), readWikiExtractions(handle.db));
    const batches = judgeBatches(pairs);
    expect(batches.every((b) => b.length <= REPAIR_ALIAS_BATCH && new Set(b.map((p) => p.kind)).size === 1)).toBe(true);
    expect(plan.name_check_calls).toBe(Math.ceil(MAX_REPAIR_ALIASES / REPAIR_ALIAS_BATCH));
  });

  it('sends each side with its type and the context an extraction gives it', () => {
    handle = setupTestDb();
    seedRepairWiki(handle.db);
    const [pair] = buildJudgePairs(handle.db, listAliasesToJudge(handle.db).slice(0, 1), readWikiExtractions(handle.db));
    expect(pair.entity_a).toMatchObject({ name: 'ETH', type: 'PRODUCT', context: 'the coin of Ethereum' });
    expect(pair.entity_b).toMatchObject({ name: 'Ethereum Foundation', type: 'ORG' });
    expect(pair.same_source).toBe(false);
  });
});

describe('the estimate', () => {
  it('prices name checks, page rewrites and the label call, low end below high end', () => {
    handle = setupTestDb();
    seedRepairWiki(handle.db);
    const plan = computeRepairPlan(handle.db);
    const e = estimateRepair(plan.estimate_input, PRICING, 'deepseek-flash');
    expect(e.calls_low).toBe(1 + 2 + 1);
    expect(e.calls_high).toBe(1 + 2 + 1);
    expect(e.cost_usd_high).toBeGreaterThan(0);
    expect(e.cost_usd_low).toBeLessThanOrEqual(e.cost_usd_high);
    expect(e.minutes_low).toBeGreaterThanOrEqual(1);
    expect(e.minutes_high).toBeGreaterThanOrEqual(e.minutes_low);
  });

  it('makes no label call with fewer than two labels', () => {
    const e = estimateRepair({ nameCheckBatches: [], pagesLow: [], pagesHigh: [], labels: { count: 1, chars: 6 } }, PRICING, 'deepseek-flash');
    expect(e.calls_high).toBe(0);
    expect(e.cost_usd_high).toBe(0);
  });
});

describe('the dry run changes nothing', () => {
  it('GET /api/wiki/repair/plan lists the work with its cost, and the database is as it was', async () => {
    handle = setupTestDb();
    seedRepairWiki(handle.db);
    const nlp = mockRepairNlp(handle.db);
    const before = snapshot();
    const res = await planGET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { aliases: unknown[]; pages_high: number; estimate: { cost_usd_high: number } | null; model: { id: string } };
    expect(body.aliases).toHaveLength(3);
    expect(body.pages_high).toBe(2);
    expect(body.estimate?.cost_usd_high).toBeGreaterThan(0);
    expect(body.model.id).toBe('deepseek-flash');
    expect(snapshot()).toBe(before);
    expect(nlp.disambiguateBodies).toHaveLength(0);
    expect(nlp.draftBodies).toHaveLength(0);
  });

  it('GET /api/wiki/repair shows the plan and estimate, and says when there is nothing to do', async () => {
    handle = setupTestDb();
    seedRepairWiki(handle.db);
    mockRepairNlp(handle.db);
    const before = snapshot();
    const body = (await (await overviewGET(new Request('http://localhost/api/wiki/repair'))).json()) as {
      plan: { aliases: number; pages_low: number; pages_high: number; labels: number };
      nothing_to_do: boolean;
      estimate: unknown;
      busy: unknown;
    };
    expect(body.plan).toMatchObject({ aliases: 3, pages_low: 2, pages_high: 2, labels: 2 });
    expect(body.nothing_to_do).toBe(false);
    expect(body.estimate).not.toBeNull();
    expect(body.busy).toBeNull();
    expect(snapshot()).toBe(before);
  });

  it('says the cost cannot be estimated when the NLP service is down', async () => {
    handle = setupTestDb();
    seedRepairWiki(handle.db);
    const nlp = mockRepairNlp(handle.db);
    nlp.fail.pricing = 503;
    const body = (await (await overviewGET(new Request('http://localhost/api/wiki/repair'))).json()) as { estimate: unknown; estimate_error: string };
    expect(body.estimate).toBeNull();
    expect(body.estimate_error).toMatch(/cannot be estimated/);
  });
});

describe('re-crediting mentions wiki-wide', () => {
  it('rebuildWikiMentions rewrites any source, with or without a session, and skips removed ones', () => {
    handle = setupTestDb();
    seedRepairWiki(handle.db);
    const n = rebuildWikiMentions([
      { source_id: S.eth1, entities: [{ canonical_name: 'Ethereum', source_id: S.eth1, entity_type: 'PRODUCT' }], relations: [] },
      { source_id: 'gone', entities: [{ canonical_name: 'X', source_id: 'gone', entity_type: null }], relations: [] },
    ]);
    expect(n).toBe(1);
    expect(getSourceIdsMentioning('Ethereum')).toContain(S.eth1);
    expect(getSourceIdsMentioning('Ethereum Foundation')).not.toContain(S.eth1);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM entity_mentions WHERE source_id = 'gone'").get()).toEqual({ n: 0 });
  });

  it('folds a later run into the pages an earlier run left waiting', () => {
    const merged = mergePendingPages(
      [{ page_id: 'p', title: 'P', remove: ['a'], add: ['b'] }],
      [{ page_id: 'p', title: 'P', remove: ['b'], add: ['c'] }, { page_id: 'q', title: 'Q', remove: [], add: ['d'] }],
    );
    expect(merged).toEqual([
      { page_id: 'p', title: 'P', remove: ['a'], add: ['c'] },
      { page_id: 'q', title: 'Q', remove: [], add: ['d'] },
    ]);
  });
});
