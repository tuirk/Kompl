/**
 * Issue #8: a page archived because its rewrite after a source delete
 * failed (lib/page-hold.ts) comes back when a rewrite from its remaining
 * sources succeeds: the recompile of a later source delete, or the page
 * update in Settings > Wiki health, which offers it for exactly that.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { archivePage, getAllPages, searchPages } from '../lib/db';
import { CURRENT_DRAFT_RULES, countCurrentPages, listUpgradeCandidates } from '../lib/draft-rules';
import { getPageHold, holdPage } from '../lib/page-hold';
import { recompilePage } from '../lib/recompile';
import { redraftPage } from '../lib/redraft';
import { setupTestDb, seedSource, seedPage, seedProvenance, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

const BODY = 'Ethereum moved to proof-of-stake in 2022 and no longer relies on mining. '.repeat(4);

function draftMarkdown(): string {
  return ['---', 'title: Ethereum', 'page_type: entity', 'category: Crypto', 'summary: A chain.', '---', '', `${BODY} [S1]`, ''].join('\n');
}

interface Calls {
  draftTypes: string[];
}

function mockNlp(opts: { writeFails?: boolean } = {}): Calls {
  const calls: Calls = { draftTypes: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/pipeline/draft-page')) {
        calls.draftTypes.push((JSON.parse(String(init?.body ?? '{}')) as { page_type: string }).page_type);
        return Response.json({ markdown: draftMarkdown() });
      }
      if (u.endsWith('/storage/write-page')) {
        if (opts.writeFails) return new Response('disk full', { status: 500 });
        return Response.json({ current_path: '/data/pages/eth.md.gz', previous_path: null });
      }
      if (u.endsWith('/storage/read-file')) return new Response('no', { status: 404 });
      return Response.json({ ok: true });
    }),
  );
  return calls;
}

/** "Ethereum" with two remaining sources, archived after a failed rewrite. */
function seedHeldPage(h: TestDbHandle, draftRules: string | null = CURRENT_DRAFT_RULES): void {
  h.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('min_draft_chars', '100')").run();
  seedPage(h.db, { page_id: 'eth', title: 'Ethereum', page_type: 'entity', category: 'Crypto' });
  h.db.prepare('UPDATE pages SET draft_rules = ? WHERE page_id = ?').run(draftRules, 'eth');
  for (const sid of ['k1', 'k2']) {
    seedSource(h.db, { source_id: sid, title: `Source ${sid}`, raw_markdown: `Ethereum uses proof-of-stake (${sid}).` });
    seedProvenance(h.db, 'eth', sid);
  }
  expect(holdPage('eth', 'Kompl could not rewrite this page after the source "Old blog post" was deleted.')).toBe(true);
}

function pageRow(): { page_type: string; restore_page_type: string | null; archive_reason: string | null; pending_content: string | null } {
  return handle!.db
    .prepare('SELECT page_type, restore_page_type, archive_reason, pending_content FROM pages WHERE page_id = ?')
    .get('eth') as never;
}

describe('holdPage', () => {
  it('archives a live page once and leaves an archived page alone', () => {
    handle = setupTestDb();
    seedHeldPage(handle);
    expect(pageRow()).toMatchObject({ page_type: 'archived', restore_page_type: 'entity' });
    // Already archived: nothing to hold, the type to restore is kept.
    expect(holdPage('eth', 'again')).toBe(false);
    expect(pageRow().restore_page_type).toBe('entity');
  });

  it('is cleared when the page is archived for good (no sources left)', () => {
    handle = setupTestDb();
    seedHeldPage(handle);
    archivePage('eth');
    expect(pageRow()).toMatchObject({ page_type: 'archived', restore_page_type: null, archive_reason: null });
    expect(getPageHold('eth')).toBeNull();
  });
});

describe('a successful rewrite brings a held page back', () => {
  it('the recompile of a later source delete restores it with its own type', async () => {
    handle = setupTestDb();
    seedHeldPage(handle);
    const calls = mockNlp();

    await expect(recompilePage('eth', 'gone')).resolves.toEqual({ outcome: 'rewritten' });

    expect(calls.draftTypes).toEqual(['entity']);
    expect(pageRow()).toMatchObject({ page_type: 'entity', restore_page_type: null, archive_reason: null });
    expect(searchPages('stake').map((p) => p.page_id)).toContain('eth');
    expect(getAllPages().map((p) => p.page_id)).toContain('eth');
  });

  it('a recompile whose file write fails still counts: the new text is committed and flushed at boot', async () => {
    handle = setupTestDb();
    seedHeldPage(handle);
    mockNlp({ writeFails: true });

    await expect(recompilePage('eth', 'gone')).resolves.toEqual({ outcome: 'rewritten' });

    const row = pageRow();
    expect(row.page_type).toBe('entity');
    expect(row.pending_content).toContain('proof-of-stake');
  });

  it('the page update offers it even when its text follows the current rules, and restores it', async () => {
    handle = setupTestDb();
    seedHeldPage(handle, CURRENT_DRAFT_RULES);
    expect(listUpgradeCandidates().map((p) => p.page_id)).toEqual(['eth']);
    expect(countCurrentPages()).toBe(0);
    const calls = mockNlp();

    await redraftPage('eth');

    expect(calls.draftTypes).toEqual(['entity']);
    expect(pageRow()).toMatchObject({ page_type: 'entity', restore_page_type: null, archive_reason: null });
    expect(listUpgradeCandidates()).toEqual([]);
    expect(countCurrentPages()).toBe(1);
  });
});
