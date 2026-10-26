/**
 * GET /api/wiki/changes — the history behind MCP recent_changes: what
 * changed since a time (every source credited, created vs updated), one
 * compile session (each staged item's fate), and one page (its compiles,
 * events and the sections that differ from its previous version).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '../app/api/wiki/changes/route';
import { DATA_ROOT, logActivity, setSourceStatus } from '../lib/db';
import { importTriageVerdicts, listPageDisagreements, recordDisagreement, setOwnerVerdict, syncPageTextDisagreements } from '../lib/disagreements';
import { seedPage, seedProvenance, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

async function changes(query: string) {
  const res = await GET(new Request(`http://test/api/wiki/changes?${query}`));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('changes since', () => {
  it('credits every source behind a change and tells created from updated', async () => {
    handle = setupTestDb();
    const db = handle.db;
    const a = seedSource(db, { title: 'Source A' });
    const b = seedSource(db, { title: 'Source B' });
    seedPage(db, { page_id: 'new-page', title: 'New page' });
    seedProvenance(db, 'new-page', a);
    seedProvenance(db, 'new-page', b);
    seedPage(db, { page_id: 'old-page', title: 'Old page' });
    db.prepare(`UPDATE pages SET created_at = datetime('now', '-30 days') WHERE page_id = 'old-page'`).run();
    seedProvenance(db, 'old-page', b);
    seedPage(db, { page_id: 'untouched', title: 'Untouched' });
    db.prepare(
      `UPDATE pages SET created_at = datetime('now', '-30 days'), last_updated = datetime('now', '-30 days')
        WHERE page_id = 'untouched'`
    ).run();
    syncPageTextDisagreements(db, { page_id: 'old-page', title: 'Old page' }, `### Disputed: founding date\n\n1323[^${a}] or 1320[^${b}].`);
    logActivity('ingest_url_failed', { source_id: null, details: { url: 'https://b.test/', error: 'dns' } });

    const { status, body } = await changes('days=7');
    expect(status).toBe(200);
    expect(body.mode).toBe('since');
    expect(body.sources_added.total).toBe(2);
    const pages = body.pages.items as Array<{ page_id: string; change: string; sources: Array<{ title: string }> }>;
    expect(pages.map((p) => p.page_id).sort()).toEqual(['new-page', 'old-page']);
    const created = pages.find((p) => p.page_id === 'new-page')!;
    expect(created.change).toBe('created');
    expect(created.sources.map((s) => s.title).sort()).toEqual(['Source A', 'Source B']);
    expect(pages.find((p) => p.page_id === 'old-page')!.change).toBe('updated');
    expect(body.disputes.items[0]).toMatchObject({
      kind: 'disputed',
      page_id: 'old-page',
      detail: 'Founding date',
      status: 'possible',
      found_by: 'page_text',
    });
    expect(body.failures.items[0]).toMatchObject({ kind: 'ingest_url_failed', detail: 'dns' });
  });

  it('lists the disagreements record: every finder, the owner\'s dismissals left out', async () => {
    handle = setupTestDb();
    const db = handle.db;
    const a = seedSource(db, { title: 'Source A' });
    const b = seedSource(db, { title: 'Flagging source' });
    seedPage(db, { page_id: 'p', title: 'Page' });
    syncPageTextDisagreements(db, { page_id: 'p', title: 'Page' }, `### Changed: the limit\n\n10[^${a}], now 20[^${b}].`);
    recordDisagreement(db, { page_id: 'p', found_by: 'triage', kind: 'contradiction', source_b: b, reason: 'Another year' });
    // Logged before the record existed: taken in by the backfill.
    logActivity('page_contradiction_detected', { source_id: a, details: { page_id: 'p', reason: 'Older figure' } });
    importTriageVerdicts(db);
    const dismissed = recordDisagreement(db, { page_id: 'p', found_by: 'wiki_check', kind: 'scope', key: 'x' });
    setOwnerVerdict(dismissed.disagreement_id, 'dismissed');
    setOwnerVerdict(listPageDisagreements('p')[0].disagreement_id, 'confirmed');

    const { body } = await changes('days=1');
    expect(body.disputes.total).toBe(3);
    const items = body.disputes.items as Array<Record<string, unknown>>;
    expect(items.map((i) => [i.kind, i.found_by, i.status, i.detail, i.source_title]).sort()).toEqual([
      ['changed', 'page_text', 'confirmed', 'The limit', null],
      ['contradiction', 'triage', 'possible', 'Another year', 'Flagging source'],
      ['contradiction', 'triage', 'possible', 'Older figure', 'Source A'],
    ]);
  });

  it('lists pages rewritten without a new source and leaves out archived pages', async () => {
    handle = setupTestDb();
    const db = handle.db;
    seedPage(db, { page_id: 'redrafted', title: 'Redrafted' });
    db.prepare(`UPDATE pages SET created_at = datetime('now', '-30 days') WHERE page_id = 'redrafted'`).run();
    const lone = seedSource(db, { title: 'Lone' });
    seedPage(db, { page_id: 'hidden', title: 'Hidden' });
    seedProvenance(db, 'hidden', lone);
    setSourceStatus(lone, 'archived');

    const { body } = await changes('days=1');
    expect(body.pages.items).toEqual([
      expect.objectContaining({ page_id: 'redrafted', change: 'updated', sources: [], source_total: 0 }),
    ]);
  });

  it('accepts ISO times and rejects nonsense', async () => {
    handle = setupTestDb();
    expect((await changes('since=2026-10-09T18:00:00Z')).status).toBe(200);
    const bad = await changes('since=last%20tuesday');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_since');
  });
});

describe('changes in a session', () => {
  it('reports progress, each staged item and what the session changed', async () => {
    handle = setupTestDb();
    const db = handle.db;
    db.prepare(
      `INSERT INTO compile_progress (session_id, status, steps, started_at) VALUES ('s1', 'completed', '{}', datetime('now', '-1 minute'))`
    ).run();
    const insertStage = db.prepare(
      `INSERT INTO collect_staging (stage_id, session_id, connector, payload, status, error_message) VALUES (?, 's1', 'url', ?, ?, ?)`
    );
    insertStage.run('st1', JSON.stringify({ url: 'https://ok.test/' }), 'ingested', null);
    insertStage.run('st2', JSON.stringify({ url: 'https://bad.test/' }), 'failed', 'Could not fetch the page');
    const src = seedSource(db, { title: 'OK article', onboarding_session_id: 's1' });
    seedPage(db, { page_id: 'p1', title: 'Page one' });
    seedProvenance(db, 'p1', src);

    const { body } = await changes('session_id=s1');
    expect(body).toMatchObject({ mode: 'session', session_id: 's1', status: 'completed' });
    expect(body.staged).toEqual({
      items: [
        { item: 'https://ok.test/', status: 'ingested', error: null },
        { item: 'https://bad.test/', status: 'failed', error: 'Could not fetch the page' },
      ],
      total: 2,
    });
    expect(body.sources_added.items.map((s: { title: string }) => s.title)).toEqual(['OK article']);
    expect(body.sources_added.items[0].onboarding_session_id).toBe('s1');
    expect(body.pages.items.map((p: { page_id: string }) => p.page_id)).toEqual(['p1']);
  });

  it('includes compile failures that name the session only in their details, and counts past the limit', async () => {
    handle = setupTestDb();
    const db = handle.db;
    db.prepare(`INSERT INTO compile_progress (session_id, status, steps) VALUES ('s2', 'failed', '{}')`).run();
    logActivity('compile_failed', { source_id: null, details: { session_id: 's2', error: '409 already_running' } });
    logActivity('compile_failed', { source_id: null, details: { session_id: 'other', error: 'not this one' } });
    const src = seedSource(db, { title: 'Big import', onboarding_session_id: 's2' });
    for (let i = 0; i < 3; i++) {
      seedPage(db, { page_id: `big-${i}`, title: `Big ${i}` });
      seedProvenance(db, `big-${i}`, src);
    }

    const { body } = await changes('session_id=s2&limit=2');
    expect(body.failures.items.map((f: { detail: string }) => f.detail)).toEqual(['409 already_running']);
    expect(body.pages).toMatchObject({ total: 3 });
    expect(body.pages.items).toHaveLength(2);
  });

  it('lists the retries the user pressed, for that session only', async () => {
    handle = setupTestDb();
    handle.db.prepare(`INSERT INTO compile_progress (session_id, status, steps) VALUES ('s3', 'completed', '{}')`).run();
    logActivity('compile_retried', { source_id: null, session_id: 's3', details: { session_id: 's3', message: 'retry of 2 failed items' } });
    logActivity('compile_retried', { source_id: null, session_id: 'other', details: { session_id: 'other', message: 'not this one' } });

    const { body } = await changes('session_id=s3');
    expect(body.retries).toEqual({
      items: [expect.objectContaining({ kind: 'compile_retried', detail: 'retry of 2 failed items' })],
      total: 1,
    });
  });

  it('answers 404 for an unknown session', async () => {
    handle = setupTestDb();
    expect((await changes('session_id=nope')).status).toBe(404);
  });
});

describe('changes to one page', () => {
  it('lists compiles and events and compares sections with the previous version', async () => {
    handle = setupTestDb();
    const db = handle.db;
    const src = seedSource(db, { title: 'Source A' });
    seedPage(db, { page_id: 'merge', title: 'The Merge', page_type: 'concept' });
    seedProvenance(db, 'merge', src, 'updated');
    const pagesDir = join(DATA_ROOT, 'pages');
    mkdirSync(pagesDir, { recursive: true });
    const previousPath = join(pagesDir, 'merge.20261001-120000.md.gz');
    writeFileSync(
      previousPath,
      gzipSync('Intro.\n\n## History\n\nOld text [^a].\n\n## Removed bit\n\nGone.\n\n## Same\n\nKept [^a].')
    );
    db.prepare('UPDATE pages SET previous_content_path = ?, pending_content = ? WHERE page_id = ?').run(
      previousPath,
      'Intro.\n\n## History\n\nNew text.\n\n## Same\n\nKept [^b].\n\n## Added bit\n\nNew.',
      'merge'
    );
    logActivity('page_dispute_recorded', { source_id: null, details: { page_id: 'merge', topic: 'date' } });

    const { body } = await changes('page_id=merge');
    expect(body.mode).toBe('page');
    expect(body.page).toMatchObject({ page_id: 'merge', title: 'The Merge' });
    expect(body.compiles).toEqual({
      items: [{ source_id: src, source_title: 'Source A', contribution_type: 'updated', at: expect.any(String) }],
      total: 1,
    });
    expect(body.events.items[0]).toMatchObject({ kind: 'page_dispute_recorded', detail: 'date' });
    expect(body.previous_version).toEqual({
      sections_added: ['Added bit'],
      sections_removed: ['Removed bit'],
      sections_changed: ['History'],
    });
  });

  it('answers 404 for an unknown page', async () => {
    handle = setupTestDb();
    expect((await changes('page_id=missing')).status).toBe(404);
  });
});

describe('section comparison', () => {
  it('keeps repeated headings apart and ignores headings inside code', async () => {
    const { sections } = await import('../lib/page-history');
    const map = sections('## Notes\n\nOne.\n\n## Notes\n\nTwo.\n\n~~~\n## not a heading\n~~~');
    expect([...map.keys()]).toEqual(['Notes', 'Notes (2)']);
    expect(map.get('Notes (2)')).toContain('## not a heading');
  });
});
