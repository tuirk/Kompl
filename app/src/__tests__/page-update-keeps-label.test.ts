/**
 * Updates keep the page's category and never blank its summary (plan 2.3,
 * audit finding B8).
 *
 * insertPage's upsert set category and summary to the update's values, so an
 * update draft without a `category:` line moved the page to "Uncategorized"
 * and one with another label moved it between categories. An update now
 * fills the category only when the page has none (as lib/page-rewrite.ts
 * does); a new summary replaces the old one, a missing one keeps it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as commitPOST } from '../app/api/compile/commit/route';
import { insertPage } from '../lib/db';
import { seedCompileProgress, seedPage, seedPagePlan, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

function row(page_id: string) {
  return handle!.db.prepare('SELECT category, summary FROM pages WHERE page_id = ?').get(page_id) as {
    category: string | null;
    summary: string | null;
  };
}

function upsert(page_id: string, category: string | null, summary: string | null): void {
  insertPage({
    page_id,
    title: 'Bitcoin',
    page_type: 'entity',
    category,
    summary,
    content_path: `/data/pages/${page_id}.md.gz`,
    previous_content_path: null,
  });
}

describe('insertPage on an existing page', () => {
  it('keeps the category and summary when the update has none', () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'btc', title: 'Bitcoin', category: 'Cryptocurrency', summary: 'A coin.' });
    upsert('btc', null, null);
    expect(row('btc')).toEqual({ category: 'Cryptocurrency', summary: 'A coin.' });
  });

  it('keeps the category but takes the new summary', () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'btc', title: 'Bitcoin', category: 'Cryptocurrency', summary: 'A coin.' });
    upsert('btc', 'Finance', 'The first coin.');
    expect(row('btc')).toEqual({ category: 'Cryptocurrency', summary: 'The first coin.' });
  });

  it('fills the category of a page that has none', () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'btc', title: 'Bitcoin', category: null, summary: null });
    upsert('btc', 'Cryptocurrency', 'A coin.');
    expect(row('btc')).toEqual({ category: 'Cryptocurrency', summary: 'A coin.' });
  });

  it('a new page takes both as given', () => {
    handle = setupTestDb();
    upsert('btc', 'Cryptocurrency', 'A coin.');
    expect(row('btc')).toEqual({ category: 'Cryptocurrency', summary: 'A coin.' });
  });
});

describe('compile commit of an update draft', () => {
  it('a draft without a category line leaves the page in its category', async () => {
    handle = setupTestDb();
    const db = handle.db;
    const session_id = 'sess-keep-label';
    seedCompileProgress(db, session_id);
    const source_id = seedSource(db, { onboarding_session_id: session_id });
    seedPage(db, { page_id: 'btc', title: 'Bitcoin', category: 'Cryptocurrency', summary: 'A coin.' });
    seedPagePlan(db, {
      session_id,
      title: 'Bitcoin',
      action: 'update',
      existing_page_id: 'btc',
      source_ids: [source_id],
      draft_status: 'crossreffed',
      draft_content: `---\ntitle: "Bitcoin"\n---\n\n${'Bitcoin is a currency. '.repeat(40)}`,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/storage/write-page')) {
          return new Response(JSON.stringify({ current_path: '/data/pages/btc.md.gz', previous_path: null }), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      })
    );

    const res = await commitPOST(
      new Request('http://test/api/compile/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id }),
      })
    );

    expect(res.status).toBe(200);
    expect(((await res.json()) as { committed: number }).committed).toBe(1);
    expect(row('btc')).toEqual({ category: 'Cryptocurrency', summary: 'A coin.' });
  });
});
