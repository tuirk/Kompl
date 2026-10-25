/**
 * Each draft prompt lists its sources' dates (plan 3.1, D5): the publication
 * date stored on the source (sources.published_at, plan 3.2) when Kompl
 * knows it, else the day the source was saved. The draft step, the
 * recompile after a source delete and the page update all send them, read
 * through the one sourceDateOf (lib/source-dates.ts).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as draftPOST } from '../app/api/compile/draft/route';
import { sourceDates, withSourceDate } from '../lib/source-dates';
import { seedCompileProgress, seedPage, seedPagePlan, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

describe('sourceDates', () => {
  it('falls back to the saved date, marked saved', () => {
    handle = setupTestDb();
    seedSource(handle.db, { source_id: 'a' });
    handle.db.prepare("UPDATE sources SET date_ingested = '2025-03-04 10:00:00' WHERE source_id = 'a'").run();
    expect(sourceDates(handle.db, ['a', 'missing']).get('a')).toEqual({ date: '2025-03-04', date_kind: 'saved' });
    expect(sourceDates(handle.db, ['missing']).size).toBe(0);
  });

  it("reads the source's stored publication date, whatever found it", () => {
    handle = setupTestDb();
    for (const id of ['a', 'b', 'c', 'd']) seedSource(handle.db, { source_id: id });
    const set = handle.db.prepare('UPDATE sources SET published_at = ?, published_at_source = ? WHERE source_id = ?');
    set.run('2018-02-03', 'page_published', 'a');
    set.run('2019-07-01', 'source_text', 'b');
    set.run('sometime last year', 'source_text', 'c');
    set.run('2026-10-24', 'ingested', 'd');
    const dates = sourceDates(handle.db, ['a', 'b', 'c', 'd']);
    expect(dates.get('a')).toEqual({ date: '2018-02-03', date_kind: 'published' });
    expect(dates.get('b')).toEqual({ date: '2019-07-01', date_kind: 'published' });
    // Not a date: the saved date stands in.
    expect(dates.get('c')?.date_kind).toBe('saved');
    // Picked at ingest with nothing better to go on: the day it was added.
    expect(dates.get('d')).toEqual({ date: '2026-10-24', date_kind: 'saved' });
  });

  it('withSourceDate adds the date only when there is one', () => {
    const dates = new Map([['a', { date: '2020-01-01', date_kind: 'published' as const }]]);
    expect(withSourceDate({ source_id: 'a', title: 'A' }, dates)).toEqual({
      source_id: 'a',
      title: 'A',
      date: '2020-01-01',
      date_kind: 'published',
    });
    expect(withSourceDate({ source_id: 'b' }, dates)).toEqual({ source_id: 'b' });
  });
});

describe('compile/draft sends each source with its date', () => {
  it('labels, dates and date kinds reach the nlp-service', async () => {
    handle = setupTestDb();
    const db = handle.db;
    seedCompileProgress(db, 'sess-dates');
    seedSource(db, { source_id: 'old', title: 'Old', raw_markdown: 'The limit was 10.' });
    db.prepare("UPDATE sources SET date_ingested = '2020-05-01 00:00:00' WHERE source_id = 'old'").run();
    seedSource(db, { source_id: 'new', title: 'New', onboarding_session_id: 'sess-dates', raw_markdown: 'It is 20.' });
    db.prepare('UPDATE sources SET published_at = ?, published_at_source = ? WHERE source_id = ?').run(
      '2024-11-30',
      'page_published',
      'new',
    );
    const page_id = seedPage(db, { page_id: 'limit', title: 'Limit', page_type: 'entity' });
    db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run('---\ntitle: "Limit"\n---\n\nLimit.', page_id);
    seedPagePlan(db, {
      session_id: 'sess-dates',
      title: 'Limit',
      page_type: 'entity',
      action: 'update',
      source_ids: ['old', 'new'],
      existing_page_id: page_id,
      draft_status: 'planned',
    });

    const bodies: Array<{ source_contents: Array<Record<string, unknown>> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).endsWith('/pipeline/draft-page')) {
          bodies.push(JSON.parse(init?.body as string));
          return Response.json({ markdown: '---\ntitle: "Limit"\n---\n\nbody', used_source_ids: ['new', 'old'], cut_sources: [] });
        }
        return new Response('not found', { status: 404 });
      }),
    );

    const res = await draftPOST(
      new Request('http://test/api/compile/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'sess-dates' }),
      }),
    );
    expect(res.status).toBe(200);
    const sent = Object.fromEntries(bodies[0].source_contents.map((s) => [s.source_id as string, s]));
    expect(sent.new).toMatchObject({ date: '2024-11-30', date_kind: 'published' });
    expect(sent.old).toMatchObject({ date: '2020-05-01', date_kind: 'saved' });
    // The route's own field never reaches the nlp-service's strict request.
    expect(sent.old).not.toHaveProperty('date_ingested');
  });
});
