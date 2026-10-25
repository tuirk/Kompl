/**
 * One disagreement, one finding (lib/claim-check/record-finding.ts,
 * lib/disagreement-duplicates.ts). The claim check keys its findings by page,
 * kind and the two SOURCES, not the claim pair, so two claim pairs between
 * the same sources are one finding; a pair the page's own open Changed or
 * Disputed section already cites is not recorded again (its quotes and
 * reason go on that section's finding instead). Duplicates stored by earlier
 * runs stay in the table, but the page panel, MCP read_page, recent changes
 * and wiki_status show one finding each. Owner verdicts are never touched.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as changesGET } from '../app/api/wiki/changes/route';
import { wikiCheckFindings } from '../lib/claim-check/verdicts';
import { runClaimCheck } from '../lib/claim-check/run';
import { panelDisagreements, pageDisagreementsOut } from '../lib/disagreement-view';
import {
  getDisagreement,
  listPageDisagreements,
  recordDisagreement,
  setOwnerVerdict,
  syncPageTextDisagreements,
} from '../lib/disagreements';
import { findPageDisputes } from '../lib/page-disputes';
import { seedExtraction, seedPage, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

const DW = 'src-datawrapper';
const RS = 'src-roselli';
const W3 = 'src-w3c';
const APCA = { page_id: 'p-apca', title: 'APCA' };

/** The judge: every pair gets `verdict`, its reason naming side a's claim. */
function stubJudge(verdict: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (!String(url).endsWith('/pipeline/judge-claims')) throw new Error(`unexpected fetch: ${String(url)}`);
      const body = JSON.parse(String(init?.body)) as { pairs: Array<{ pair_id: string; a: { claim: string }; b: { claim: string } }> };
      const items = body.pairs.map((p) => ({
        pair_id: p.pair_id,
        topic: 'contrast method',
        reason: `about: ${p.a.claim} / ${p.b.claim}`,
        verdict,
        newer: verdict === 'outdated' ? 'b' : null,
      }));
      return new Response(JSON.stringify({ items, count: items.length }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

function source(id: string, published: string, claims: Array<{ claim: string; quote?: string }>): void {
  const { db } = handle!;
  seedSource(db, { source_id: id, title: `Title ${id}`, compile_status: 'active' });
  db.prepare(`UPDATE sources SET published_at = ?, published_at_source = 'page_published' WHERE source_id = ?`).run(published, id);
  seedExtraction(db, {
    source_id: id,
    llm_output: {
      claims: claims.map((c) => ({
        claim: c.claim,
        confidence: 'stated',
        entities_involved: ['APCA'],
        quote: c.quote ?? null,
        quote_verified: c.quote ? true : null,
      })),
    },
  });
}

/** The film's APCA shape: two Datawrapper claims, one Roselli claim, so two claim pairs between the same two sources. */
function seedApca(dwQuotes: [string | undefined, string | undefined] = ['DW quote one.', 'DW quote two.']): void {
  handle = setupTestDb();
  seedPage(handle.db, { ...APCA, page_type: 'concept' });
  source(DW, '2021-01-01', [
    { claim: 'APCA will replace the WCAG 2 contrast ratio.', quote: dwQuotes[0] },
    { claim: 'APCA is the contrast method of WCAG 3.', quote: dwQuotes[1] },
  ]);
  source(RS, '2023-06-01', [{ claim: 'APCA was dropped from the WCAG 3 draft.', quote: 'RS quote.' }]);
  seedSource(handle.db, { source_id: W3, title: `Title ${W3}`, compile_status: 'active' });
  for (let i = 0; i < 8; i++) {
    const id = `filler-${i}`;
    seedSource(handle.db, { source_id: id, compile_status: 'active' });
    seedExtraction(handle.db, { source_id: id, llm_output: { claims: [{ claim: `Unrelated ${i}.`, confidence: 'stated', entities_involved: [`Thing ${i}`] }] } });
  }
}

const CHANGED_TEXT = `### Changed: APCA in WCAG 3\n\nPlanned for WCAG 3[^${DW}][^${W3}]; later dropped from the draft[^${RS}].`;
const DISPUTED_TEXT = `### Disputed: APCA in WCAG 3\n\nPart of WCAG 3[^${DW}] or not[^${RS}].`;

const run = () => runClaimCheck({ found_by: 'wiki_check', model: 'deepseek-flash', maxPairs: 600 });

describe('claim-check findings: one per page, kind and pair of sources', () => {
  it('two claim pairs between the same two sources are one finding; both verdicts are kept', async () => {
    seedApca();
    stubJudge('outdated');

    const summary = await run();

    expect(summary).toMatchObject({ judged: 2, findings: 1, by_kind: { changed: 1 } });
    const rows = listPageDisagreements(APCA.page_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ found_by: 'wiki_check', kind: 'changed', source_a: DW, source_b: RS, quote_b: 'RS quote.' });
    expect(rows[0].match_key).toBe(`sources:changed:${DW}|${RS}`);
    expect(handle!.db.prepare('SELECT COUNT(*) AS n FROM claim_verdicts').get()).toEqual({ n: 2 });
  });

  it('keeps the quotes and reason of the pair with more checked quotes', async () => {
    seedApca(['DW quote one.', undefined]);
    stubJudge('outdated');

    await run();

    const [row] = listPageDisagreements(APCA.page_id);
    expect(row).toMatchObject({ quote_a: 'DW quote one.', quote_b: 'RS quote.' });
    expect(row.reason).toContain('APCA will replace the WCAG 2 contrast ratio.');
  });

  it('APCA: the page text cites both sources, so the claim check adds nothing and lends its quotes and reason', async () => {
    seedApca();
    syncPageTextDisagreements(handle!.db, APCA, CHANGED_TEXT);
    stubJudge('outdated');

    const summary = await run();

    expect(summary).toMatchObject({ judged: 2, findings: 0, by_kind: {} });
    const rows = listPageDisagreements(APCA.page_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ found_by: 'page_text', kind: 'changed', status: 'possible', source_a: DW, source_b: RS, quote_b: 'RS quote.' });
    expect(rows[0].reason).toMatch(/^about: /);
    expect(rows[0].source_ids).toEqual([DW, W3, RS]);
  });

  it('WCAG 3: a disputed claim pair the page text already disputes is one finding', async () => {
    seedApca();
    syncPageTextDisagreements(handle!.db, APCA, DISPUTED_TEXT);
    stubJudge('disputed');

    await run();

    expect(listPageDisagreements(APCA.page_id)).toEqual([expect.objectContaining({ found_by: 'page_text', kind: 'disputed' })]);
  });

  it('never overwrites what the page-text finding holds, nor the owner verdict', async () => {
    seedApca();
    syncPageTextDisagreements(handle!.db, APCA, CHANGED_TEXT);
    const [text] = listPageDisagreements(APCA.page_id);
    handle!.db.prepare(`UPDATE disagreements SET reason = 'kept', quote_a = 'kept quote' WHERE disagreement_id = ?`).run(text.disagreement_id);
    setOwnerVerdict(text.disagreement_id, 'confirmed');
    stubJudge('outdated');

    await run();

    expect(getDisagreement(text.disagreement_id)).toMatchObject({
      reason: 'kept',
      quote_a: 'kept quote',
      source_a: null,
      quote_b: null,
      status: 'confirmed',
      owner_verdict: 'confirmed',
    });
  });

  it('records the finding when the owner dismissed the page-text one', async () => {
    seedApca();
    syncPageTextDisagreements(handle!.db, APCA, CHANGED_TEXT);
    setOwnerVerdict(listPageDisagreements(APCA.page_id)[0].disagreement_id, 'dismissed');
    stubJudge('outdated');

    const summary = await run();

    expect(summary.findings).toBe(1);
    expect(listPageDisagreements(APCA.page_id).map((r) => [r.found_by, r.status])).toEqual([
      ['page_text', 'dismissed'],
      ['wiki_check', 'possible'],
    ]);
  });

  it('refreshes a finding an earlier run stored under its claim-pair key instead of adding one', async () => {
    seedApca();
    const legacy = recordDisagreement(handle!.db, {
      page_id: APCA.page_id,
      found_by: 'wiki_check',
      kind: 'changed',
      key: 'claims:old-pair',
      source_a: DW,
      source_b: RS,
    });
    setOwnerVerdict(legacy.disagreement_id, 'confirmed');
    stubJudge('outdated');

    await run();

    const rows = listPageDisagreements(APCA.page_id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ disagreement_id: legacy.disagreement_id, match_key: 'claims:old-pair', status: 'confirmed', quote_b: 'RS quote.' });
  });
});

describe('duplicates stored by earlier runs: shown once', () => {
  /** What the film run left on APCA: the page's Changed section and two claim-pair findings. */
  function seedFilmRows(): { first: string; second: string } {
    seedApca();
    const db = handle!.db;
    syncPageTextDisagreements(db, APCA, CHANGED_TEXT);
    const finding = (key: string) =>
      recordDisagreement(db, { page_id: APCA.page_id, found_by: 'claim_check', kind: 'changed', key, source_a: DW, source_b: RS, reason: key })
        .disagreement_id;
    return { first: finding('claims:pair-1'), second: finding('claims:pair-2') };
  }

  it('page panel and MCP read_page: one finding on APCA', () => {
    seedFilmRows();
    const records = listPageDisagreements(APCA.page_id);
    expect(records).toHaveLength(3);

    const panel = panelDisagreements(findPageDisputes(CHANGED_TEXT), records);
    expect(panel.map((r) => r.found_by)).toEqual(['page_text']);
    const out = pageDisagreementsOut(records, [], () => null);
    expect(out.map((r) => r.found_by)).toEqual(['page_text']);
  });

  it('two claim-pair duplicates without page text: one shown, the owner\'s verdict decides which', () => {
    seedApca();
    const db = handle!.db;
    const finding = (key: string) =>
      recordDisagreement(db, { page_id: APCA.page_id, found_by: 'claim_check', kind: 'changed', key, source_a: DW, source_b: RS }).disagreement_id;
    const first = finding('claims:pair-1');
    const second = finding('claims:pair-2');

    expect(panelDisagreements([], listPageDisagreements(APCA.page_id)).map((r) => r.disagreement_id)).toEqual([first]);

    setOwnerVerdict(second, 'dismissed');
    const records = listPageDisagreements(APCA.page_id);
    expect(panelDisagreements([], records).map((r) => [r.disagreement_id, r.status])).toEqual([[second, 'dismissed']]);
    // Dismissed by the owner: an agent sees none, not the undecided twin.
    expect(pageDisagreementsOut(records, [], () => null)).toEqual([]);
    // Stored history is left alone.
    expect(getDisagreement(first)).toMatchObject({ status: 'possible', owner_verdict: null });
  });

  it('a check finding the owner judged stays visible next to the page text', () => {
    const { first } = seedFilmRows();
    setOwnerVerdict(first, 'confirmed');
    const panel = panelDisagreements(findPageDisputes(CHANGED_TEXT), listPageDisagreements(APCA.page_id));
    expect(panel.map((r) => [r.found_by, r.disagreement_id ?? 'text'])).toEqual([
      ['page_text', expect.any(String)],
      ['claim_check', first],
    ]);
  });

  it('a different kind between the same sources is a different finding', () => {
    seedApca();
    const db = handle!.db;
    recordDisagreement(db, { page_id: APCA.page_id, found_by: 'claim_check', kind: 'changed', key: 'k1', source_a: DW, source_b: RS });
    recordDisagreement(db, { page_id: APCA.page_id, found_by: 'claim_check', kind: 'disputed', key: 'k2', source_a: RS, source_b: DW });
    expect(panelDisagreements([], listPageDisagreements(APCA.page_id)).map((r) => r.kind)).toEqual(['changed', 'disputed']);
  });

  it('recent changes: one disagreement on APCA', async () => {
    seedFilmRows();
    const res = await changesGET(new Request('http://test/api/wiki/changes?days=1'));
    const body = (await res.json()) as { disputes: { total: number; items: Array<{ found_by: string; source_title: string | null }> } };
    expect(body.disputes.total).toBe(1);
    expect(body.disputes.items[0]).toMatchObject({ found_by: 'page_text', source_title: null });
  });

  it('wiki_status: one contradiction per pair of sources', () => {
    seedApca();
    const db = handle!.db;
    for (const key of ['claims:pair-1', 'claims:pair-2']) {
      recordDisagreement(db, { page_id: APCA.page_id, found_by: 'wiki_check', kind: 'changed', key, source_a: DW, source_b: RS, topic: 'contrast' });
    }
    expect(wikiCheckFindings(db)).toHaveLength(1);
  });
});
