/**
 * A restored daily spending cap is the one nlp-service enforces. The cap is
 * a settings row (shown in Settings) mirrored to /data/llm-config.json,
 * which nlp-service reads; a restore that wrote only the row showed the
 * backup's cap while the install's old one was enforced.
 */

import JSZip from 'jszip';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { POST as importPOST } from '../app/api/import/route';
import { DATA_ROOT, getDailyCapUsd } from '../lib/db';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

const CONFIG = path.join(DATA_ROOT, 'llm-config.json');
let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  fs.rmSync(CONFIG, { force: true });
});

async function importSettings(settings: Array<{ key: string; value: string }>): Promise<Response> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({ format: 'kompl', version: 1, schema_version: 30 }));
  zip.file('db/settings.json', JSON.stringify(settings));
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const form = new FormData();
  form.set('file', new File([new Uint8Array(buf)], 'backup.kompl.zip'));
  return importPOST(new Request('http://test/api/import', { method: 'POST', body: form }));
}

const enforcedCap = () => (JSON.parse(fs.readFileSync(CONFIG, 'utf-8')) as { daily_cap_usd: number }).daily_cap_usd;

describe('daily cap after a restore', () => {
  it("writes the backup's cap to the file nlp-service enforces", async () => {
    handle = setupTestDb();
    fs.writeFileSync(CONFIG, JSON.stringify({ daily_cap_usd: 2 }));
    expect((await importSettings([{ key: 'daily_cap_usd', value: '12.5' }])).status).toBe(200);
    expect(getDailyCapUsd()).toBe(12.5);
    expect(enforcedCap()).toBe(12.5);
  });

  it("leaves the install's cap alone when the backup has none", async () => {
    handle = setupTestDb();
    fs.writeFileSync(CONFIG, JSON.stringify({ daily_cap_usd: 2 }));
    expect((await importSettings([{ key: 'auto_approve', value: '1' }])).status).toBe(200);
    expect(enforcedCap()).toBe(2);
  });
});
