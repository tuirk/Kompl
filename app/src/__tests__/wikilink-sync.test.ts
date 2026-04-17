/**
 * Regression — syncPageWikilinks must DELETE existing 'wikilink' rows for
 * the source page before re-inserting current ones.
 *
 * Bug from CLAUDE.md "stale wikilinks" entry: removed [[wikilinks]] were
 * never deleted on recompile, leaving phantom backlinks on the target page
 * forever. The fix lives in lib/wikilinks.ts; this test pins the invariant
 * so a regression in either commit/route.ts or recompile.ts is caught.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { setupTestDb, seedPage, type TestDbHandle } from './helpers/test-db';
import { syncPageWikilinks } from '../lib/wikilinks';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function getWikilinks(db: TestDbHandle['db'], fromPageId: string): Array<{
  target_page_id: string;
  link_type: string;
}> {
  return db
    .prepare(
      `SELECT target_page_id, link_type FROM page_links
        WHERE source_page_id = ? ORDER BY id ASC`
    )
    .all(fromPageId) as Array<{ target_page_id: string; link_type: string }>;
}

describe('syncPageWikilinks', () => {
  it('inserts one row per resolvable [[wikilink]] target', () => {
    handle = setupTestDb();
    const a = seedPage(handle.db, { page_id: 'a', title: 'Alpha' });
    const b = seedPage(handle.db, { page_id: 'b', title: 'Beta' });
    const c = seedPage(handle.db, { page_id: 'c', title: 'Gamma' });
    const titleMap = new Map([['alpha', a], ['beta', b], ['gamma', c]]);

    syncPageWikilinks(handle.db, a, 'See [[Beta]] and [[Gamma]] for context.', titleMap);

    const links = getWikilinks(handle.db, a);
    expect(links.map((l) => l.target_page_id).sort()).toEqual(['b', 'c']);
    expect(links.every((l) => l.link_type === 'wikilink')).toBe(true);
  });

  it('removes stale wikilinks when the new markdown drops a target', () => {
    // The original bug: page A used to link to [[Beta]]; on recompile the
    // [[Beta]] was removed but the row in page_links survived, producing a
    // phantom backlink on Beta's page forever.
    handle = setupTestDb();
    const a = seedPage(handle.db, { page_id: 'a', title: 'Alpha' });
    const b = seedPage(handle.db, { page_id: 'b', title: 'Beta' });
    const titleMap = new Map([['alpha', a], ['beta', b]]);

    syncPageWikilinks(handle.db, a, 'Initial draft mentions [[Beta]].', titleMap);
    expect(getWikilinks(handle.db, a).map((l) => l.target_page_id)).toEqual(['b']);

    syncPageWikilinks(handle.db, a, 'Recompiled draft no longer mentions Beta.', titleMap);
    expect(getWikilinks(handle.db, a)).toEqual([]);
  });

  it('replaces the link set when a target swaps', () => {
    handle = setupTestDb();
    const a = seedPage(handle.db, { page_id: 'a', title: 'Alpha' });
    const b = seedPage(handle.db, { page_id: 'b', title: 'Beta' });
    const c = seedPage(handle.db, { page_id: 'c', title: 'Gamma' });
    const titleMap = new Map([['alpha', a], ['beta', b], ['gamma', c]]);

    syncPageWikilinks(handle.db, a, 'See [[Beta]].', titleMap);
    syncPageWikilinks(handle.db, a, 'See [[Gamma]] instead.', titleMap);

    const links = getWikilinks(handle.db, a);
    expect(links.map((l) => l.target_page_id)).toEqual(['c']);
  });

  it('dedupes when the same target is referenced multiple times', () => {
    handle = setupTestDb();
    const a = seedPage(handle.db, { page_id: 'a', title: 'Alpha' });
    const b = seedPage(handle.db, { page_id: 'b', title: 'Beta' });
    const titleMap = new Map([['alpha', a], ['beta', b]]);

    syncPageWikilinks(handle.db, a, '[[Beta]] [[beta]] [[BETA]]', titleMap);

    expect(getWikilinks(handle.db, a)).toEqual([{ target_page_id: 'b', link_type: 'wikilink' }]);
  });

  it('skips self-links and unknown titles silently', () => {
    handle = setupTestDb();
    const a = seedPage(handle.db, { page_id: 'a', title: 'Alpha' });
    const titleMap = new Map([['alpha', a]]);

    syncPageWikilinks(handle.db, a, 'Self-ref [[Alpha]] and unknown [[Nobody]].', titleMap);

    expect(getWikilinks(handle.db, a)).toEqual([]);
  });

  it('only deletes link_type = wikilink — leaves provenance/entity-ref untouched', () => {
    handle = setupTestDb();
    const a = seedPage(handle.db, { page_id: 'a', title: 'Alpha' });
    const b = seedPage(handle.db, { page_id: 'b', title: 'Beta' });
    handle.db
      .prepare(
        `INSERT INTO page_links (source_page_id, target_page_id, link_type)
         VALUES (?, ?, 'provenance')`
      )
      .run(a, b);
    handle.db
      .prepare(
        `INSERT INTO page_links (source_page_id, target_page_id, link_type)
         VALUES (?, ?, 'entity-ref')`
      )
      .run(a, b);

    syncPageWikilinks(handle.db, a, 'No [[wikilinks]] here.', new Map());

    const remaining = handle.db
      .prepare(
        `SELECT link_type FROM page_links WHERE source_page_id = ? ORDER BY id`
      )
      .all(a) as Array<{ link_type: string }>;
    expect(remaining.map((r) => r.link_type).sort()).toEqual(['entity-ref', 'provenance']);
  });
});
