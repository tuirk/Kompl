/**
 * The claim check's saved verdicts travel in .kompl backups
 * (db/claim_verdicts.json), so a restored wiki never pays to judge the same
 * claim pair again. Rows a backup should not hold are skipped, and backups
 * made before the table carry none.
 */

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as exportGET } from '../app/api/export/route';
import { POST as importPOST } from '../app/api/import/route';
import { aliasScreenIdle } from '../lib/alias-screen';
import { saveClaimVerdict, type SavedClaimVerdict } from '../lib/claim-check/verdicts';
import { seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

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

const VERDICT: SavedClaimVerdict = {
  pair_key: 'k1|k2',
  source_a: A,
  claim_a: 'Bitcoin launched in 2008.',
  source_b: B,
  claim_b: 'Bitcoin launched in 2009.',
  subject: 'Bitcoin',
  verdict: 'outdated',
  topic: 'launch year',
  reason: 'A gives 2008; B gives 2009.',
  newer: 'b',
  found_by: 'wiki_check',
  model: 'deepseek-flash',
  session_id: null,
};

async function restore(files: Record<string, string>): Promise<Response> {
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

const savedRows = () =>
  handle!.db.prepare('SELECT pair_key, source_a, source_b, verdict, newer, found_by, model FROM claim_verdicts ORDER BY pair_key').all();

describe('claim verdicts in backups', () => {
  it('export writes every verdict and a restore keeps them', async () => {
    handle = setupTestDb();
    seedSource(handle.db, { source_id: A });
    seedSource(handle.db, { source_id: B });
    saveClaimVerdict(handle.db, VERDICT);
    saveClaimVerdict(handle.db, { ...VERDICT, pair_key: 'k3|k4', verdict: 'none', newer: null, found_by: 'claim_check' });

    const res = await exportGET(new Request('http://test/api/export?format=kompl'));
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const rows = JSON.parse(await zip.file('db/claim_verdicts.json')!.async('string')) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    const before = savedRows();
    handle.cleanup();

    handle = setupTestDb();
    const restored = await restore({ 'db/sources.json': SOURCES, 'db/claim_verdicts.json': JSON.stringify(rows) });
    expect(restored.status).toBe(200);
    expect(savedRows()).toEqual(before);
  });

  it('skips rows a backup should not hold, and backups from before carry none', async () => {
    handle = setupTestDb();
    const rows = [
      { ...VERDICT, pair_key: 'bad-verdict', verdict: 'contradiction' },
      { ...VERDICT, pair_key: 'bad-finder', found_by: 'triage' },
      { ...VERDICT, pair_key: 'missing-source', source_b: 'cccccccc-0000-4000-8000-000000000003' },
      { ...VERDICT, pair_key: 'no-claim', claim_a: '' },
      { ...VERDICT, pair_key: 'odd-newer', verdict: 'disputed', newer: 'b' },
      'not a row',
    ];
    expect((await restore({ 'db/sources.json': SOURCES, 'db/claim_verdicts.json': JSON.stringify(rows) })).status).toBe(200);
    expect(savedRows()).toEqual([
      { pair_key: 'odd-newer', source_a: A, source_b: B, verdict: 'disputed', newer: null, found_by: 'wiki_check', model: 'deepseek-flash' },
    ]);
    handle.cleanup();

    handle = setupTestDb();
    expect((await restore({ 'db/sources.json': SOURCES })).status).toBe(200);
    expect(savedRows()).toEqual([]);
  });
});
