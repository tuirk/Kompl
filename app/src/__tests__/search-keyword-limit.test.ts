/**
 * GET /api/pages/search in keyword mode keeps `limit` between 1 and 100, as
 * hybrid mode does.
 *
 * Regression target: limit=-1 reached SQLite as LIMIT -1, which returns
 * every matching page, and a limit that isn't a number returned nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from '../app/api/pages/search/route';
import { seedPage, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle;

beforeEach(() => {
  handle = setupTestDb();
  for (let i = 0; i < 3; i++) {
    seedPage(handle.db, { page_id: `tram-${i}`, title: `Tram line ${i}` });
    handle.db.prepare('INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)').run(`tram-${i}`, `Tram line ${i}`, 'Lisbon trams.');
  }
});
afterEach(() => handle.cleanup());

async function count(limit: string): Promise<number> {
  const res = await GET(new Request(`http://test/api/pages/search?q=tram&limit=${limit}`));
  return ((await res.json()) as { count: number }).count;
}

describe('GET /api/pages/search keyword limit', () => {
  it('reads a negative or zero limit as 1, and a missing number as the default', async () => {
    expect(await count('-1')).toBe(1);
    expect(await count('0')).toBe(1);
    expect(await count('abc')).toBe(3);
    expect(await count('2')).toBe(2);
    expect(await count('1000')).toBe(3);
  });
});
