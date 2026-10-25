/**
 * Layer 3 reads a pair side bound to a wiki page as that page: its summary
 * as the context and its active stored aliases as known_names. The page
 * side went with an empty context, or one source's sentence calling "Color
 * Vision Deficiency" a broader term, and "colorblindness" was kept apart
 * from it (film run, 2026-10-25).
 */

import { it, expect, afterEach, vi } from 'vitest';
import { POST as resolvePOST } from '../app/api/compile/resolve/route';
import { MAX_KNOWN_NAMES, MAX_PAGE_SUMMARY_CHARS, pageSide } from '../lib/resolve-page-sides';
import { setupTestDb, seedSource, seedExtraction, seedPage, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SUMMARY = 'Color vision deficiency (CVD) is a condition in which a person is insensitive to some colors.';

it('gives a page its summary and its own stored names, not the title or another page\'s', () => {
  const side = pageSide(
    [{ title: 'Color Vision Deficiency', page_type: 'concept', summary: SUMMARY }],
    [
      { alias: 'Colour-blindness', canonical_name: 'Color Vision Deficiency' },
      { alias: 'color vision deficiency', canonical_name: 'Color Vision Deficiency' },
      { alias: 'COLOUR-BLINDNESS', canonical_name: 'color vision deficiency' },
      { alias: 'Deuteranopia', canonical_name: 'Red-green colorblindness' },
    ],
  );
  expect(side('color vision deficiency', 'CONCEPT')).toEqual({ summary: SUMMARY, known_names: ['Colour-blindness'] });
  expect(side('Red-green colorblindness', 'CONCEPT')).toEqual({ summary: '', known_names: ['Deuteranopia'] });
  expect(side('Nothing Stored', 'ORG')).toEqual({ summary: '', known_names: [] });
});

it('picks the page of the side\'s kind when a title names two pages, and caps what it sends', () => {
  const long = 'x'.repeat(MAX_PAGE_SUMMARY_CHARS + 50);
  const aliases = Array.from({ length: MAX_KNOWN_NAMES + 5 }, (_, i) => ({ alias: `Name ${i}`, canonical_name: 'Mercury' }));
  const side = pageSide(
    [
      { title: 'Mercury', page_type: 'concept', summary: 'The element.' },
      { title: 'Mercury', page_type: 'entity', summary: long },
    ],
    aliases,
  );
  expect(side('Mercury', 'CONCEPT').summary).toBe('The element.');
  const entity = side('Mercury', 'LOCATION');
  expect(entity.summary).toHaveLength(MAX_PAGE_SUMMARY_CHARS);
  expect(entity.known_names).toHaveLength(MAX_KNOWN_NAMES);
});

interface Ent { name: string; type: string; source_id: string; context: string; known_names?: string[] }
interface Pair { entity_a: Ent; entity_b: Ent; similarity: number; name_similarity: number; same_source: boolean; abbreviation: boolean }

it('sends a page side and a group bound to a page with the page summary and names; other sides unchanged', async () => {
  handle = setupTestDb();
  const session_id = 'sess-page-sides';
  const sid = seedSource(handle.db, { onboarding_session_id: session_id, compile_status: 'extracted' });
  seedExtraction(handle.db, { source_id: sid, llm_output: { entities: [], concepts: [{ name: 'Seed' }], relationships: [] } });
  seedPage(handle.db, { title: 'Color Vision Deficiency', page_type: 'concept', summary: SUMMARY });
  seedPage(handle.db, { title: 'Contrast ratio', page_type: 'concept', summary: 'The luminance ratio of two colours.' });
  handle.db.prepare('INSERT INTO aliases (alias, canonical_name) VALUES (?, ?)').run('Colour-blindness', 'Color Vision Deficiency');
  handle.db.prepare("INSERT INTO aliases (alias, canonical_name, status) VALUES (?, ?, 'retired')").run('Old name', 'Color Vision Deficiency');

  const groups = [
    { canonical: 'Contrast ratio', type: 'CONCEPT', aliases: ['contrast ratios'], source_ids: ['s2'], method: 'existing_page_title' },
    { canonical: 'Gas fee', type: 'CONCEPT', aliases: ['gas fees'], source_ids: ['s3', 's4'], method: 'plural' },
  ];
  const ambiguous: Pair[] = [
    {
      entity_a: { name: 'colorblindness', type: 'CONCEPT', source_id: 's1', context: 'Reduced ability to tell colours apart.' },
      entity_b: { name: 'Color Vision Deficiency', type: 'CONCEPT', source_id: '__existing_page__', context: '' },
      similarity: 0.8, name_similarity: 0.8, same_source: false, abbreviation: false,
    },
    {
      entity_a: { name: 'Colour contrast ratio', type: 'CONCEPT', source_id: 's5', context: 'WCAG ratio.' },
      entity_b: { name: 'Contrast ratio', type: 'CONCEPT', source_id: '__group__:0', context: 'A broader term.' },
      similarity: 0.8, name_similarity: 0.8, same_source: false, abbreviation: false,
    },
    {
      entity_a: { name: 'Transaction fee', type: 'CONCEPT', source_id: 's6', context: 'Paid to miners.' },
      entity_b: { name: 'Gas fee', type: 'CONCEPT', source_id: '__group__:1', context: 'Paid in gwei.' },
      similarity: 0.8, name_similarity: 0.8, same_source: false, abbreviation: false,
    },
  ];
  const sent: Pair[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.endsWith('/resolve/fuzzy')) return Response.json({ resolved: groups, unresolved: body.entities });
    if (url.endsWith('/resolve/embedding')) return Response.json({ resolved: groups, ambiguous, unresolved: [], rerouted: 0 });
    if (url.endsWith('/resolve/disambiguate')) {
      const pairs = body.pairs as Array<Pair & { pair_id: string }>;
      sent.push(...pairs);
      return Response.json({
        results: pairs.map((p) => ({ pair_id: p.pair_id, entity_a: p.entity_a.name, entity_b: p.entity_b.name,
          decision: 'different', canonical: null, reason: 'mock' })),
        failed_pairs: 0,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));

  const res = await resolvePOST(new Request('http://test/api/compile/resolve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id }),
  }));
  expect(res.status).toBe(200);
  const byName = new Map(sent.map((p) => [p.entity_a.name, p]));
  expect(byName.get('colorblindness')?.entity_b).toEqual({
    name: 'Color Vision Deficiency', type: 'CONCEPT', source_id: '__existing_page__', context: SUMMARY,
    known_names: ['Colour-blindness'],
  });
  expect(byName.get('colorblindness')?.entity_a).toEqual(ambiguous[0].entity_a);
  expect(byName.get('Colour contrast ratio')?.entity_b).toEqual({
    name: 'Contrast ratio', type: 'CONCEPT', source_id: '__group__:0', context: 'The luminance ratio of two colours.',
    known_names: [],
  });
  expect(byName.get('Transaction fee')?.entity_b).toEqual(ambiguous[2].entity_b);
});
