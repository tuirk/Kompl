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
      return Response.json({
        results: verdicts.map((v) => ({ entity_a: v.a, entity_b: v.b, decision: v.decision, canonical: v.canonical, reason: 'mock' })),
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

it("lets the first 'same' win when an entity gets two", async () => {
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
