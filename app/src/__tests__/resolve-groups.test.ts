/**
 * Layer 1 groups reach Layers 2 and 3, and Layer 3 'same' verdicts fold
 * into the groups the pairs name (`__group__:<k>` = groups[k] of the
 * /resolve/embedding response).
 *
 * 2026-10-17, sessions e55c740b and 61c8bb37: "APCA", bound to its page in
 * Layer 1, and "Contrast ratio", grouped across two sources, never met
 * "APCA contrast algorithm" and "Colour contrast ratio" — Layer 2 only saw
 * the names Layer 1 left alone.
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
interface Pair { entity_a: Ent; entity_b: Ent; similarity: number; name_similarity: number; pair_id?: string }
interface Verdict { a: string; b: string; decision: string; canonical: string | null }
interface Layers {
  fuzzy: (sid: string) => { resolved: Group[]; unresolved: Ent[] };
  embedding: (sid: string) => { resolved: Group[]; ambiguous: Pair[]; unresolved: Ent[] };
  verdicts?: Verdict[];
}

const concept = (name: string, source_id: string, context = ''): Ent => ({ name, type: 'CONCEPT', source_id, context });
const groupRef = (k: number, name: string): Ent => ({ name, type: 'CONCEPT', source_id: `__group__:${k}`, context: '' });
const existingPage = (name: string): Ent => ({ name, type: 'CONCEPT', source_id: '__existing_page__', context: '' });

/** Runs the resolve route on one source's concepts with mocked layers; returns the concepts and every request body. */
async function resolveWith(concepts: Array<{ name: string; description?: string }>, layers: Layers) {
  handle = setupTestDb();
  const session_id = 'sess-groups';
  const sid = seedSource(handle.db, { onboarding_session_id: session_id, compile_status: 'extracted' });
  seedExtraction(handle.db, { source_id: sid, llm_output: { entities: [], concepts, relationships: [] } });
  const bodies: Record<string, Record<string, unknown>> = {};

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.endsWith('/resolve/fuzzy')) {
      bodies.fuzzy = body;
      return Response.json(layers.fuzzy(sid));
    }
    if (url.endsWith('/resolve/embedding')) {
      bodies.embedding = body;
      return Response.json(layers.embedding(sid));
    }
    if (url.endsWith('/resolve/disambiguate')) {
      bodies.disambiguate = body;
      const pairs = body.pairs as Pair[];
      return Response.json({
        results: pairs.map((p) => {
          const v = layers.verdicts?.find((x) => x.a === p.entity_a.name && x.b === p.entity_b.name);
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
  const json = (await res.json()) as { canonical_concepts: Group[]; canonical_entities: Group[] };
  return { sid, concepts: json.canonical_concepts, bodies };
}

it('sends Layer 1 groups to Layer 2 with a context of their own, beside the names Layer 1 left alone', async () => {
  const { sid, bodies } = await resolveWith(
    [{ name: 'Contrast ratio', description: 'Luminance ratio between text and background.' },
     { name: 'Colour contrast ratio', description: 'The WCAG ratio.' }],
    {
      fuzzy: (s) => ({
        resolved: [{ canonical: 'Contrast ratio', type: 'CONCEPT', aliases: ['contrast ratio'], source_ids: [s], method: 'exact' }],
        unresolved: [concept('Colour contrast ratio', s, 'The WCAG ratio.')],
      }),
      embedding: () => ({ resolved: [], ambiguous: [], unresolved: [] }),
    },
  );
  expect(bodies.embedding).toEqual({
    entities: [concept('Colour contrast ratio', sid, 'The WCAG ratio.')],
    groups: [{
      canonical: 'Contrast ratio', type: 'CONCEPT', aliases: ['contrast ratio'], source_ids: [sid], method: 'exact',
      context: 'Luminance ratio between text and background.',
    }],
    existing_page_titles: [],
  });
});

it("folds a 'same' into the group the pair names, and the anchored canonical wins", async () => {
  const { sid, concepts } = await resolveWith(
    [{ name: 'APCA' }, { name: 'APCA contrast algorithm' }],
    {
      fuzzy: (s) => ({
        resolved: [{ canonical: 'APCA', type: 'CONCEPT', aliases: ['APCA'], source_ids: [s], method: 'existing_page_title' }],
        unresolved: [concept('APCA contrast algorithm', s)],
      }),
      embedding: (s) => ({
        resolved: [{ canonical: 'APCA', type: 'CONCEPT', aliases: ['APCA'], source_ids: [s], method: 'existing_page_title' }],
        ambiguous: [{ entity_a: groupRef(0, 'APCA'), entity_b: concept('APCA contrast algorithm', s), similarity: 0.8, name_similarity: 0.8 }],
        unresolved: [],
      }),
      verdicts: [{ a: 'APCA', b: 'APCA contrast algorithm', decision: 'same', canonical: 'APCA contrast algorithm' }],
    },
  );
  // One group, passed through once: no copy from Layer 1, no singleton, no sentinel source.
  expect(concepts).toEqual([{
    canonical: 'APCA', type: 'CONCEPT', aliases: ['APCA', 'APCA contrast algorithm'], source_ids: [sid],
    method: 'existing_page_title',
  }]);
  expect(getAllAliases().filter((a) => a.alias === 'APCA contrast algorithm').map((a) => a.canonical_name)).toEqual(['APCA']);
});

it('drops the Layer 1 groups Layer 2 passed through', async () => {
  const bitcoin = (s: string): Group => ({ canonical: 'Bitcoin', type: 'CONCEPT', aliases: ['bitcoin'], source_ids: [s], method: 'exact' });
  const { concepts } = await resolveWith(
    [{ name: 'Bitcoin' }, { name: 'bitcoin' }, { name: 'Proof of work' }],
    {
      fuzzy: (s) => ({ resolved: [bitcoin(s)], unresolved: [concept('Proof of work', s)] }),
      embedding: (s) => ({ resolved: [bitcoin(s)], ambiguous: [], unresolved: [concept('Proof of work', s)] }),
    },
  );
  expect(concepts.map((g) => g.canonical)).toEqual(['Bitcoin', 'Proof of work']);
});

it('sends the most similar pairs when there are more than the cap', async () => {
  const { bodies } = await resolveWith(
    [{ name: 'Seed' }],
    {
      fuzzy: (s) => ({ resolved: [], unresolved: [concept('Seed', s)] }),
      embedding: (s) => ({
        resolved: [],
        ambiguous: Array.from({ length: 130 }, (_, i) => ({
          entity_a: concept(`Amb${i}A`, s), entity_b: concept(`Amb${i}B`, s), similarity: 0.7 + i / 1000, name_similarity: 0.7 + i / 1000,
        })),
        unresolved: [],
      }),
    },
  );
  const sent = (bodies.disambiguate.pairs as Pair[]).map((p) => p.entity_a.name);
  expect(sent).toHaveLength(120);
  expect(sent[0]).toBe('Amb129A');
  expect(sent).not.toContain('Amb9A');
});

it('gives a pair alike only in context no slot ahead of pairs whose names are alike', async () => {
  const { bodies } = await resolveWith(
    [{ name: 'Seed' }],
    {
      fuzzy: (s) => ({ resolved: [], unresolved: [concept('Seed', s)] }),
      embedding: (s) => ({
        resolved: [],
        ambiguous: [
          // One source names both; alike by context (0.98), not by name (0.10).
          { entity_a: concept('Set collection', s), entity_b: concept('Route planning', s), similarity: 0.98, name_similarity: 0.1 },
          ...Array.from({ length: 120 }, (_, i) => ({
            entity_a: concept(`Name${i}A`, `a${i}`), entity_b: concept(`Name${i}B`, `b${i}`),
            similarity: 0.75, name_similarity: 0.75,
          })),
        ],
        unresolved: [],
      }),
    },
  );
  const sent = (bodies.disambiguate.pairs as Pair[]).map((p) => p.entity_a.name);
  expect(sent).toHaveLength(120);
  expect(sent).not.toContain('Set collection');
});

it('on equal name similarity asks about two sources before one source naming both', async () => {
  const dutch = (s: string): Group => ({ canonical: 'Dutch auction', type: 'CONCEPT', aliases: [], source_ids: [s], method: 'exact' });
  const { bodies } = await resolveWith(
    [{ name: 'Dutch auction' }, { name: 'Reverse auction' }],
    {
      fuzzy: (s) => ({ resolved: [dutch(s)], unresolved: [concept('Reverse auction', s)] }),
      embedding: (s) => ({
        resolved: [dutch(s)],
        ambiguous: [
          // The group's own source names the other side too.
          { entity_a: groupRef(0, 'Dutch auction'), entity_b: concept('Reverse auction', s), similarity: 0.95, name_similarity: 0.8 },
          ...Array.from({ length: 119 }, (_, i) => ({
            entity_a: concept(`Name${i}A`, `a${i}`), entity_b: concept(`Name${i}B`, `b${i}`),
            similarity: 0.9, name_similarity: 0.9,
          })),
          { entity_a: concept('Colour analyser', 'x1'), entity_b: concept('Color analyzer', 'x2'), similarity: 0.81, name_similarity: 0.8 },
        ],
        unresolved: [],
      }),
    },
  );
  const sent = (bodies.disambiguate.pairs as Pair[]).map((p) => p.entity_a.name);
  expect(sent).toHaveLength(120);
  expect(sent).toContain('Colour analyser');
  expect(sent).not.toContain('Dutch auction');
});

it("joins two groups Layer 3 calls the same: the name more sources back stays", async () => {
  const llmGroups = (): Group[] => [
    { canonical: 'Large language model', type: 'CONCEPT', aliases: [], source_ids: ['s1', 's2'], method: 'exact' },
    { canonical: 'LLM', type: 'CONCEPT', aliases: ['LLMs'], source_ids: ['s3', 's4', 's5'], method: 'plural' },
  ];
  const { concepts } = await resolveWith(
    [{ name: 'Large language model' }, { name: 'LLM' }],
    {
      fuzzy: () => ({ resolved: llmGroups(), unresolved: [] }),
      embedding: () => ({
        resolved: llmGroups(),
        ambiguous: [{ entity_a: groupRef(0, 'Large language model'), entity_b: groupRef(1, 'LLM'), similarity: 0.78, name_similarity: 0.78 }],
        unresolved: [],
      }),
      verdicts: [{ a: 'Large language model', b: 'LLM', decision: 'same', canonical: 'Large language model' }],
    },
  );
  expect(concepts).toEqual([{
    canonical: 'LLM', type: 'CONCEPT', aliases: ['LLMs', 'Large language model'],
    source_ids: ['s3', 's4', 's5', 's1', 's2'], method: 'llm',
  }]);
});

it('binds a group to the existing page Layer 3 matched it with', async () => {
  const gptFour = (): Group => ({ canonical: 'GPT four', type: 'CONCEPT', aliases: ['gpt four'], source_ids: ['s1', 's2'], method: 'exact' });
  const { concepts } = await resolveWith(
    [{ name: 'GPT four' }],
    {
      fuzzy: () => ({ resolved: [gptFour()], unresolved: [] }),
      embedding: () => ({
        resolved: [gptFour()],
        ambiguous: [{ entity_a: groupRef(0, 'GPT four'), entity_b: existingPage('GPT-4'), similarity: 0.86, name_similarity: 0.86 }],
        unresolved: [],
      }),
      verdicts: [{ a: 'GPT four', b: 'GPT-4', decision: 'same', canonical: 'GPT four' }],
    },
  );
  expect(concepts).toEqual([{
    canonical: 'GPT-4', type: 'CONCEPT', aliases: ['gpt four', 'GPT four'], source_ids: ['s1', 's2'],
    method: 'existing_page_title',
  }]);
});

it('never joins two groups bound to different pages', async () => {
  const groups: Group[] = [
    { canonical: 'Ethereum', type: 'CONCEPT', aliases: ['Ethereum'], source_ids: ['s1'], method: 'existing_page_title' },
    { canonical: 'Ethereum Foundation', type: 'CONCEPT', aliases: ['EF'], source_ids: ['s2'], method: 'existing_alias' },
  ];
  const { sid, concepts } = await resolveWith(
    [{ name: 'Ethereum' }, { name: 'Gas fee' }],
    {
      fuzzy: (s) => ({ resolved: groups.map((g) => ({ ...g })), unresolved: [concept('Gas fee', s)] }),
      embedding: (s) => ({
        resolved: groups.map((g) => ({ ...g })),
        ambiguous: [{ entity_a: groupRef(0, 'Ethereum'), entity_b: groupRef(1, 'Ethereum Foundation'), similarity: 0.91, name_similarity: 0.91 }],
        unresolved: [concept('Gas fee', s)],
      }),
      verdicts: [{ a: 'Ethereum', b: 'Ethereum Foundation', decision: 'same', canonical: 'Ethereum' }],
    },
  );
  expect(concepts).toEqual([
    ...groups,
    { canonical: 'Gas fee', type: 'CONCEPT', aliases: [], source_ids: [sid], method: 'none' },
  ]);
});

it('keeps a name of another kind that shares a group\'s name and source', async () => {
  const chrome = (s: string): Group => ({ canonical: 'Chrome', type: 'ORG', aliases: [], source_ids: [s, 's2'], method: 'exact' });
  const { sid, concepts } = await resolveWith(
    [{ name: 'Chrome' }],
    {
      fuzzy: (s) => ({ resolved: [chrome(s)], unresolved: [concept('Chrome', s)] }),
      embedding: (s) => ({
        resolved: [chrome(s)],
        ambiguous: [{ entity_a: groupRef(0, 'Chrome'), entity_b: concept('Chrome', s), similarity: 1, name_similarity: 1 }],
        unresolved: [],
      }),
      verdicts: [{ a: 'Chrome', b: 'Chrome', decision: 'different', canonical: null }],
    },
  );
  expect(concepts).toEqual([{ canonical: 'Chrome', type: 'CONCEPT', aliases: [], source_ids: [sid], method: 'none' }]);
});

it('never folds names whose numbers differ into one group, even through a third name', async () => {
  const python = (s: string): Group => ({ canonical: 'Python', type: 'CONCEPT', aliases: [], source_ids: [s], method: 'exact' });
  const { sid, concepts } = await resolveWith(
    [{ name: 'Python' }],
    {
      fuzzy: (s) => ({ resolved: [python(s)], unresolved: [concept('Python 2', 's2'), concept('Python 3', 's3')] }),
      embedding: (s) => ({
        resolved: [python(s)],
        ambiguous: [
          { entity_a: groupRef(0, 'Python'), entity_b: concept('Python 2', 's2'), similarity: 0.85, name_similarity: 0.85 },
          { entity_a: groupRef(0, 'Python'), entity_b: concept('Python 3', 's3'), similarity: 0.84, name_similarity: 0.84 },
        ],
        unresolved: [],
      }),
      verdicts: [
        { a: 'Python', b: 'Python 2', decision: 'same', canonical: 'Python' },
        { a: 'Python', b: 'Python 3', decision: 'same', canonical: 'Python' },
      ],
    },
  );
  expect(concepts).toEqual([
    { canonical: 'Python', type: 'CONCEPT', aliases: ['Python 2'], source_ids: [sid, 's2'], method: 'exact' },
    { canonical: 'Python 3', type: 'CONCEPT', aliases: [], source_ids: ['s3'], method: 'none' },
  ]);
});
