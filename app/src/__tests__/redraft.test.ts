/**
 * Page update ("redraft" internally) and Restore (lib/redraft.ts,
 * lib/page-rewrite.ts).
 *
 * Old pages only get the new prompt and cleanup when they are rebuilt from
 * all their sources (in bulk, from Settings > Wiki health). These tests pin
 * that an update never loses anything: guards refuse before any LLM call,
 * the commit follows the outbox order (DB first, file after), a thin or
 * failed draft leaves the page untouched, provenance never changes, the
 * previous version can be restored, and the draft_rules marker is set by an
 * update and kept by a restore.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { RedraftError, redraftPage, restorePreviousVersion } from '../lib/redraft';
import { DATA_ROOT } from '../lib/db';
import { CURRENT_DRAFT_RULES } from '../lib/draft-rules';
import {
  setupTestDb,
  seedSource,
  seedPage,
  seedProvenance,
  getActivityCounts,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

const A = '0b4db637-b010-431f-97c5-3dd25e8ed416';
const B = '77746c16-3ccf-4315-adc9-d0524be43038';
const GONE = 'a581a3ee-89e1-48c7-b741-4de2246919d3';

const LONG_BODY = 'Proof-of-work secures Bitcoin by making miners spend energy on each block. '.repeat(4);

function draftMarkdown(body: string): string {
  return [
    '---',
    'title: Proof-of-work',
    'page_type: concept',
    'category: Cryptocurrency',
    'summary: New summary.',
    'last_updated: 2025-01-01',
    'sources:',
    '  - source_id: S1',
    '---',
    '',
    body,
    '',
  ].join('\n');
}

interface MockOptions {
  draft?: { status?: number; markdown?: string };
  duringDraft?: () => void;
  /** How many /vectors/upsert attempts fail before one succeeds. */
  vectorFailures?: number;
}

interface MockCalls {
  draftBodies: Array<Record<string, unknown>>;
  writes: Array<{ markdown: string; pendingAtWrite: string | null }>;
  vectorUpserts: number;
}

function mockNlp(pageId: string, opts: MockOptions = {}): MockCalls {
  const calls: MockCalls = { draftBodies: [], writes: [], vectorUpserts: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/pipeline/draft-page')) {
        calls.draftBodies.push(JSON.parse(String(init?.body ?? '{}')));
        opts.duringDraft?.();
        const status = opts.draft?.status ?? 200;
        if (status !== 200) return new Response('upstream error', { status });
        return Response.json({ markdown: opts.draft?.markdown ?? draftMarkdown(`One claim [S1]. ${LONG_BODY}`) });
      }
      if (u.endsWith('/storage/write-page')) {
        const { markdown } = JSON.parse(String(init?.body ?? '{}')) as { markdown: string };
        const row = handle!.db.prepare('SELECT pending_content FROM pages WHERE page_id = ?').get(pageId) as {
          pending_content: string | null;
        };
        calls.writes.push({ markdown, pendingAtWrite: row.pending_content });
        return Response.json({
          current_path: `/data/pages/${pageId}.md.gz`,
          previous_path: `/data/pages/${pageId}.20261009-120000-000000.md.gz`,
        });
      }
      if (u.endsWith('/vectors/upsert')) {
        calls.vectorUpserts++;
        if (calls.vectorUpserts <= (opts.vectorFailures ?? 0)) return new Response('busy', { status: 503 });
        return Response.json({ ok: true });
      }
      return new Response('not found', { status: 404 });
    }),
  );
  return calls;
}

function seedRedraftablePage(h: TestDbHandle): string {
  h.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('min_draft_chars', '100')").run();
  seedSource(h.db, { source_id: A, title: 'Bitcoin Basics', raw_markdown: 'Bitcoin uses proof-of-work.' });
  seedSource(h.db, { source_id: B, title: 'BTC vs ETH Comparison', raw_markdown: 'Bitcoin uses proof-of-work, Ethereum proof-of-stake.' });
  seedSource(h.db, { source_id: GONE, title: 'Archived note', raw_markdown: 'Old.' });
  h.db.prepare("UPDATE sources SET status = 'archived' WHERE source_id = ?").run(GONE);
  const pageId = seedPage(h.db, { page_id: 'pow-page', title: 'Proof-of-work', page_type: 'concept', category: 'Cryptocurrency', summary: 'Old summary.' });
  seedPage(h.db, { page_id: 'bb-page', title: 'Bitcoin Basics', page_type: 'original-source' });
  seedPage(h.db, { page_id: 'sn-page', title: 'Satoshi Nakamoto', page_type: 'entity' });
  seedProvenance(h.db, pageId, A);
  seedProvenance(h.db, pageId, B);
  seedProvenance(h.db, pageId, B, 'updated');
  seedProvenance(h.db, pageId, GONE);
  // The current version is on disk, as for any flushed page.
  const file = path.join(DATA_ROOT, 'pages', `${pageId}.md.gz`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(draftMarkdown('Old body.'))));
  return pageId;
}

function provenanceOf(pageId: string): unknown[] {
  return handle!.db.prepare('SELECT * FROM provenance WHERE page_id = ? ORDER BY id').all(pageId);
}

async function expectRedraftError(p: Promise<unknown>, code: string, status: number): Promise<void> {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof RedraftError && e.code === code && e.status === status);
}

describe('redraftPage guards', () => {
  it('refuses unknown pages, source pages and the Saved Links page without an LLM call', async () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'note', title: 'Note', page_type: 'original-source' });
    seedPage(handle.db, { page_id: 'saved-links', title: 'Saved Links', page_type: 'overview' });
    const calls = mockNlp('note');
    await expectRedraftError(redraftPage('missing'), 'page_not_found', 404);
    await expectRedraftError(redraftPage('note'), 'page_not_redraftable', 422);
    await expectRedraftError(redraftPage('saved-links'), 'page_not_redraftable', 422);
    expect(calls.draftBodies).toHaveLength(0);
  });

  it('words its refusals as an update, not a redraft or rewrite', async () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'note', title: 'Note', page_type: 'original-source' });
    seedPage(handle.db, { page_id: 'lonely', title: 'Lonely', page_type: 'concept' });
    mockNlp('note');
    const messages: string[] = [];
    for (const id of ['note', 'lonely']) {
      await redraftPage(id).catch((e: unknown) => messages.push((e as RedraftError).message));
    }
    expect(messages).toEqual([
      'Only pages Kompl writes from sources can be updated.',
      "None of this page's sources could be read, so it cannot be updated.",
    ]);
    for (const m of messages) expect(m).not.toMatch(/redraft|rewrit/i);
  });

  it('refuses while a compile runs', async () => {
    handle = setupTestDb();
    const pageId = seedRedraftablePage(handle);
    handle.db.prepare("INSERT INTO compile_progress (session_id, status, steps, source_count) VALUES ('s1', 'queued', '[]', 1)").run();
    const calls = mockNlp(pageId);
    await expectRedraftError(redraftPage(pageId), 'session_in_progress', 409);
    expect(calls.draftBodies).toHaveLength(0);
  });

  it('refuses a second redraft of the same page while the first runs', async () => {
    handle = setupTestDb();
    const pageId = seedRedraftablePage(handle);
    let secondError: unknown = null;
    let second: Promise<void> | null = null;
    mockNlp(pageId, {
      duringDraft: () => {
        second = redraftPage(pageId).then(
          () => undefined,
          (e: unknown) => {
            secondError = e;
          },
        );
      },
    });
    await redraftPage(pageId);
    await second;
    expect(secondError).toBeInstanceOf(RedraftError);
    expect((secondError as RedraftError).code).toBe('page_action_in_progress');
    expect((secondError as RedraftError).message).toBe('This page is already being updated or restored.');
  });

  it('refuses a page whose last save has not reached disk', async () => {
    handle = setupTestDb();
    const pageId = seedRedraftablePage(handle);
    handle.db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run('unsaved', pageId);
    const calls = mockNlp(pageId);
    await expectRedraftError(redraftPage(pageId), 'page_flush_pending', 409);
    await expectRedraftError(restorePreviousVersion(pageId), 'page_flush_pending', 409);
    expect(calls.draftBodies).toHaveLength(0);
  });
});

describe('redraftPage', () => {
  it('drafts from all active sources and commits DB-first, file after', async () => {
    handle = setupTestDb();
    const pageId = seedRedraftablePage(handle);
    const provenanceBefore = provenanceOf(pageId);
    const calls = mockNlp(pageId);

    const result = await redraftPage(pageId);

    expect(result).toMatchObject({ status: 'redrafted', model: 'deepseek-flash', sources_used: 2, sources_skipped: 1, flushed: true });
    const body = calls.draftBodies[0];
    expect(body.existing_content).toBeNull();
    expect(body.compile_model).toBe('deepseek-flash');
    expect((body.source_contents as Array<{ source_id: string; citation_label: string }>).map((s) => [s.source_id, s.citation_label])).toEqual([
      [A, 'S1'],
      [B, 'S2'],
    ]);
    // Source pages and the page itself are never link targets.
    expect(body.existing_page_titles).toEqual(['Satoshi Nakamoto']);

    // Outbox: pending_content held the new page when the file was written…
    expect(calls.writes).toHaveLength(1);
    expect(calls.writes[0].pendingAtWrite).toBe(calls.writes[0].markdown);
    const stored = calls.writes[0].markdown;
    expect(stored).toContain(`One claim[^${A}].`);
    expect(stored).not.toContain('last_updated');
    expect(stored).not.toContain('source_id: S1');
    // …and is cleared afterwards, with the archive recorded as the previous version.
    const row = handle.db.prepare('SELECT * FROM pages WHERE page_id = ?').get(pageId) as Record<string, unknown>;
    expect(row.pending_content).toBeNull();
    expect(row.previous_content_path).toBe(`/data/pages/${pageId}.20261009-120000-000000.md.gz`);
    expect(row.summary).toBe('New summary.');
    expect(row.category).toBe('Cryptocurrency');
    expect(row.source_count).toBe(1);
    // The page now follows the current writing rules (committed in Phase 2).
    expect(row.draft_rules).toBe(CURRENT_DRAFT_RULES);
    // Provenance is never touched.
    expect(provenanceOf(pageId)).toEqual(provenanceBefore);
    expect(getActivityCounts(handle.db).page_redrafted).toBe(1);
  });

  it('marks the page in the same transaction that stores the new text', async () => {
    handle = setupTestDb();
    const pageId = seedRedraftablePage(handle);
    let rulesAtWrite: unknown = 'unread';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith('/pipeline/draft-page')) {
          return Response.json({ markdown: draftMarkdown(`One claim [S1]. ${LONG_BODY}`) });
        }
        if (u.endsWith('/storage/write-page')) {
          const row = handle!.db.prepare('SELECT draft_rules, pending_content FROM pages WHERE page_id = ?').get(pageId) as {
            draft_rules: string | null;
            pending_content: string | null;
          };
          rulesAtWrite = row.pending_content === null ? 'no pending content' : row.draft_rules;
          return new Response('disk full', { status: 500 });
        }
        return new Response('not found', { status: 404 });
      }),
    );

    const result = await redraftPage(pageId);
    // The file write failed: the outbox keeps the text for the boot reconciler,
    // and the marker is already committed with it.
    expect(result.flushed).toBe(false);
    expect(rulesAtWrite).toBe(CURRENT_DRAFT_RULES);
  });

  it('drafts with the model a bulk update locked, not the current setting', async () => {
    handle = setupTestDb();
    const pageId = seedRedraftablePage(handle);
    const calls = mockNlp(pageId);
    const result = await redraftPage(pageId, { model: 'gemini-3.8-flash' });
    expect(result.model).toBe('gemini-3.8-flash');
    expect(calls.draftBodies[0].compile_model).toBe('gemini-3.8-flash');
  });

  it('refreshes the page vector after the save, retrying a failed attempt like a compile', async () => {
    handle = setupTestDb();
    const pageId = seedRedraftablePage(handle);
    const calls = mockNlp(pageId, { vectorFailures: 1 });

    await redraftPage(pageId);

    // Fire-and-forget after the save: wait for the retry (500 ms backoff).
    await vi.waitFor(() => expect(calls.vectorUpserts).toBe(2), { timeout: 3_000 });
    const queued = handle.db.prepare('SELECT COUNT(*) AS n FROM vector_backfill_queue').get() as { n: number };
    expect(queued.n).toBe(0); // the retry succeeded, so nothing is left for a backfill
  });

  it('leaves the page untouched when the draft is too thin', async () => {
    handle = setupTestDb();
    const pageId = seedRedraftablePage(handle);
    const before = handle.db.prepare('SELECT * FROM pages WHERE page_id = ?').get(pageId);
    const calls = mockNlp(pageId, { draft: { markdown: draftMarkdown('Too short [S1].') } });
    await expectRedraftError(redraftPage(pageId), 'draft_too_thin', 422);
    expect(calls.writes).toHaveLength(0);
    expect(handle.db.prepare('SELECT * FROM pages WHERE page_id = ?').get(pageId)).toEqual(before);
    expect(getActivityCounts(handle.db).page_redraft_failed).toBe(1);
  });

  it('leaves the page untouched when the cost ceiling is reached', async () => {
    handle = setupTestDb();
    const pageId = seedRedraftablePage(handle);
    const before = handle.db.prepare('SELECT * FROM pages WHERE page_id = ?').get(pageId);
    const calls = mockNlp(pageId, { draft: { status: 503 } });
    await expectRedraftError(redraftPage(pageId), 'daily_cost_ceiling', 503);
    expect(calls.writes).toHaveLength(0);
    expect(handle.db.prepare('SELECT * FROM pages WHERE page_id = ?').get(pageId)).toEqual(before);
  });

  it('never overwrites a page that changed during the LLM call', async () => {
    handle = setupTestDb();
    const pageId = seedRedraftablePage(handle);
    const calls = mockNlp(pageId, { duringDraft: () => seedProvenance(handle!.db, pageId, A, 'updated') });
    await expectRedraftError(redraftPage(pageId), 'page_changed', 409);
    expect(calls.writes).toHaveLength(0);
  });
});

describe('restorePreviousVersion', () => {
  it('puts the archived version back through the outbox', async () => {
    handle = setupTestDb();
    const pageId = seedPage(handle.db, { page_id: 'restore-page', title: 'Restore me', page_type: 'concept' });
    const archive = path.join(DATA_ROOT, 'pages', `${pageId}.20261001-090000-000000.md.gz`);
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(archive, zlib.gzipSync(Buffer.from('---\ntitle: Restore me\n---\n\nThe older text.\n')));
    handle.db.prepare('UPDATE pages SET previous_content_path = ? WHERE page_id = ?').run(archive, pageId);
    handle.db.prepare('UPDATE pages SET draft_rules = ? WHERE page_id = ?').run(CURRENT_DRAFT_RULES, pageId);
    const calls = mockNlp(pageId);

    const result = await restorePreviousVersion(pageId);

    expect(result).toEqual({ page_id: pageId, status: 'restored', flushed: true });
    expect(calls.writes[0].markdown).toBe('---\ntitle: Restore me\n---\n\nThe older text.\n');
    expect(calls.draftBodies).toHaveLength(0);
    expect(getActivityCounts(handle.db).page_version_restored).toBe(1);
    // The user chose this text: the marker stays, so a bulk update never
    // rewrites a restored page on its own.
    const row = handle.db.prepare('SELECT draft_rules FROM pages WHERE page_id = ?').get(pageId) as { draft_rules: string | null };
    expect(row.draft_rules).toBe(CURRENT_DRAFT_RULES);
  });

  it('leaves a page written by an earlier version waiting for an update', async () => {
    handle = setupTestDb();
    const pageId = seedPage(handle.db, { page_id: 'old-restore', title: 'Old page', page_type: 'entity' });
    const archive = path.join(DATA_ROOT, 'pages', `${pageId}.20261001-090000-000000.md.gz`);
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(archive, zlib.gzipSync(Buffer.from('---\ntitle: Old page\n---\n\nEven older text.\n')));
    handle.db.prepare('UPDATE pages SET previous_content_path = ? WHERE page_id = ?').run(archive, pageId);
    mockNlp(pageId);

    await restorePreviousVersion(pageId);

    const row = handle.db.prepare('SELECT draft_rules FROM pages WHERE page_id = ?').get(pageId) as { draft_rules: string | null };
    expect(row.draft_rules).toBeNull();
  });

  it('reports a missing previous version', async () => {
    handle = setupTestDb();
    const pageId = seedPage(handle.db, { page_id: 'no-history', title: 'No history', page_type: 'concept' });
    mockNlp(pageId);
    await expectRedraftError(restorePreviousVersion(pageId), 'no_previous_version', 404);
  });
});
