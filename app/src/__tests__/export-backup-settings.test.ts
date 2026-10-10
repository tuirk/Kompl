/**
 * .kompl backups carry the schema version in manifest.json only.
 *
 * Releases up to v0.3.2.1 copy every settings row on import. A schema_version
 * row in the bundle therefore overwrote the importing install's own version
 * (a v26 backup restored on v0.3.2.1 left it reporting "degraded"). This
 * release's import ignores the row and reads the manifest instead.
 */

import JSZip from 'jszip';
import { describe, it, expect, afterEach } from 'vitest';
import { GET as exportGET } from '../app/api/export/route';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe('.kompl backup settings', () => {
  it('keeps the schema version in the manifest, not in settings.json', async () => {
    handle = setupTestDb();
    const res = await exportGET(new Request('http://test/api/export?format=kompl'));
    expect(res.status).toBe(200);

    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string')) as { schema_version: number };
    const keys = (JSON.parse(await zip.file('db/settings.json')!.async('string')) as Array<{ key: string }>).map(
      (s) => s.key,
    );

    expect(manifest.schema_version).toBe(27);
    expect(keys).not.toContain('schema_version');
    expect(keys).toContain('compile_model');
  });
});
