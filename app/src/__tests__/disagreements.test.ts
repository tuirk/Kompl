/**
 * The disagreements record (plan 3.4, lib/disagreements.ts): one row per
 * disagreement on a page, whoever found it, with the owner's verdict.
 * Page-text findings follow the committed markdown, written inside the
 * commit's transaction; checks record theirs with recordDisagreement; the
 * owner's verdict is never overwritten by either.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  getDisagreement,
  importTriageVerdicts,
  listPageDisagreements,
  recordDisagreement,
  recordPageDisagreements,
  setOwnerVerdict,
  syncPageTextDisagreements,
} from '../lib/disagreements';
import { logActivity } from '../lib/db';
import { getActivityCounts, seedPage, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';

const PAGE = [
  '---',
  'title: Vilnius',
  '---',
  '',
  `Vilnius is the capital[^${A}].`,
  '',
  '### Disputed: founding year',
  '',
  `1323[^${A}] or 1320[^${B}].`,
  '',
  '### Changed: population',
  '',
  `About 550,000 as of 2010[^${A}]; about 600,000 as of 2024[^${C}].`,
].join('\n');

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function setup(): { db: TestDbHandle['db']; page: { page_id: string; title: string } } {
  handle = setupTestDb();
  for (const id of [A, B, C]) seedSource(handle.db, { source_id: id });
  const page_id = seedPage(handle.db, { page_id: 'vilnius', title: 'Vilnius' });
  return { db: handle.db, page: { page_id, title: 'Vilnius' } };
}

describe('page-text findings', () => {
  it('records each Disputed/Changed section once and logs it once', () => {
    const { db, page } = setup();
    expect(syncPageTextDisagreements(db, page, PAGE)).toBe(2);
    expect(syncPageTextDisagreements(db, page, PAGE)).toBe(0);
    const rows = listPageDisagreements('vilnius');
    expect(rows.map((r) => [r.found_by, r.kind, r.topic, r.status, r.source_ids])).toEqual([
      ['page_text', 'disputed', 'Founding year', 'possible', [A, B]],
      ['page_text', 'changed', 'Population', 'possible', [A, C]],
    ]);
    expect(rows[0].anchor).toBe('disputed-founding-year');
    expect(getActivityCounts(db).page_dispute_recorded).toBe(2);
  });

  it('a reworded dispute with the same sources is the same finding', () => {
    const { db, page } = setup();
    syncPageTextDisagreements(db, page, PAGE);
    const before = listPageDisagreements('vilnius')[0].disagreement_id;
    expect(syncPageTextDisagreements(db, page, PAGE.replace('founding year', 'when the city was founded'))).toBe(0);
    const after = listPageDisagreements('vilnius');
    expect(after[0].disagreement_id).toBe(before);
    expect(after[0].topic).toBe('When the city was founded');
    expect(getActivityCounts(db).page_dispute_recorded).toBe(2);
  });

  it('a rewrite that retypes the apostrophe and adds a source is the same finding', () => {
    const { db, page } = setup();
    const curly = PAGE.replace('founding year', 'the city’s founding year');
    syncPageTextDisagreements(db, page, curly);
    const before = listPageDisagreements('vilnius')[0].disagreement_id;
    const straight = PAGE.replace('founding year', "the city's founding year").replace(
      `1320[^${B}].`,
      `1320[^${B}][^${C}].`,
    );
    expect(syncPageTextDisagreements(db, page, straight)).toBe(0);
    const after = listPageDisagreements('vilnius', { includeCleared: true });
    expect(after.filter((r) => r.kind === 'disputed').map((r) => r.disagreement_id)).toEqual([before]);
    expect(after[0].topic).toBe("The city's founding year");
  });

  it('a section the text drops is cleared, and returns with its verdict', () => {
    const { db, page } = setup();
    syncPageTextDisagreements(db, page, PAGE);
    const founding = listPageDisagreements('vilnius')[0];
    setOwnerVerdict(founding.disagreement_id, 'dismissed');

    const withoutIt = PAGE.split('### Changed')[0].replace('### Disputed: founding year', '## History');
    syncPageTextDisagreements(db, page, withoutIt);
    expect(listPageDisagreements('vilnius')).toEqual([]);
    expect(listPageDisagreements('vilnius', { includeCleared: true }).every((r) => r.cleared_at !== null)).toBe(true);

    // Back, now as a change over time: the owner's verdict stays.
    syncPageTextDisagreements(db, page, PAGE.replace('### Disputed: founding year', '### Changed: founding year'));
    const back = getDisagreement(founding.disagreement_id)!;
    expect(back).toMatchObject({ kind: 'changed', cleared_at: null, status: 'dismissed', owner_verdict: 'dismissed' });
    expect(getActivityCounts(db).page_dispute_recorded).toBe(2);
  });

  describe('two sections citing the same sources', () => {
    const FOUNDING = ['### Disputed: founding date', '', `1323[^${A}] or 1320[^${B}].`].join('\n');
    const HQ = ['### Disputed: headquarters', '', `The old town[^${A}] or Antakalnis[^${B}].`].join('\n');

    function syncBoth(db: TestDbHandle['db'], page: { page_id: string; title: string }) {
      syncPageTextDisagreements(db, page, `${FOUNDING}\n\n${HQ}`);
      const [founding, hq] = listPageDisagreements('vilnius');
      setOwnerVerdict(founding.disagreement_id, 'dismissed');
      return { founding: founding.disagreement_id, hq: hq.disagreement_id };
    }

    it('a redraft that keeps only the second keeps its finding, and clears the first with its verdict', () => {
      const { db, page } = setup();
      const ids = syncBoth(db, page);
      syncPageTextDisagreements(db, page, HQ);
      expect(getDisagreement(ids.hq)).toMatchObject({ topic: 'Headquarters', status: 'possible', cleared_at: null });
      expect(getDisagreement(ids.founding)).toMatchObject({ topic: 'Founding date', status: 'dismissed' });
      expect(getDisagreement(ids.founding)!.cleared_at).not.toBeNull();
    });

    it('a redraft that only reorders them keeps each finding on its own topic', () => {
      const { db, page } = setup();
      const ids = syncBoth(db, page);
      expect(syncPageTextDisagreements(db, page, `${HQ}\n\n${FOUNDING}`)).toBe(0);
      expect(getDisagreement(ids.hq)).toMatchObject({ topic: 'Headquarters', status: 'possible', cleared_at: null });
      expect(getDisagreement(ids.founding)).toMatchObject({ topic: 'Founding date', status: 'dismissed', cleared_at: null });
    });
  });

  it('disputes logged by releases before the record are not logged again', () => {
    const { db, page } = setup();
    logActivity('page_dispute_recorded', {
      source_id: null,
      details: { page_id: 'vilnius', title: 'Vilnius', topic: 'Founding year', source_ids: [A, B] },
    });
    expect(syncPageTextDisagreements(db, page, PAGE)).toBe(2);
    expect(getActivityCounts(db).page_dispute_recorded).toBe(2);
  });

  it('is written inside the caller\'s transaction: a rolled-back commit leaves nothing', () => {
    const { db, page } = setup();
    expect(() =>
      db.transaction(() => {
        recordPageDisagreements(db, page, PAGE);
        throw new Error('commit failed');
      })(),
    ).toThrow('commit failed');
    expect(listPageDisagreements('vilnius', { includeCleared: true })).toEqual([]);
    expect(getActivityCounts(db).page_dispute_recorded).toBeUndefined();
  });

  it('a failure in the record never fails the commit around it', () => {
    const { db, page } = setup();
    db.exec('DROP TABLE disagreements');
    const committed = db.transaction(() => {
      db.prepare("UPDATE pages SET summary = 'kept' WHERE page_id = 'vilnius'").run();
      return recordPageDisagreements(db, page, PAGE);
    })();
    expect(committed).toBe(0);
    expect((db.prepare("SELECT summary FROM pages WHERE page_id = 'vilnius'").get() as { summary: string }).summary).toBe('kept');
  });
});

describe('recordDisagreement (checks)', () => {
  it('records a finding once per key and never changes the owner verdict', () => {
    const { db } = setup();
    const first = recordDisagreement(db, {
      page_id: 'vilnius',
      found_by: 'claim_check',
      kind: 'disputed',
      key: 'claim-1|claim-2',
      topic: 'Founding year',
      reason: 'Different years',
      source_a: A,
      quote_a: 'Founded in 1323.',
      source_b: B,
      quote_b: 'Founded in 1320.',
    });
    expect(first.created).toBe(true);
    setOwnerVerdict(first.disagreement_id, 'confirmed');

    const again = recordDisagreement(db, {
      page_id: 'vilnius',
      found_by: 'claim_check',
      kind: 'changed',
      key: 'claim-1|claim-2',
      source_a: A,
      source_b: B,
    });
    expect(again).toEqual({ disagreement_id: first.disagreement_id, created: false });
    expect(getDisagreement(first.disagreement_id)).toMatchObject({
      kind: 'changed',
      status: 'confirmed',
      owner_verdict: 'confirmed',
      // Left out on the second call: kept.
      reason: 'Different years',
      quote_a: 'Founded in 1323.',
      quote_b: 'Founded in 1320.',
      source_ids: [A, B],
    });
  });

  it('a triage verdict keys on its source; a side whose source is gone is kept as null', () => {
    const { db } = setup();
    const r = recordDisagreement(db, { page_id: 'vilnius', found_by: 'triage', kind: 'contradiction', source_b: 'gone-source' });
    expect(getDisagreement(r.disagreement_id)).toMatchObject({ source_b: null, source_ids: ['gone-source'], match_key: 'gone-source' });
  });

  it('refuses page text, unknown kinds and pages that do not exist', () => {
    const { db } = setup();
    expect(() =>
      recordDisagreement(db, { page_id: 'vilnius', found_by: 'page_text' as never, kind: 'disputed' }),
    ).toThrow(/finder/);
    expect(() => recordDisagreement(db, { page_id: 'vilnius', found_by: 'triage', kind: 'outdated' as never })).toThrow(/kind/);
    expect(() => recordDisagreement(db, { page_id: 'nope', found_by: 'triage', kind: 'contradiction' })).toThrow();
  });
});

describe('triage verdicts logged before the record', () => {
  function logVerdict(sourceId: string) {
    logActivity('page_contradiction_detected', {
      source_id: sourceId,
      details: { page_id: 'vilnius', page_title: 'Vilnius', reason: 'Gives another year', detected_at: '2026-09-01T10:00:00.000Z' },
    });
  }

  it('join the record through the backfill, once, keyed like recordDisagreement', () => {
    const { db } = setup();
    logVerdict(C);
    // Reading never writes: the boot/import backfill takes old verdicts in.
    expect(listPageDisagreements('vilnius')).toHaveLength(0);
    expect(importTriageVerdicts(db)).toBe(1);
    const rows = listPageDisagreements('vilnius');
    expect(rows.map((r) => [r.found_by, r.kind, r.source_b, r.reason, r.created_at])).toEqual([
      ['triage', 'contradiction', C, 'Gives another year', '2026-09-01 10:00:00'],
    ]);
    expect(importTriageVerdicts(db)).toBe(0);
    // The triage step recording the same verdict itself does not double it.
    expect(recordDisagreement(db, { page_id: 'vilnius', found_by: 'triage', kind: 'contradiction', source_b: C }).created).toBe(false);
    expect(listPageDisagreements('vilnius')).toHaveLength(1);
  });
});

describe('setOwnerVerdict', () => {
  it('confirms, dismisses and takes the verdict back', () => {
    const { db, page } = setup();
    syncPageTextDisagreements(db, page, PAGE);
    const id = listPageDisagreements('vilnius')[0].disagreement_id;
    expect(setOwnerVerdict(id, 'confirmed')).toMatchObject({ status: 'confirmed', owner_verdict: 'confirmed' });
    expect(getDisagreement(id)!.owner_verdict_at).not.toBeNull();
    expect(setOwnerVerdict(id, 'dismissed')).toMatchObject({ status: 'dismissed' });
    expect(setOwnerVerdict(id, null)).toMatchObject({ status: 'possible', owner_verdict: null, owner_verdict_at: null });
    expect(setOwnerVerdict('nope', 'confirmed')).toBeNull();
  });

  it('deleting the page removes its findings', () => {
    const { db, page } = setup();
    syncPageTextDisagreements(db, page, PAGE);
    db.prepare("DELETE FROM pages WHERE page_id = 'vilnius'").run();
    expect((db.prepare('SELECT COUNT(*) AS n FROM disagreements').get() as { n: number }).n).toBe(0);
  });
});
