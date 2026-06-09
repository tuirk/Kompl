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

  it('skips when lint disabled and not manual', async () => {
    setLintEnabled(false);
    const { res, body } = await postLint({});
    expect(res.ok).toBe(true);
    expect(body.skipped).toBe(true);
  });

  it('enriches contradiction titles from page pairs', async () => {
    seedPage(handle.db, {
      page_id: 'page-a',
      title: 'Alpha',
      category: 'Tech',
      summary: 'Alpha claims X',
    });
    seedPage(handle.db, {
      page_id: 'page-b',
      title: 'Beta',
      category: 'Tech',
      summary: 'Beta claims Y',
    });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        contradictions: [{
          page_a: 'page-a',
          page_b: 'page-b',
          claim: 'X vs Y',
          severity: 'major',
        }],
      }),
    } as Response);

    const { body } = await postLint();
    const contras = body.contradictions as Array<{
      page_a_id: string;
      page_a_title: string;
      page_b_title: string;
      claim: string;
    }>;
    expect(contras).toHaveLength(1);
    expect(contras[0].page_a_title).toBe('Alpha');
    expect(contras[0].page_b_title).toBe('Beta');
    expect(contras[0].claim).toBe('X vs Y');
  });

  it('finds missing cross-refs from extractions', async () => {
    const entity = 'Shared Entity Name';
    for (let i = 0; i < 3; i++) {
      const source_id = seedSource(handle.db, { source_id: `src-xref-${i}` });
      seedExtraction(handle.db, {
        source_id,
        ner_output: { entities: [{ text: entity }] },
      });
    }
    const { body } = await postLint();
    const refs = body.missing_cross_refs as Array<{ entity_text: string; mention_count: number }>;
    expect(refs.some((r) => r.entity_text === entity && r.mention_count >= 3)).toBe(true);
  });
});
