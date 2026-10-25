/**
 * A restore asks for every page's embedding again unless it can put the
 * backup's own back: no vectors.json, an empty or unreadable one, or a
 * restore nlp-service refuses all end in the re-embed backfill.
 */

import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as importPOST } from '../app/api/import/route';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;
let calls: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  handle?.cleanup();
  handle = null;
});

function stubFetch(restoreStatus: number): void {
  calls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      return new Response('{}', { status: path === '/vectors/restore' ? restoreStatus : 200 });
    }),
  );
}

async function importWithVectors(vectors: string | null): Promise<Response> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ format: 'kompl', version: 1, schema_version: 30 }));
  if (vectors !== null) zip.file('vectors.json', vectors);
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const form = new FormData();
  form.set('file', new File([new Uint8Array(buf)], 'backup.kompl.zip'));
  return importPOST(new Request('http://test/api/import', { method: 'POST', body: form }));
}

const ITEMS = JSON.stringify({ count: 1, items: [{ page_id: 'p1', embedding: [0.1], metadata: {}, document: 'd' }] });

describe('vectors after a restore', () => {
  it.each([
    ['no vectors.json', null],
    ['an empty vectors.json', JSON.stringify({ count: 0, items: [] })],
    ['an unreadable vectors.json', '{not json'],
  ])('%s: every page is embedded again', async (_label, vectors) => {
    handle = setupTestDb();
    stubFetch(200);
    expect((await importWithVectors(vectors)).status).toBe(200);
    await vi.waitFor(() => expect(calls).toContain('/api/compile/backfill-vectors'));
    expect(calls).not.toContain('/vectors/restore');
  });

  it("the backup's embeddings go back as they are", async () => {
    handle = setupTestDb();
    stubFetch(200);
    expect((await importWithVectors(ITEMS)).status).toBe(200);
    await vi.waitFor(() => expect(calls).toContain('/vectors/restore'));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).not.toContain('/api/compile/backfill-vectors');
  });

  it('a restore nlp-service refuses falls back to embedding every page', async () => {
    handle = setupTestDb();
    stubFetch(500);
    expect((await importWithVectors(ITEMS)).status).toBe(200);
    await vi.waitFor(() => expect(calls).toEqual(['/vectors/restore', '/api/compile/backfill-vectors']));
  });
});
