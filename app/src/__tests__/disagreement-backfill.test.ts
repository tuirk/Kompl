/**
 * Filling the disagreements record from what a wiki already holds, and
 * carrying it through .kompl backups (lib/disagreement-backfill.ts).
 *
 * Disputes recorded in page text before commit 1ff33db3 never reached the
 * activity feed; the backfill reads every page once (no LLM) and every
 * logged triage verdict. A restore keeps the owner's verdicts, and a backup
 * made before the record gets one from its pages.
 */

import JSZip from 'jszip';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as exportGET } from '../app/api/export/route';
import { POST as importPOST } from '../app/api/import/route';
import { isBackedUpSetting } from '../lib/backup-settings';
import { logActivity } from '../lib/db';
import { backfillDisagreements, DISAGREEMENTS_BACKFILL_KEY } from '../lib/disagreement-backfill';
import { listPageDisagreements, setOwnerVerdict } from '../lib/disagreements';
import { aliasScreenIdle } from '../lib/alias-screen';
import { getActivityCounts, seedPage, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

const DISPUTED = `---\ntitle: Vilnius\n---\n\n## Contradictions\n\nFounded in 1323[^${A}] or in 1320[^${B}].`;

let handle: TestDbHandle | null = null;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
});

afterEach(async () => {
  await aliasScreenIdle();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  handle?.cleanup();
  handle = null;
});

function seedWiki(): TestDbHandle['db'] {
  handle = setupTestDb();
  const db = handle.db;
  seedSource(db, { source_id: A });
  seedSource(db, { source_id: B });
  seedPage(db, { page_id: 'vilnius', title: 'Vilnius' });
  db.prepare("UPDATE pages SET pending_content = ?, last_updated = '2026-09-01 08:00:00' WHERE page_id = 'vilnius'").run(DISPUTED);
  seedPage(db, { page_id: 'kaunas', title: 'Kaunas' });
  db.prepare("UPDATE pages SET pending_content = ? WHERE page_id = 'kaunas'").run('---\ntitle: Kaunas\n---\n\nNo disputes.');
  return db;
}

describe('backfillDisagreements', () => {
  it("records the disputes pages hold and the logged triage verdicts, once, without logging them again", () => {
    const db = seedWiki();
    logActivity('page_contradiction_detected', {
      source_id: B,
      details: { page_id: 'kaunas', page_title: 'Kaunas', reason: 'Another founding year' },
    });

    expect(backfillDisagreements(db)).toEqual({ pages_read: 2, page_text: 1, triage: 1 });
    const vilnius = listPageDisagreements('vilnius');
    expect(vilnius.map((r) => [r.found_by, r.kind, r.topic, r.created_at])).toEqual([
      ['page_text', 'disputed', 'Founded in 1323 or in 1320.', '2026-09-01 08:00:00'],
    ]);
    expect(listPageDisagreements('kaunas').map((r) => [r.found_by, r.source_b])).toEqual([['triage', B]]);
    expect(getActivityCounts(db).page_dispute_recorded).toBeUndefined();

    // Idempotent: nothing new, verdicts untouched.
    setOwnerVerdict(vilnius[0].disagreement_id, 'dismissed');
    expect(backfillDisagreements(db)).toEqual({ pages_read: 1, page_text: 0, triage: 0 });
    expect(listPageDisagreements('vilnius')[0].status).toBe('dismissed');
  });

  it('its version marker belongs to this database, not to backups', () => {
    expect(isBackedUpSetting(DISAGREEMENTS_BACKFILL_KEY)).toBe(false);
  });
});

async function restore(files: Record<string, string | Buffer>): Promise<Response> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ format: 'kompl', version: 1, schema_version: 30 }));
  for (const [name, body] of Object.entries(files)) zip.file(name, body);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const form = new FormData();
  form.set('file', new File([new Uint8Array(buf)], 'backup.kompl.zip'));
  return importPOST(new Request('http://test/api/import', { method: 'POST', body: form }));
}

const SOURCES = JSON.stringify(
  [A, B].map((id) => ({ source_id: id, title: id, source_type: 'url', content_hash: 'h', file_path: 'f', date_ingested: '2026-01-01' })),
);
const PAGES = JSON.stringify([
  {
    page_id: 'vilnius', title: 'Vilnius', page_type: 'entity', content_path: '/data/pages/vilnius.md.gz',
    last_updated: '2026-09-01 08:00:00', created_at: '2026-08-01 08:00:00', source_count: 2,
  },
]);

describe('disagreements in backups', () => {
  it('export writes every finding, and a restore keeps the owner verdicts', async () => {
    const db = seedWiki();
    backfillDisagreements(db);
    const id = listPageDisagreements('vilnius')[0].disagreement_id;
    setOwnerVerdict(id, 'confirmed');

    const res = await exportGET(new Request('http://test/api/export?format=kompl'));
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const rows = JSON.parse(await zip.file('db/disagreements.json')!.async('string')) as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.disagreement_id, r.owner_verdict, r.status])).toEqual([[id, 'confirmed', 'confirmed']]);
    handle!.cleanup();

    handle = setupTestDb();
    const restored = await restore({
      'db/sources.json': SOURCES,
      'db/pages.json': PAGES,
      'db/disagreements.json': JSON.stringify(rows),
      'pages/vilnius.md.gz': gzipSync(DISPUTED),
    });
    expect(restored.status).toBe(200);
    expect(listPageDisagreements('vilnius').map((r) => [r.disagreement_id, r.status, r.owner_verdict])).toEqual([
      [id, 'confirmed', 'confirmed'],
    ]);
  });

  it('a backup made before the record gets one from its pages and activity log', async () => {
    handle = setupTestDb();
    const res = await restore({
      'db/sources.json': SOURCES,
      'db/pages.json': PAGES,
      'db/activity_log.json': JSON.stringify([
        {
          timestamp: '2026-08-02 10:00:00',
          action_type: 'page_contradiction_detected',
          source_id: B,
          details: JSON.stringify({ page_id: 'vilnius', reason: 'Another year' }),
        },
      ]),
      'pages/vilnius.md.gz': gzipSync(DISPUTED),
    });
    expect(res.status).toBe(200);
    expect(listPageDisagreements('vilnius').map((r) => [r.found_by, r.status])).toEqual([
      ['page_text', 'possible'],
      ['triage', 'possible'],
    ]);
  });

  it('skips findings a backup should not hold', async () => {
    handle = setupTestDb();
    const base = { match_key: 'k', found_by: 'triage', kind: 'contradiction', page_id: 'vilnius' };
    const res = await restore({
      'db/sources.json': SOURCES,
      'db/pages.json': PAGES,
      'db/disagreements.json': JSON.stringify([
        { ...base, disagreement_id: 'ok', owner_verdict: 'shrug', source_b: 'not-a-source', source_ids: [B] },
        { ...base, disagreement_id: 'bad-kind', kind: 'outdated', match_key: 'k2' },
        { ...base, disagreement_id: 'no-page', page_id: 'elsewhere', match_key: 'k3' },
      ]),
    });
    expect(res.status).toBe(200);
    // (Page-text findings come from the page file an earlier restore left in DATA_ROOT.)
    const fromBackup = listPageDisagreements('vilnius').filter((r) => r.found_by === 'triage');
    expect(fromBackup.map((r) => [r.disagreement_id, r.status, r.owner_verdict, r.source_b])).toEqual([
      ['ok', 'possible', null, null],
    ]);
  });
});
