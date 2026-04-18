/**
 * End-to-end coverage for the stale-wikilink invariant — proves that
 * commitSinglePlan (the approve flow) actually wires syncPageWikilinks
 * correctly, so a second approval on the same page_id with a different
 * draft_content cleans up [[wikilinks]] dropped from the new content.
 *
 * Unit-level coverage of syncPageWikilinks itself lives in
 * wikilink-sync.test.ts. This test exists to catch a regression where
 * someone removes the syncPageWikilinks call from commitSinglePlan.
 *
 * Pattern: approve plan v1 (page X cites [[Beta]]) → approve plan v2 with
 * action='update' targeting the same page (no [[Beta]]) → assert the
 * stale page_links row is gone.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  setupTestDb,
  seedPage,
  seedPagePlan,
  type TestDbHandle,
} from './helpers/test-db';
import { commitSinglePlan } from '../lib/approve-plan';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

function mockNlpServiceFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/storage/write-page')) {
        return new Response(
          JSON.stringify({ current_path: '/data/pages/x.md.gz', previous_path: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200 });
    }),
  );
}

function getWikilinks(db: TestDbHandle['db'], fromPageId: string): string[] {
  return (
    db
      .prepare(
        `SELECT target_page_id FROM page_links
          WHERE source_page_id = ? AND link_type = 'wikilink'
       ORDER BY target_page_id`,
      )
      .all(fromPageId) as Array<{ target_page_id: string }>
  ).map((r) => r.target_page_id);
}

describe('end-to-end: commitSinglePlan cleans stale wikilinks on re-approval', () => {
  it('drops a [[wikilink]] from page_links when the next draft removes it', async () => {
    handle = setupTestDb();
    mockNlpServiceFetch();

    // Target page Beta exists in the title map so [[Beta]] resolves.
    const beta = seedPage(handle.db, { page_id: 'beta', title: 'Beta' });
    const gamma = seedPage(handle.db, { page_id: 'gamma', title: 'Gamma' });

    // First approval — creates page Alpha with [[Beta]] link.
    const plan_v1 = seedPagePlan(handle.db, {
      session_id: 'sess-v1',
      title: 'Alpha',
      draft_status: 'pending_approval',
      action: 'create',
      draft_content: '---\ncategory: Test\nsummary: v1\n---\nSee [[Beta]] for context.',
    });
    const r1 = await commitSinglePlan(plan_v1);
    expect(r1.ok).toBe(true);
    const alpha_id = r1.ok ? r1.page_id : '';
    expect(getWikilinks(handle.db, alpha_id)).toEqual(['beta']);

    // Second approval on the SAME page_id (action=update) — body now cites
    // [[Gamma]] instead of [[Beta]]. Must drop the stale beta link.
    const plan_v2 = seedPagePlan(handle.db, {
      session_id: 'sess-v2',
      title: 'Alpha',
      draft_status: 'pending_approval',
      action: 'update',
      existing_page_id: alpha_id,
      draft_content: '---\ncategory: Test\nsummary: v2\n---\nSee [[Gamma]] now.',
    });
    const r2 = await commitSinglePlan(plan_v2);
    expect(r2.ok).toBe(true);
    expect(getWikilinks(handle.db, alpha_id)).toEqual(['gamma']);
    // Sanity: beta and gamma were never deleted; only the link rows changed.
    expect(beta).toBe('beta');
    expect(gamma).toBe('gamma');
  });

  it('drops every [[wikilink]] when the next draft has none', async () => {
    handle = setupTestDb();
    mockNlpServiceFetch();
    seedPage(handle.db, { page_id: 'beta', title: 'Beta' });

    const plan_v1 = seedPagePlan(handle.db, {
      session_id: 'sess-v1',
      title: 'Solo',
      draft_status: 'pending_approval',
      action: 'create',
      draft_content: '---\n---\nReferences [[Beta]].',
    });
    const r1 = await commitSinglePlan(plan_v1);
    expect(r1.ok).toBe(true);
    const solo_id = r1.ok ? r1.page_id : '';
    expect(getWikilinks(handle.db, solo_id)).toEqual(['beta']);

    const plan_v2 = seedPagePlan(handle.db, {
      session_id: 'sess-v2',
      title: 'Solo',
      draft_status: 'pending_approval',
      action: 'update',
      existing_page_id: solo_id,
      draft_content: '---\n---\nNo links here at all.',
    });
    const r2 = await commitSinglePlan(plan_v2);
    expect(r2.ok).toBe(true);
    expect(getWikilinks(handle.db, solo_id)).toEqual([]);
  });
});
