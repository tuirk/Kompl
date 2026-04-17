/**
 * Regression: export→import must preserve provenance rows.
 *
 * Bug: getAllProvenance() omitted `content_hash` from its SELECT. The .kompl
 * export serialised provenance rows without that field; on import, INSERT OR
 * IGNORE silently dropped every row because `content_hash TEXT NOT NULL`
 * received undefined. With provenance empty, getAllArchivedPageIds() always
 * returned ∅, so the "Hide Archived" wiki toggle filtered nothing.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  getAllProvenance,
  insertProvenance,
  getAllArchivedPageIds,
  setSourceStatus,
} from '../lib/db';
import { setupTestDb, seedSource, seedPage, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe('provenance export shape', () => {
  it('getAllProvenance returns content_hash so import can re-insert (NOT NULL column)', () => {
    handle = setupTestDb();
    const source_id = seedSource(handle.db);
    const page_id = seedPage(handle.db);

    insertProvenance({
      source_id,
      page_id,
      content_hash: 'sha256-roundtrip',
      contribution_type: 'created',
    });

    const rows = getAllProvenance();
    expect(rows).toHaveLength(1);
    expect(rows[0].content_hash).toBe('sha256-roundtrip');
  });

  it('getAllArchivedPageIds flags a page whose only source is archived', () => {
    handle = setupTestDb();
    const source_id = seedSource(handle.db);
    const page_id = seedPage(handle.db);
    insertProvenance({
      source_id,
      page_id,
      content_hash: 'sha256-test',
      contribution_type: 'created',
    });

    expect(getAllArchivedPageIds().has(page_id)).toBe(false);

    setSourceStatus(source_id, 'archived');
    expect(getAllArchivedPageIds().has(page_id)).toBe(true);
  });
});
