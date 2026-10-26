/**
 * GET /api/wiki/status — the snapshot behind MCP wiki_status. Pins that it
 * only reads (no activity rows, no settings, no network) and reports the
 * live gaps: names with no page, pages resting on one source (most linked
 * first), unlinked pages (never Saved Links), stale sources, failed links,
 * and the last manual health check's contradictions.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/api/wiki/status/route';
import { insertPageLink, logActivity } from '../lib/db';
import {
  getActivityCounts,
  seedExtraction,
  seedPage,
  seedProvenance,
  seedSource,
  setupTestDb,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

async function status() {
  const res = await GET();
  return (await res.json()) as Record<string, any>;
}

function seedWiki() {
  handle = setupTestDb();
  const db = handle.db;
  const a = seedSource(db, { title: 'Source A' });
  const b = seedSource(db, { title: 'Source B' });
  seedPage(db, { page_id: 'well-sourced', title: 'Well sourced', page_type: 'concept' });
  seedProvenance(db, 'well-sourced', a);
  seedProvenance(db, 'well-sourced', b);
  seedPage(db, { page_id: 'thin-linked', title: 'Thin but linked', page_type: 'entity' });
  seedProvenance(db, 'thin-linked', a);
  seedPage(db, { page_id: 'thin-lonely', title: 'Thin and lonely', page_type: 'concept' });
  seedProvenance(db, 'thin-lonely', b);
  seedPage(db, { page_id: 'note', title: 'A note', page_type: 'original-source' });
  seedProvenance(db, 'note', a);
  seedPage(db, { page_id: 'saved-links', title: 'Saved Links', page_type: 'overview' });
  insertPageLink('well-sourced', 'thin-linked', 'wikilink');
  return { a, b };
}

describe('wiki status', () => {
  it('reports gaps without writing anything or calling out', async () => {
    seedWiki();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (let i = 0; i < 3; i++) {
      const source_id = seedSource(handle!.db, { title: `Mention ${i}` });
      seedExtraction(handle!.db, { source_id, llm_output: { entities: [{ name: 'Vitalik Buterin', type: 'PERSON' }] } });
    }
    const activityBefore = getActivityCounts(handle!.db);
    const settingsBefore = handle!.db.prepare('SELECT COUNT(*) AS n FROM settings').get();

    const body = await status();

    expect(body.gaps.missing_pages).toEqual({ count: 1, top: [{ name: 'Vitalik Buterin', mentions: 3 }], capped: false });
    expect(body.gaps.thin_pages.top.map((p: { page_id: string }) => p.page_id)).toEqual(['thin-linked', 'thin-lonely']);
    expect(body.gaps.thin_pages.top[0].backlinks).toBe(1);
    const orphans = body.gaps.orphan_pages.top.map((p: { page_id: string }) => p.page_id);
    expect(orphans).toContain('thin-lonely');
    expect(orphans).not.toContain('saved-links');
    expect(body.compile_running).toBeNull();
    expect(body.pending_drafts).toBe(0);
    expect(body.last_health_check).toBeNull();

    expect(getActivityCounts(handle!.db)).toEqual(activityBefore);
    expect(handle!.db.prepare('SELECT COUNT(*) AS n FROM settings').get()).toEqual(settingsBefore);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists failed links, stale sources and the last health check contradictions', async () => {
    seedWiki();
    const db = handle!.db;
    db.prepare(
      `INSERT INTO ingest_failures (failure_id, source_url, title_hint, source_type, error, date_attempted)
       VALUES ('f1', 'https://b.test/', 'B test', 'url', 'dns_failed', datetime('now'))`
    ).run();
    const old = seedSource(db, { title: 'Old source' });
    db.prepare(`UPDATE sources SET date_ingested = datetime('now', '-400 days') WHERE source_id = ?`).run(old);
    logActivity('lint_complete', {
      source_id: null,
      details: {
        orphan_pages: [],
        stale_pages: [],
        missing_cross_refs: [],
        dead_provenance: [],
        contradictions: [
          { page_a_id: 'x', page_a_title: 'X', page_b_id: 'y', page_b_title: 'Y', claim: 'Dates differ', severity: 'minor' },
        ],
        run_duration_ms: 5,
      },
    });

    const body = await status();
    expect(body.failed_links).toMatchObject({ count: 1, top: [{ url: 'https://b.test/', error: 'dns_failed' }] });
    expect(body.stale_sources.count).toBe(1);
    expect(body.stale_sources.top[0].title).toBe('Old source');
    expect(body.last_health_check.contradictions).toEqual({
      count: 1,
      top: [{ page_a: 'X', page_b: 'Y', claim: 'Dates differ' }],
    });
  });
});
