/**
 * The resolver reads existing page titles in a fixed order. Without an
 * ORDER BY, SQLite returns them in whatever order the pages table holds,
 * and Layers 1 and 2 break ties by input order: "CI" bound "Confidence
 * Interval" or "Continuous Integration" depending on which row came first
 * (audit 2026-10-23).
 */

import { it, expect, afterEach, vi } from 'vitest';
import { POST as resolvePOST } from '../app/api/compile/resolve/route';
import { getEntityAndConceptPageTitles } from '../lib/db';
import { setupTestDb, seedSource, seedExtraction, seedPage, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

it('returns entity and concept page titles sorted by title, then kind', () => {
  handle = setupTestDb();
  seedPage(handle.db, { title: 'Continuous Integration', page_type: 'concept' });
  seedPage(handle.db, { title: 'Mercury', page_type: 'entity' });
  seedPage(handle.db, { title: 'Confidence Interval', page_type: 'concept' });
  seedPage(handle.db, { title: 'Mercury', page_type: 'concept' });
  seedPage(handle.db, { title: 'Overview', page_type: 'overview' });

  expect(getEntityAndConceptPageTitles()).toEqual([
    { title: 'Confidence Interval', page_type: 'concept' },
    { title: 'Continuous Integration', page_type: 'concept' },
    { title: 'Mercury', page_type: 'concept' },
    { title: 'Mercury', page_type: 'entity' },
  ]);
});

it('sends Layer 1 the page titles in that order', async () => {
  handle = setupTestDb();
  const session_id = 'sess-order';
  const sid = seedSource(handle.db, { onboarding_session_id: session_id, compile_status: 'extracted' });
  seedExtraction(handle.db, { source_id: sid, llm_output: { entities: [], concepts: [{ name: 'CI' }], relationships: [] } });
  seedPage(handle.db, { title: 'Continuous Integration', page_type: 'concept' });
  seedPage(handle.db, { title: 'Confidence Interval', page_type: 'concept' });

  let titles: unknown = null;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.endsWith('/resolve/fuzzy')) {
      titles = body.existing_page_titles;
      return Response.json({ resolved: [], unresolved: body.entities });
    }
    if (url.endsWith('/resolve/embedding')) return Response.json({ resolved: [], ambiguous: [], unresolved: body.entities });
    throw new Error(`unexpected fetch: ${url}`);
  }));

  const res = await resolvePOST(new Request('http://test/api/compile/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id }),
  }));
  expect(res.status).toBe(200);
  expect(titles).toEqual([
    { title: 'Confidence Interval', page_type: 'concept', summary: null },
    { title: 'Continuous Integration', page_type: 'concept', summary: null },
  ]);
});

it('reads extractions finished in the same second in source order', async () => {
  handle = setupTestDb();
  const session_id = 'sess-ties';
  for (const source_id of ['src-b', 'src-a']) {
    seedSource(handle.db, { source_id, onboarding_session_id: session_id, compile_status: 'extracted' });
    seedExtraction(handle.db, { source_id, llm_output: { entities: [], concepts: [{ name: `From ${source_id}` }], relationships: [] } });
  }
  handle.db.prepare("UPDATE extractions SET created_at = '2026-10-23 12:00:00'").run();

  let names: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { entities: Array<{ name: string }> };
    if (url.endsWith('/resolve/fuzzy')) {
      names = body.entities.map((e) => e.name);
      return Response.json({ resolved: [], unresolved: body.entities });
    }
    if (url.endsWith('/resolve/embedding')) return Response.json({ resolved: [], ambiguous: [], unresolved: body.entities });
    throw new Error(`unexpected fetch: ${url}`);
  }));

  const res = await resolvePOST(new Request('http://test/api/compile/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id }),
  }));
  expect(res.status).toBe(200);
  expect(names).toEqual(['From src-a', 'From src-b']);
});
