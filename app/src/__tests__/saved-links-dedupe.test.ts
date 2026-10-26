/**
 * Issue #139: Saved Links lists links that still need attention, one row
 * per link, not one row per failed attempt.
 *
 *   - A link is the address as lib/url-key.ts spells it (host case, a
 *     trailing slash), as the agent duplicate checks do.
 *   - A later failure of the same link updates its row: the newest error,
 *     and an attempt count.
 *   - Once the link is imported, in any session, its rows are marked
 *     resolved (kept, not deleted) and it leaves Saved Links.
 *   - Rows saved before this (duplicates, or links imported since) read as
 *     one row per link, and a link already in the wiki is left out.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  deleteIngestFailure,
  getUnresolvedLinks,
  insertIngestFailure,
  resolveIngestFailuresForUrl,
  type StagingRow,
} from '../lib/db';
import { runIngestUrlsStep } from '../lib/compile/steps/ingest-urls';
import { seedCompileProgress, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

function fail(url: string, error: string, session_id: string, title_hint: string | null = null): void {
  insertIngestFailure({ failure_id: randomUUID(), source_url: url, title_hint, error, session_id });
}

/** A row as an older version wrote it: a plain INSERT, no merge. */
function legacyRow(url: string, error: string, date: string, session_id = 'old'): string {
  const id = randomUUID();
  handle!.db
    .prepare(
      `INSERT INTO ingest_failures (failure_id, source_url, error, date_attempted, session_id) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, url, error, date, session_id);
  return id;
}

function rows(): Array<{ source_url: string; error: string; attempts: number; session_id: string | null; resolved_source_id: string | null }> {
  return handle!.db
    .prepare('SELECT source_url, error, attempts, session_id, resolved_source_id FROM ingest_failures ORDER BY date_attempted')
    .all() as never;
}

describe('a link that fails again', () => {
  it('updates its row with the newest error and counts the attempt', () => {
    handle = setupTestDb();
    fail('https://Example.com/post/', 'firecrawl_error: 403', 'sess-a', 'A post');
    fail('https://example.com/post', 'nlp_convert_timeout: slow', 'sess-b');

    expect(rows()).toEqual([
      { source_url: 'https://Example.com/post/', error: 'nlp_convert_timeout: slow', attempts: 2, session_id: 'sess-b', resolved_source_id: null },
    ]);
    const links = getUnresolvedLinks();
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ title: 'A post', error: 'nlp_convert_timeout: slow', attempts: 2 });
  });

  it('keeps links whose paths differ only in case apart', () => {
    handle = setupTestDb();
    fail('https://example.com/A', 'e1', 's');
    fail('https://example.com/a', 'e2', 's');
    expect(getUnresolvedLinks()).toHaveLength(2);
  });
});

describe('rows saved before', () => {
  it('read as one row per link with the newest error and every attempt counted', () => {
    handle = setupTestDb();
    legacyRow('https://example.com/x', 'old error', '2026-01-01 10:00:00');
    legacyRow('https://example.com/x/', 'newer error', '2026-02-01 10:00:00');
    legacyRow('https://example.com/y', 'y error', '2026-01-15 10:00:00');

    const links = getUnresolvedLinks();
    expect(links.map((l) => [l.error, l.attempts])).toEqual([
      ['newer error', 2],
      ['y error', 1],
    ]);
  });

  it('dismissing a link removes all of its rows, so no duplicate shows up in its place', () => {
    handle = setupTestDb();
    const first = legacyRow('https://example.com/x', 'old error', '2026-01-01 10:00:00');
    legacyRow('https://example.com/x/', 'newer error', '2026-02-01 10:00:00');
    expect(deleteIngestFailure(first)).toBe(true);
    expect(getUnresolvedLinks()).toEqual([]);
  });

  it('leave out a link that is already in the wiki', () => {
    handle = setupTestDb();
    legacyRow('https://example.com/x', 'old error', '2026-01-01 10:00:00');
    seedSource(handle.db, { source_id: 'src-x', title: 'X' });
    handle.db.prepare("UPDATE sources SET source_url = 'https://EXAMPLE.com/x/' WHERE source_id = 'src-x'").run();
    expect(getUnresolvedLinks()).toEqual([]);
  });
});

describe('a link imported later', () => {
  it('resolves its rows from every session and keeps them', () => {
    handle = setupTestDb();
    legacyRow('https://example.com/x', 'e1', '2026-01-01 10:00:00', 'sess-a');
    legacyRow('https://example.com/x/', 'e2', '2026-02-01 10:00:00', 'sess-b');
    seedSource(handle.db, { source_id: 'src-x', title: 'X' });

    expect(resolveIngestFailuresForUrl('https://example.com/x', 'src-x')).toBe(2);

    expect(rows().map((r) => r.resolved_source_id)).toEqual(['src-x', 'src-x']);
    expect(getUnresolvedLinks()).toEqual([]);
    // A later failure of the link starts a new unresolved row.
    fail('https://example.com/x', 'e3', 'sess-c');
    expect(rows().filter((r) => r.resolved_source_id === null)).toHaveLength(1);
  });

  it('is resolved by the URL import step, whatever session failed it', async () => {
    handle = setupTestDb();
    seedCompileProgress(handle.db, 'sess-new');
    legacyRow('https://example.com/x/', 'firecrawl_error: 403', '2026-01-01 10:00:00', 'sess-old');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (!String(input).endsWith('/convert/url')) return Response.json({});
        const { source_id, url } = JSON.parse(String(init?.body)) as { source_id: string; url: string };
        return Response.json({
          source_id,
          source_type: 'url',
          title: 'X',
          title_source: 'markitdown',
          source_url: url,
          markdown: 'Body text.',
          content_hash: 'hash-x',
          metadata: {},
        });
      }),
    );
    const row: StagingRow = {
      stage_id: 'stage-1',
      session_id: 'sess-new',
      connector: 'url',
      payload: { url: 'https://example.com/x' },
      included: true,
      status: 'pending',
      resolved_source_id: null,
      error_code: null,
      error_message: null,
      created_at: '2026-10-25 10:00:00',
      ingested_at: null,
    };

    await runIngestUrlsStep('sess-new', [row], () => {});

    const sourceId = (handle.db.prepare('SELECT source_id FROM sources').get() as { source_id: string }).source_id;
    expect(rows().map((r) => r.resolved_source_id)).toEqual([sourceId]);
    expect(getUnresolvedLinks()).toEqual([]);
  });
});
