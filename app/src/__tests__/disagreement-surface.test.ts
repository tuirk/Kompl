/**
 * Where the disagreements record shows (plan 3.4): the page panel's rows,
 * the owner's Confirm / Dismiss (POST /api/disagreements/[id]/verdict), MCP
 * read_page's data, and the activity feed's Changed rows.
 */

import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { POST as verdictPOST } from '../app/api/disagreements/[disagreement_id]/verdict/route';
import { GET as pageData } from '../app/api/wiki/[page_id]/data/route';
import { getEventDef, type FeedActivityRow } from '../lib/activity-events';
import { panelDisagreements } from '../lib/disagreement-view';
import {
  getDisagreement,
  listPageDisagreements,
  recordDisagreement,
  setOwnerVerdict,
  syncPageTextDisagreements,
} from '../lib/disagreements';
import { findPageDisputes } from '../lib/page-disputes';
import { seedPage, seedProvenance, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';

const BODY = [
  `Intro[^${A}].`,
  '',
  '### Disputed: founding year',
  '',
  `1323[^${A}] or 1320[^${B}].`,
].join('\n');

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function seedVilnius(): TestDbHandle['db'] {
  handle = setupTestDb();
  const db = handle.db;
  for (const [id, title] of [[A, 'Chronicle'], [B, 'Guidebook'], [C, 'News']]) seedSource(db, { source_id: id, title });
  seedPage(db, { page_id: 'vilnius', title: 'Vilnius' });
  db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run(`---\ntitle: Vilnius\n---\n\n${BODY}`, 'vilnius');
  seedProvenance(db, 'vilnius', A);
  seedProvenance(db, 'vilnius', B);
  syncPageTextDisagreements(db, { page_id: 'vilnius', title: 'Vilnius' }, BODY);
  recordDisagreement(db, { page_id: 'vilnius', found_by: 'triage', kind: 'contradiction', source_b: C, reason: 'Says 1321.' });
  return db;
}

function verdict(id: string, body: unknown, headers: Record<string, string> = {}) {
  return verdictPOST(
    new Request(`http://localhost:3000/api/disagreements/${id}/verdict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ disagreement_id: id }) },
  );
}

describe('the page panel rows', () => {
  it('gives each page-text dispute its finding and lists the checks after them', () => {
    seedVilnius();
    const rows = panelDisagreements(findPageDisputes(BODY), listPageDisagreements('vilnius'));
    expect(rows.map((r) => [r.found_by, r.kind, r.topic, r.anchor, r.source_id, r.reason])).toEqual([
      ['page_text', 'disputed', 'Founding year', 'disputed-founding-year', null, null],
      ['triage', 'contradiction', '', null, C, 'Says 1321.'],
    ]);
    expect(rows.every((r) => r.disagreement_id !== null)).toBe(true);
  });

  it('a section the record has not synced yet still shows, without a verdict', () => {
    handle = setupTestDb();
    const rows = panelDisagreements(findPageDisputes(BODY), []);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ disagreement_id: null, status: 'possible', topic: 'Founding year' });
  });
});

describe('POST /api/disagreements/[id]/verdict', () => {
  it("records the owner's verdict and takes it back", async () => {
    seedVilnius();
    const id = listPageDisagreements('vilnius')[0].disagreement_id;
    const res = await verdict(id, { verdict: 'dismissed' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ disagreement_id: id, status: 'dismissed', owner_verdict: 'dismissed' });
    // A later compile of the same text never overturns it.
    syncPageTextDisagreements(handle!.db, { page_id: 'vilnius', title: 'Vilnius' }, BODY.replace('founding year', 'the founding'));
    expect(getDisagreement(id)).toMatchObject({ status: 'dismissed', topic: 'The founding' });

    expect((await verdict(id, { verdict: null })).status).toBe(200);
    expect(getDisagreement(id)!.status).toBe('possible');
  });

  it('refuses bad verdicts, unknown ids, bad JSON and other sites', async () => {
    seedVilnius();
    const id = listPageDisagreements('vilnius')[0].disagreement_id;
    expect((await verdict(id, { verdict: 'maybe' })).status).toBe(422);
    expect((await verdict(id, {})).status).toBe(422);
    expect((await verdict('nope', { verdict: 'confirmed' })).status).toBe(404);
    expect((await verdict(id, '{')).status).toBe(400);
    expect((await verdict(id, { verdict: 'confirmed' }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect(getDisagreement(id)!.status).toBe('possible');
  });
});

describe('MCP read_page data', () => {
  it("lists the page's disagreements with numbered sources, the owner's dismissals left out", async () => {
    seedVilnius();
    const triage = listPageDisagreements('vilnius').find((r) => r.found_by === 'triage')!;
    setOwnerVerdict(triage.disagreement_id, 'dismissed');
    const res = await pageData(new Request('http://test/api/wiki/vilnius/data'), {
      params: Promise.resolve({ page_id: 'vilnius' }),
    });
    const body = (await res.json()) as { disagreements: Array<Record<string, unknown>> };
    expect(body.disagreements).toEqual([
      {
        kind: 'disputed',
        status: 'possible',
        found_by: 'page_text',
        topic: 'Founding year',
        reason: null,
        sources: [
          { n: 1, source_id: A, title: 'Chronicle' },
          { n: 2, source_id: B, title: 'Guidebook' },
        ],
        quote_a: null,
        quote_b: null,
        found_at: expect.any(String),
      },
    ]);
  });
});

function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text((node as ReactElement<{ children?: unknown }>).props.children);
}

describe('the activity feed', () => {
  it('reads a Changed section as a change', () => {
    const row: FeedActivityRow = {
      id: 1,
      timestamp: '2026-10-24 10:00:00',
      action_type: 'page_dispute_recorded',
      source_id: null,
      source_title: null,
      details: JSON.stringify({ page_id: 'v', title: 'V', kind: 'changed', topic: 'Population', source_ids: [A, C] }),
    };
    expect(text(getEventDef('page_dispute_recorded')!.render(row).secondary)).toBe('changed: Population · 2 sources');
  });
});
