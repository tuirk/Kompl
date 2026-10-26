/**
 * Relation descriptions (schema v28) through a .kompl backup import:
 *   - an older backup has no description on its relations; import fills
 *     them from the restored extractions (lib/relation-backfill.ts)
 *   - a v28 backup carries them; import keeps them as they are (clipped like
 *     the extract route, since the zip is untrusted)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import { POST as importPOST } from '../app/api/import/route';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

const SOURCE = {
  source_id: 'src-a',
  title: 'Bitcoin whitepaper',
  source_type: 'url',
  source_url: 'https://example.com/btc',
  content_hash: 'sha256-a',
  file_path: '/data/raw/src-a.md.gz',
  status: 'active',
  date_ingested: '2026-05-01 10:00:00',
  metadata: null,
};

const EXTRACTION = {
  source_id: 'src-a',
  ner_output: '{}',
  profile: 'default',
  keyphrase_output: null,
  tfidf_output: null,
  llm_output: JSON.stringify({
    relationships: [
      { from_entity: 'Bitcoin', to: 'Proof of work', type: 'uses', description: 'Bitcoin uses proof of work.' },
      { from_entity: 'Bitcoin', to: 'Satoshi Nakamoto', type: 'created_by', description: 'Satoshi made it.' },
    ],
  }),
  created_at: '2026-05-01 10:00:00',
};

async function importBundle(schemaVersion: number, relations: Record<string, unknown>[]): Promise<Response> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ format: 'kompl', version: 1, schema_version: schemaVersion }));
  zip.file('db/pages.json', '[]');
  zip.file('db/sources.json', JSON.stringify([SOURCE]));
  zip.file('db/extractions.json', JSON.stringify([EXTRACTION]));
  zip.file('db/relationship_mentions.json', JSON.stringify(relations));
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const form = new FormData();
  form.set('file', new File([new Uint8Array(buf)], 'backup.kompl.zip'));
  return importPOST(new Request('http://test/api/import', { method: 'POST', body: form }));
}

function described(): Record<string, string | null> {
  const rows = handle!.db
    .prepare('SELECT to_canonical AS t, description AS d FROM relationship_mentions')
    .all() as Array<{ t: string; d: string | null }>;
  return Object.fromEntries(rows.map((r) => [r.t, r.d]));
}

const row = (to: string, type: string, extra: Record<string, unknown> = {}) => ({
  from_canonical: 'Bitcoin',
  to_canonical: to,
  relationship_type: type,
  source_id: 'src-a',
  first_seen_at: '2026-05-01 10:00:00',
  ...extra,
});

describe('POST /api/import: relation descriptions', () => {
  it('fills descriptions for a backup made before schema v28', async () => {
    handle = setupTestDb();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
    const res = await importBundle(27, [row('Proof of work', 'uses'), row('Mainnet', 'part_of')]);
    expect(res.status).toBe(200);
    expect(described()).toEqual({
      'Proof of work': 'Bitcoin uses proof of work.',
      Mainnet: null, // nothing in the extraction to fill it from
    });
  });

  it('keeps the descriptions a v28 backup carries, clipped to 300 chars', async () => {
    handle = setupTestDb();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })));
    const res = await importBundle(28, [
      row('Proof of work', 'uses', { description: 'Edited sentence kept.' }),
      row('Satoshi Nakamoto', 'created_by', { description: 'x'.repeat(400) }),
    ]);
    expect(res.status).toBe(200);
    const after = described();
    expect(after['Proof of work']).toBe('Edited sentence kept.');
    expect(after['Satoshi Nakamoto']).toBe('x'.repeat(300));
  });
});
