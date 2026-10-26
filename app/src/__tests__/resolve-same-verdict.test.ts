/**
 * A session entity joins one merged group only, and a merged entity never
 * also comes out as a singleton when a 'different' verdict on another pair
 * returns it.
 *
 * 2026-10-17, session e55c740b: "APCA" merged into "APCA contrast algorithm"
 * and was also emitted on its own; plan then wrote the name to two pages.
 */

import { it, expect, afterEach, vi } from 'vitest';
import { POST as resolvePOST } from '../app/api/compile/resolve/route';
import { getAllAliases } from '../lib/db';
import { setupTestDb, seedSource, seedExtraction, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

interface Ent { name: string; type: string; source_id: string; context: string }
interface Group { canonical: string; type: string; aliases: string[]; source_ids: string[]; method: string }
interface Verdict { a: string; b: string; decision: string; canonical: string | null }

/** Runs the resolve route on one source's concepts with mocked Layer 2 / 3 output. */
async function resolveWith(
  names: string[],
  layer2: (sid: string) => { resolved: Group[]; ambiguous: Array<{ entity_a: Ent; entity_b: Ent; similarity: number; name_similarity: number }> },
  verdicts: Verdict[],
): Promise<Array<{ canonical: string; aliases: string[] }>> {
  handle = setupTestDb();
  const session_id = 'sess-same';
  const source_id = seedSource(handle.db, { onboarding_session_id: session_id, compile_status: 'extracted' });
  seedExtraction(handle.db, {
    source_id,
    llm_output: { entities: [], concepts: names.map((name) => ({ name, description: '' })), relationships: [] },
  });
  const l2 = layer2(source_id);

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.endsWith('/resolve/fuzzy')) return Response.json({ resolved: [], unresolved: body.entities });
    if (url.endsWith('/resolve/embedding')) return Response.json({ ...l2, unresolved: [] });
    if (url.endsWith('/resolve/disambiguate')) {
      // One verdict per pair sent, matched back by its pair_id.
      const pairs = body.pairs as Array<{ entity_a: Ent; entity_b: Ent; pair_id: string }>;
      return Response.json({
        results: pairs.map((p) => {
          const v = verdicts.find((x) => x.a === p.entity_a.name && x.b === p.entity_b.name);
          return { pair_id: p.pair_id, entity_a: p.entity_a.name, entity_b: p.entity_b.name,
                   decision: v?.decision ?? 'different', canonical: v?.canonical ?? null, reason: 'mock' };
        }),
        failed_pairs: 0,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));

  const res = await resolvePOST(new Request('http://test/api/compile/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id }),
  }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { canonical_concepts: Array<{ canonical: string; aliases: string[] }> }).canonical_concepts;
}

const concept = (name: string, source_id: string): Ent => ({ name, type: 'CONCEPT', source_id, context: '' });
const existingPage = (name: string): Ent => ({ name, type: 'CONCEPT', source_id: '__existing_page__', context: '' });
const groupRef = (k: number, name: string): Ent => ({ name, type: 'CONCEPT', source_id: `__group__:${k}`, context: '' });
const group = (canonical: string, source_ids: string[]): Group =>
  ({ canonical, type: 'CONCEPT', aliases: [], source_ids, method: 'exact' });

it("keeps a 'same'-merged entity out of the singletons", async () => {
  const out = await resolveWith(
    ['APCA', 'APCA contrast algorithm'],
    (sid) => ({
      resolved: [],
      ambiguous: [
        { entity_a: concept('APCA', sid), entity_b: existingPage('WCAG contrast algorithm'), similarity: 0.76, name_similarity: 0.76 },
        { entity_a: concept('APCA', sid), entity_b: concept('APCA contrast algorithm', sid), similarity: 0.88, name_similarity: 0.88 },
      ],
    }),
    [
      { a: 'APCA', b: 'WCAG contrast algorithm', decision: 'different', canonical: null },
      { a: 'APCA', b: 'APCA contrast algorithm', decision: 'same', canonical: 'APCA contrast algorithm' },
    ],
  );
  expect(out).toEqual([expect.objectContaining({ canonical: 'APCA contrast algorithm', aliases: ['APCA'] })]);
});

it('keeps an entity Layer 2 already merged out of the singletons', async () => {
  const out = await resolveWith(
    ['Contrast ratio', 'Colour contrast ratio', 'Luminance'],
    (sid) => ({
      resolved: [{ canonical: 'Contrast ratio', type: 'CONCEPT', aliases: ['Colour contrast ratio'], source_ids: [sid], method: 'embedding' }],
      ambiguous: [{ entity_a: concept('Contrast ratio', sid), entity_b: concept('Luminance', sid), similarity: 0.72, name_similarity: 0.72 }],
    }),
    [{ a: 'Contrast ratio', b: 'Luminance', decision: 'different', canonical: null }],
  );
  expect(out.map((g) => g.canonical).sort()).toEqual(['Contrast ratio', 'Luminance']);
});

it("does not chain through an abbreviation: a name called the same as two longer names joins the first only", async () => {
  const out = await resolveWith(
    ['APCA', 'APCA contrast algorithm'],
    (sid) => ({
      resolved: [],
      ambiguous: [
        { entity_a: concept('APCA', sid), entity_b: existingPage('Perceptual contrast'), similarity: 0.8, name_similarity: 0.8 },
        { entity_a: concept('APCA', sid), entity_b: concept('APCA contrast algorithm', sid), similarity: 0.88, name_similarity: 0.88 },
      ],
    }),
    [
      { a: 'APCA', b: 'Perceptual contrast', decision: 'same', canonical: 'Perceptual contrast' },
      { a: 'APCA', b: 'APCA contrast algorithm', decision: 'same', canonical: 'APCA contrast algorithm' },
    ],
  );
  // APCA lands on the existing page once; its partner stays its own singleton.
  expect(out).toEqual([
    expect.objectContaining({ canonical: 'Perceptual contrast', aliases: ['APCA'] }),
    expect.objectContaining({ canonical: 'APCA contrast algorithm', aliases: [] }),
  ]);
});

it("follows a chain of renames into one group (owner, 2026-10-25)", async () => {
  const out = await resolveWith(
    ['2019-nCoV', '2019 novel coronavirus', 'SARS-CoV-2'],
    (sid) => ({
      resolved: [],
      ambiguous: [
        { entity_a: concept('2019 novel coronavirus', sid), entity_b: concept('2019-nCoV', sid), similarity: 0.86, name_similarity: 0.33 },
        { entity_a: concept('2019 novel coronavirus', sid), entity_b: concept('SARS-CoV-2', sid), similarity: 0.84, name_similarity: 0.41, by_meaning: true },
        { entity_a: concept('2019-nCoV', sid), entity_b: concept('SARS-CoV-2', sid), similarity: 0.81, name_similarity: 0.41, by_meaning: true },
      ],
    }),
    [
      { a: '2019 novel coronavirus', b: '2019-nCoV', decision: 'same', canonical: '2019 novel coronavirus' },
      { a: '2019 novel coronavirus', b: 'SARS-CoV-2', decision: 'same', canonical: 'SARS-CoV-2' },
      { a: '2019-nCoV', b: 'SARS-CoV-2', decision: 'same', canonical: 'SARS-CoV-2' },
    ],
  );
  // Each rename's own same verdict lifts the number rule for its two names
  // only; together they make one group.
  expect(out).toHaveLength(1);
  expect([out[0].canonical, ...out[0].aliases].sort()).toEqual(['2019 novel coronavirus', '2019-nCoV', 'SARS-CoV-2']);
});

it("never chains across a pair called different", async () => {
  const out = await resolveWith(
    ['Search engine', 'Web search engine', 'Search engine optimization'],
    (sid) => ({
      resolved: [],
      ambiguous: [
        { entity_a: concept('Search engine', sid), entity_b: concept('Web search engine', sid), similarity: 0.9, name_similarity: 0.9 },
        { entity_a: concept('Web search engine', sid), entity_b: concept('Search engine optimization', sid), similarity: 0.7, name_similarity: 0.7 },
        { entity_a: concept('Search engine', sid), entity_b: concept('Search engine optimization', sid), similarity: 0.8, name_similarity: 0.8 },
      ],
    }),
    [
      { a: 'Search engine', b: 'Web search engine', decision: 'same', canonical: 'Search engine' },
      { a: 'Web search engine', b: 'Search engine optimization', decision: 'same', canonical: 'Search engine' },
      { a: 'Search engine', b: 'Search engine optimization', decision: 'different', canonical: null },
    ],
  );
  expect(out.map((g) => g.canonical).sort()).toEqual(['Search engine', 'Search engine optimization']);
});

it("does not chain through an abbreviation that is a group: CI in two sources (audit 2026-10-26)", async () => {
  const out = await resolveWith(
    ['CI', 'Continuous Integration', 'Confidence Interval'],
    (sid) => ({
      resolved: [group('CI', [sid, 's2'])],
      ambiguous: [
        { entity_a: groupRef(0, 'CI'), entity_b: concept('Continuous Integration', 's3'), similarity: 0.6, name_similarity: 0.5 },
        { entity_a: groupRef(0, 'CI'), entity_b: concept('Confidence Interval', 's4'), similarity: 0.6, name_similarity: 0.4 },
      ],
    }),
    [
      { a: 'CI', b: 'Continuous Integration', decision: 'same', canonical: 'CI' },
      { a: 'CI', b: 'Confidence Interval', decision: 'same', canonical: 'CI' },
    ],
  );
  // The group takes the first expansion; the second stays its own.
  expect(out).toEqual([
    expect.objectContaining({ canonical: 'CI', aliases: ['Continuous Integration'] }),
    expect.objectContaining({ canonical: 'Confidence Interval', aliases: [] }),
  ]);
});

it("never chains through a group across a pair called different", async () => {
  const out = await resolveWith(
    ['Search engine', 'Web search engine', 'Search engine optimization'],
    (sid) => ({
      resolved: [group('Search engine', [sid, 's2'])],
      ambiguous: [
        { entity_a: groupRef(0, 'Search engine'), entity_b: concept('Web search engine', 's3'), similarity: 0.9, name_similarity: 0.9 },
        { entity_a: groupRef(0, 'Search engine'), entity_b: concept('Search engine optimization', 's4'), similarity: 0.8, name_similarity: 0.8 },
        { entity_a: concept('Web search engine', 's3'), entity_b: concept('Search engine optimization', 's4'), similarity: 0.7, name_similarity: 0.7 },
      ],
    }),
    [
      { a: 'Search engine', b: 'Web search engine', decision: 'same', canonical: 'Search engine' },
      { a: 'Search engine', b: 'Search engine optimization', decision: 'same', canonical: 'Search engine' },
      { a: 'Web search engine', b: 'Search engine optimization', decision: 'different', canonical: null },
    ],
  );
  expect(out.map((g) => [g.canonical, ...g.aliases])).toEqual([
    ['Search engine', 'Web search engine'],
    ['Search engine optimization'],
  ]);
});

it("never joins two groups across a pair called different", async () => {
  const out = await resolveWith(
    ['Search engine', 'Web search engine', 'Search engine optimization'],
    (sid) => ({
      resolved: [group('Search engine', [sid, 's2']), group('Search engine optimization', ['s4', 's5'])],
      ambiguous: [
        { entity_a: groupRef(0, 'Search engine'), entity_b: concept('Web search engine', 's3'), similarity: 0.9, name_similarity: 0.9 },
        { entity_a: groupRef(0, 'Search engine'), entity_b: groupRef(1, 'Search engine optimization'), similarity: 0.8, name_similarity: 0.8 },
        { entity_a: concept('Web search engine', 's3'), entity_b: groupRef(1, 'Search engine optimization'), similarity: 0.7, name_similarity: 0.7 },
      ],
    }),
    [
      { a: 'Search engine', b: 'Web search engine', decision: 'same', canonical: 'Search engine' },
      { a: 'Search engine', b: 'Search engine optimization', decision: 'same', canonical: 'Search engine' },
      { a: 'Web search engine', b: 'Search engine optimization', decision: 'different', canonical: null },
    ],
  );
  expect(out.map((g) => [g.canonical, ...g.aliases])).toEqual([
    ['Search engine', 'Web search engine'],
    ['Search engine optimization'],
  ]);
});

it("stores a name a 'same' verdict added to a group as the AI's match, not the group's spelling rule", async () => {
  await resolveWith(
    ['CI', 'Continuous Integration'],
    (sid) => ({
      resolved: [{ ...group('CI', [sid, 's2']), aliases: ['C.I.'] }],
      ambiguous: [
        { entity_a: groupRef(0, 'CI'), entity_b: concept('Continuous Integration', 's3'), similarity: 0.6, name_similarity: 0.5 },
      ],
    }),
    [{ a: 'CI', b: 'Continuous Integration', decision: 'same', canonical: 'CI' }],
  );
  expect(getAllAliases().map((a) => [a.alias, a.canonical_name, a.method])).toEqual([
    ['C.I.', 'CI', 'exact'],
    ['Continuous Integration', 'CI', 'llm'],
  ]);
});

it.each([
  [['CI']],
  [['CI', 'Continuous Integration']],
])("does not chain through a group Layer 1 built from an abbreviation and its expansion (%j)", async (aliases) => {
  const out = await resolveWith(
    ['Continuous Integration (CI)', ...aliases, 'Confidence Interval'],
    (sid) => ({
      resolved: [{ ...group('Continuous Integration (CI)', [sid, 's2']), aliases, method: 'parenthetical' }],
      ambiguous: [
        { entity_a: groupRef(0, 'Continuous Integration (CI)'), entity_b: concept('Confidence Interval', 's3'), similarity: 0.6, name_similarity: 0.4 },
      ],
    }),
    [{ a: 'Continuous Integration (CI)', b: 'Confidence Interval', decision: 'same', canonical: 'Continuous Integration (CI)' }],
  );
  // The group already says what CI stands for; the other expansion stays its own.
  expect(out.map((g) => [g.canonical, ...g.aliases])).toEqual([
    ['Continuous Integration (CI)', ...aliases],
    ['Confidence Interval'],
  ]);
});

it("lets a group of one abbreviation's spellings take its first expansion", async () => {
  const out = await resolveWith(
    ['LLM', 'LLMs', 'Large language models'],
    (sid) => ({
      resolved: [{ ...group('LLM', [sid, 's2']), aliases: ['LLMs'], method: 'plural' }],
      ambiguous: [
        { entity_a: groupRef(0, 'LLM'), entity_b: concept('Large language models', 's3'), similarity: 0.6, name_similarity: 0.5 },
      ],
    }),
    [{ a: 'LLM', b: 'Large language models', decision: 'same', canonical: 'LLM' }],
  );
  expect(out.map((g) => [g.canonical, ...g.aliases])).toEqual([['LLM', 'LLMs', 'Large language models']]);
});
