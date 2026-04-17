/**
 * Regression — deleteSource() must remove extractions before sources.
 *
 * With foreign_keys = ON, SQLite rejects DELETE FROM sources if any
 * extractions row references that source_id. The bug fixed in db.ts:325
 * was that this DELETE was previously missing — silent failure for any
 * source that had been successfully extracted (tweets, notes, etc).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { setupTestDb, seedSource, seedExtraction, type TestDbHandle } from './helpers/test-db';
import { deleteSource } from '../lib/db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe('deleteSource', () => {
  it('returns null for an unknown source_id', () => {
    handle = setupTestDb();
    expect(deleteSource('does-not-exist')).toBeNull();
  });

  it('deletes a source with no extractions and returns its file_path', () => {
    handle = setupTestDb();
    const source_id = seedSource(handle.db, { file_path: '/data/raw/abc.md' });
    const result = deleteSource(source_id);
    expect(result).toBe('/data/raw/abc.md');
    const row = handle.db.prepare('SELECT 1 FROM sources WHERE source_id = ?').get(source_id);
    expect(row).toBeUndefined();
  });

  it('cascades the extraction row when present', () => {
    handle = setupTestDb();
    const source_id = seedSource(handle.db);
    seedExtraction(handle.db, { source_id });

    expect(deleteSource(source_id)).not.toBeNull();

    const extractionRows = handle.db
      .prepare('SELECT 1 FROM extractions WHERE source_id = ?')
      .all(source_id);
    const sourceRows = handle.db
      .prepare('SELECT 1 FROM sources WHERE source_id = ?')
      .all(source_id);
    expect(extractionRows).toHaveLength(0);
    expect(sourceRows).toHaveLength(0);
  });

  it('does not throw the FK error that was the original bug symptom', () => {
    // If deleteSource ever regresses to deleting from `sources` first, this
    // raises 'FOREIGN KEY constraint failed' because the extraction row
    // references a now-missing parent. Pin the no-throw expectation.
    handle = setupTestDb();
    const source_id = seedSource(handle.db);
    seedExtraction(handle.db, { source_id });
    expect(() => deleteSource(source_id)).not.toThrow();
  });

  it('does not affect unrelated sources', () => {
    handle = setupTestDb();
    const keep = seedSource(handle.db, { source_id: 'keep' });
    const drop = seedSource(handle.db, { source_id: 'drop' });
    seedExtraction(handle.db, { source_id: drop });

    deleteSource(drop);

    const remaining = handle.db
      .prepare('SELECT source_id FROM sources')
      .all() as Array<{ source_id: string }>;
    expect(remaining.map((r) => r.source_id)).toEqual([keep]);
  });
});
