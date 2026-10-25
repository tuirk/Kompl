import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../app/api/wiki/lint-pass/route';
import { setupTestDb, seedPage, seedSource, seedExtraction, type TestDbHandle } from './helpers/test-db';
import { setLintEnabled } from '../lib/db';

describe('POST /api/wiki/lint-pass', () => {
  let handle: TestDbHandle;

  beforeEach(() => {
    handle = setupTestDb();
    setLintEnabled(true);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ contradictions: [] }),
    }));
  });

  afterEach(() => {
    handle.cleanup();
    vi.unstubAllGlobals();
  });

  async function postLint(body: Record<string, unknown> = { manual: true }) {
    const res = await POST(new Request('http://test/api/wiki/lint-pass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    return { res, body: await res.json() as Record<string, unknown> };
  }

  it('returns orphan_pages as objects with title', async () => {
    seedPage(handle.db, { page_id: 'lonely', title: 'Lonely Page' });
    const { body } = await postLint();
    const orphans = body.orphan_pages as Array<{ page_id: string; title: string }>;
    expect(orphans).toEqual(
      expect.arrayContaining([{ page_id: 'lonely', title: 'Lonely Page' }]),
    );
  });

  it('never lists Saved Links or an archived page as an orphan', async () => {
    seedPage(handle.db, { page_id: 'saved-links', title: 'Saved Links', page_type: 'overview' });
    seedPage(handle.db, { page_id: 'put-away', title: 'Put away', page_type: 'archived' });
    seedPage(handle.db, { page_id: 'lonely', title: 'Lonely Page' });
    const { body } = await postLint();
    const ids = (body.orphan_pages as Array<{ page_id: string }>).map((p) => p.page_id);
    expect(ids).toEqual(['lonely']);
  });

  it('returns stale source-summary pages with last_updated', async () => {
    const page_id = seedPage(handle.db, {
      page_id: 'stale-one',
      title: 'Old Summary',
      page_type: 'source-summary',
    });
    handle.db.prepare(
      `UPDATE pages SET last_updated = datetime('now', '-60 days') WHERE page_id = ?`,
    ).run(page_id);
    const { body } = await postLint();
    const stale = body.stale_pages as Array<{ page_id: string; title: string; last_updated: string }>;
    expect(stale.some((r) => r.page_id === page_id && r.title === 'Old Summary')).toBe(true);
  });

  it('returns dead provenance rows for dangling source_id', async () => {
    const page_id = seedPage(handle.db, { page_id: 'prov-page', title: 'Prov Page' });
    handle.db.pragma('foreign_keys = OFF');
    handle.db.prepare(
      `INSERT INTO provenance (source_id, page_id, content_hash, contribution_type)
       VALUES ('gone-source', ?, 'hash', 'created')`,
    ).run(page_id);
    handle.db.pragma('foreign_keys = ON');

    const { body } = await postLint();
    const dead = body.dead_provenance as Array<{ source_id: string; page_id: string; page_title: string }>;
    expect(dead).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_id: 'gone-source',
          page_id: 'prov-page',
          page_title: 'Prov Page',
        }),
      ]),
    );
  });

  it('stores full arrays in lint_complete activity log', async () => {
    seedPage(handle.db, { page_id: 'lonely', title: 'Lonely Page' });
    await postLint();
    const row = handle.db.prepare(
      `SELECT details FROM activity_log WHERE action_type = 'lint_complete' ORDER BY id DESC LIMIT 1`,
    ).get() as { details: string };
    const details = JSON.parse(row.details) as Record<string, unknown>;
    expect(Array.isArray(details.orphan_pages)).toBe(true);
    expect(typeof (details.orphan_pages as unknown[])[0]).toBe('object');
    expect(details.contradiction_count).toBeUndefined();
  });

  it('runs only when the user asks; older CLIs calling without manual are skipped', async () => {
    // lint_enabled is on (beforeEach): it no longer starts a pass on its own.
    const { res, body } = await postLint({});
    expect(res.ok).toBe(true);
    expect(body.skipped).toBe(true);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled(); // no LLM call

    const manual = await postLint({ manual: true });
    expect(manual.body.skipped).toBeUndefined();
  });

  it('no longer asks the LLM about page summaries: the whole-wiki check finds disagreements', async () => {
    // Two summaries in one category: the retired check 5 would have sent them.
    seedPage(handle.db, { page_id: 'page-a', title: 'Alpha', category: 'Tech', summary: 'Alpha claims X' });
    seedPage(handle.db, { page_id: 'page-b', title: 'Beta', category: 'Tech', summary: 'Beta claims Y' });

    const { body } = await postLint();

    // The only call left is the saved-links page refresh; nothing goes to an LLM route.
    const urls = vi.mocked(fetch).mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes('/pipeline/'))).toEqual([]);
    expect(body.contradictions).toEqual([]);
  });

  it('finds missing cross-refs: names the extraction found in 3+ sources', async () => {
    const entity = 'Shared Entity Name';
    for (let i = 0; i < 3; i++) {
      const source_id = seedSource(handle.db, { source_id: `src-xref-${i}` });
      seedExtraction(handle.db, {
        source_id,
        llm_output: { entities: [{ name: entity, type: 'CONCEPT' }] },
      });
    }
    const { body } = await postLint();
    const refs = body.missing_cross_refs as Array<{ entity_text: string; mention_count: number }>;
    expect(refs.some((r) => r.entity_text === entity && r.mention_count >= 3)).toBe(true);
  });

  it('does not report names that any page or alias already covers, whatever the case, or dates and ordinals', async () => {
    seedPage(handle.db, { page_id: 'btc', title: 'Bitcoin', page_type: 'concept' });
    seedPage(handle.db, { page_id: 'eth', title: 'Ethereum', page_type: 'entity' });
    handle.db
      .prepare(`INSERT INTO aliases (alias, canonical_name, canonical_page_id) VALUES ('ETH', 'Ethereum', 'eth')`)
      .run();
    for (let i = 0; i < 3; i++) {
      const source_id = seedSource(handle.db, { source_id: `src-covered-${i}` });
      seedExtraction(handle.db, {
        source_id,
        llm_output: {
          entities: [
            { name: 'bitcoin', type: 'ORG' },
            { name: 'eth', type: 'ORG' },
            { name: 'second', type: 'ORDINAL' },
            { name: '2009', type: 'DATE' },
            { name: 'Satoshi Nakamoto', type: 'PERSON' },
          ],
        },
      });
    }
    const { body } = await postLint();
    const refs = (body.missing_cross_refs as Array<{ entity_text: string }>).map((r) => r.entity_text);
    expect(refs).toEqual(['Satoshi Nakamoto']);
  });
});
