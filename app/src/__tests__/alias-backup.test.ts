/**
 * .kompl backups carry each alias's v29 record (method, score, session,
 * status), so a restore keeps the aliases set aside or retired as they were.
 * Backups from before v29 have none of it: their aliases import as active,
 * with no method, and the alias screen looks at them after the import.
 */

import JSZip from 'jszip';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { GET as exportGET } from '../app/api/export/route';
import { POST as importPOST } from '../app/api/import/route';
import { ALIAS_SCREEN_THROUGH_KEY, ALIAS_SCREEN_VERSION_KEY, aliasScreenIdle } from '../lib/alias-screen';
import { isBackedUpSetting } from '../lib/backup-settings';
import { getAllAliases } from '../lib/db';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;
let similarity = 0.95;
let asked: string[] = [];

beforeEach(() => {
  similarity = 0.95;
  asked = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // nlp-service: name-only similarity for the alias screen; nothing else.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!String(url).endsWith('/resolve/name-similarity')) return new Response('not found', { status: 404 });
      const { pairs } = JSON.parse(String(init?.body)) as { pairs: Array<{ a: string; b: string }> };
      asked.push(...pairs.map((p) => `${p.a}|${p.b}`));
      return Response.json({ items: pairs.map((p) => ({ ...p, similarity })), count: pairs.length });
    })
  );
});

afterEach(async () => {
  await aliasScreenIdle();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  handle?.cleanup();
  handle = null;
});

function statusOf(alias: string): [string, string | null] {
  const a = getAllAliases().find((r) => r.alias === alias)!;
  return [a.status ?? 'active', a.status_reason];
}

async function importAliases(aliases: Record<string, unknown>[], schemaVersion: number): Promise<Response> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ format: 'kompl', version: 1, schema_version: schemaVersion }));
  zip.file('db/pages.json', '[]');
  zip.file('db/sources.json', '[]');
  zip.file('db/aliases.json', JSON.stringify(aliases));
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const form = new FormData();
  form.set('file', new File([new Uint8Array(buf)], 'backup.kompl.zip'));
  return importPOST(new Request('http://test/api/import', { method: 'POST', body: form }));
}

describe('alias records in backups', () => {
  it('export writes every alias row with its v29 columns', async () => {
    handle = setupTestDb();
    handle.db
      .prepare(
        `INSERT INTO aliases (alias, canonical_name, method, score, session_id, status, status_reason, status_at)
         VALUES ('Ethereum', 'Ethereum Foundation', NULL, NULL, NULL, 'suspended', 'token_extension', '2026-10-23 10:00:00')`
      )
      .run();
    handle.db
      .prepare(`INSERT INTO aliases (alias, canonical_name, method, score, session_id) VALUES ('GPT 4', 'GPT-4', 'skeleton', 0.97, 's1')`)
      .run();
    const res = await exportGET(new Request('http://test/api/export?format=kompl'));
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const aliases = JSON.parse(await zip.file('db/aliases.json')!.async('string')) as Array<Record<string, unknown>>;
    expect(aliases).toEqual([
      {
        alias: 'Ethereum', canonical_name: 'Ethereum Foundation', canonical_page_id: null,
        method: null, score: null, session_id: null,
        status: 'suspended', status_reason: 'token_extension', status_at: '2026-10-23 10:00:00',
      },
      {
        alias: 'GPT 4', canonical_name: 'GPT-4', canonical_page_id: null,
        method: 'skeleton', score: 0.97, session_id: 's1',
        status: 'active', status_reason: null, status_at: null,
      },
    ]);
  });

  it('import restores the v29 columns as they were', async () => {
    handle = setupTestDb();
    const res = await importAliases(
      [
        {
          alias: 'English', canonical_name: 'programming language', canonical_page_id: null,
          method: null, score: null, session_id: null,
          status: 'retired', status_reason: 'owner', status_at: '2026-10-20 09:00:00',
        },
        {
          alias: 'Bitcoin network', canonical_name: 'Bitcoin', canonical_page_id: null,
          method: 'embedding', score: 0.93, session_id: 'sess-9',
          status: 'active', status_reason: null, status_at: null,
        },
      ],
      29
    );
    expect(res.status).toBe(200);
    expect(getAllAliases()).toEqual([
      {
        alias: 'English', canonical_name: 'programming language', canonical_page_id: null,
        method: null, score: null, session_id: null,
        status: 'retired', status_reason: 'owner', status_at: '2026-10-20 09:00:00',
      },
      {
        alias: 'Bitcoin network', canonical_name: 'Bitcoin', canonical_page_id: null,
        method: 'embedding', score: 0.93, session_id: 'sess-9',
        status: 'active', status_reason: null, status_at: null,
      },
    ]);
  });

  it('a backup from before v29 imports its aliases as active, with no method', async () => {
    handle = setupTestDb();
    const res = await importAliases([{ alias: 'ETH', canonical_name: 'Ethereum', canonical_page_id: null }], 28);
    expect(res.status).toBe(200);
    await aliasScreenIdle();
    expect(asked).toEqual([]); // screened: an acronym pair is kept by shape, no similarity asked
    expect(getAllAliases()).toEqual([
      {
        alias: 'ETH', canonical_name: 'Ethereum', canonical_page_id: null,
        method: null, score: null, session_id: null,
        status: 'active', status_reason: null, status_at: null,
      },
    ]);
  });

  it('values a backup should not hold import as active, with no score', async () => {
    handle = setupTestDb();
    const res = await importAliases(
      [
        { alias: 'A', canonical_name: 'B', canonical_page_id: null, status: 'deleted', score: 'high', method: 7 },
        { alias: 'C', canonical_name: 'D', canonical_page_id: null, status: null, score: Number.NaN },
      ],
      29
    );
    expect(res.status).toBe(200);
    await aliasScreenIdle();
    expect(getAllAliases().map((a) => [a.alias, a.status, a.score, a.method])).toEqual([
      ['A', 'active', null, null],
      ['C', 'active', null, null],
    ]);
  });
});

describe('alias screen after an import', () => {
  it('sets aside the clearly wrong aliases of an old backup, with or without nlp-service', async () => {
    handle = setupTestDb();
    similarity = 0.3;
    const res = await importAliases(
      [
        { alias: 'Ethereum', canonical_name: 'Ethereum Foundation', canonical_page_id: null },
        { alias: 'English', canonical_name: 'programming language', canonical_page_id: null },
        { alias: 'GPT 4', canonical_name: 'GPT-4', canonical_page_id: null },
      ],
      28
    );
    expect(res.status).toBe(200);
    // One run, in the background as it needs nlp-service: all or nothing.
    expect(statusOf('Ethereum')).toEqual(['active', null]);
    await aliasScreenIdle();
    expect(statusOf('Ethereum')).toEqual(['suspended', 'token_extension']);
    expect(statusOf('English')).toEqual(['suspended', 'content_words']);
    expect(statusOf('GPT 4')).toEqual(['active', null]);
    const events = handle.db
      .prepare(`SELECT action_type FROM activity_log WHERE action_type IN ('wiki_imported', 'aliases_suspended') ORDER BY id`)
      .all()
      .map((r) => (r as { action_type: string }).action_type);
    expect(events).toEqual(['wiki_imported', 'aliases_suspended']);
  });

  it("never carries the screen's record of this database's rows", () => {
    expect(isBackedUpSetting(ALIAS_SCREEN_VERSION_KEY)).toBe(false);
    expect(isBackedUpSetting(ALIAS_SCREEN_THROUGH_KEY)).toBe(false);
  });

  it('sets aside shape-only aliases before the import returns', async () => {
    handle = setupTestDb();
    const res = await importAliases([{ alias: 'Ethereum', canonical_name: 'Ethereum Foundation', canonical_page_id: null }], 28);
    expect(res.status).toBe(200);
    expect(statusOf('Ethereum')).toEqual(['suspended', 'token_extension']);
    expect(asked).toEqual([]);
  });

  it("keeps a v29 backup's statuses and leaves the rows the resolver made alone", async () => {
    handle = setupTestDb();
    similarity = 0.1;
    const res = await importAliases(
      [
        { alias: 'Ethereum', canonical_name: 'Ethereum Foundation', canonical_page_id: null, method: 'llm', status: 'active' },
        { alias: 'Solana', canonical_name: 'Solana Labs', canonical_page_id: null, status: 'retired', status_reason: 'owner' },
      ],
      29
    );
    expect(res.status).toBe(200);
    await aliasScreenIdle();
    expect(asked).toEqual([]);
    expect(statusOf('Ethereum')).toEqual(['active', null]);
    expect(statusOf('Solana')).toEqual(['retired', 'owner']);
  });
});
