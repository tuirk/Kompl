/**
 * How the resolve route spends and reads Layer 3 (audit 2026-10-23):
 * - the capped pairs are ranked in tiers, and pairs left over the cap are
 *   reported in stats and in the activity log instead of only console.warn;
 * - verdicts are matched to pairs by pair_id, not by name: two pairs named
 *   "Mercury" / "Mercury" shared one verdict;
 * - a failed LLM batch comes back 'ambiguous' and is reported the same way;
 * - the disambiguate timeout grows with the number of pairs.
 */

import type { ReactElement } from 'react';
import { it, expect, afterEach, vi } from 'vitest';
import { POST as resolvePOST } from '../app/api/compile/resolve/route';
import { getEventDef, type FeedActivityRow } from '../lib/activity-events';
import { computeDisambiguateMs } from '../lib/compile-timeouts';
import { disambiguatePairCap, MIN_DISAMBIGUATE_PAIRS } from '../lib/resolve-ranking';
import { setupTestDb, seedSource, seedExtraction, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Ent { name: string; type: string; source_id: string; context: string }
interface Group { canonical: string; type: string; aliases: string[]; source_ids: string[]; method: string }
interface Pair {
  entity_a: Ent; entity_b: Ent; similarity: number; name_similarity: number;
  same_source: boolean; abbreviation: boolean; pair_id?: string;
}
interface Stats { llm_pairs: number; llm_pairs_over_cap: number; llm_pairs_failed: number; llm_pairs_rerouted: number }

const ent = (name: string, source_id: string, type = 'CONCEPT'): Ent => ({ name, type, source_id, context: '' });
const pair = (a: Ent, b: Ent, sim: number): Pair =>
  ({ entity_a: a, entity_b: b, similarity: sim, name_similarity: sim, same_source: false, abbreviation: false });

/** Runs the route with mocked layers; `decide` answers each pair sent to Layer 3. */
async function resolveWith(args: {
  groups?: Group[];
  ambiguous: Pair[];
  decide?: (p: Pair) => { decision: string; canonical: string | null; pair_id?: string | null };
  failedPairs?: number;
  rerouted?: number;
  /** Sources the session adds, all extracted (default 1). */
  sources?: number;
}) {
  handle = setupTestDb();
  const session_id = 'sess-layer3';
  for (let i = 0; i < (args.sources ?? 1); i++) {
    const sid = seedSource(handle.db, { onboarding_session_id: session_id, compile_status: 'extracted' });
    seedExtraction(handle.db, { source_id: sid, llm_output: { entities: [], concepts: [{ name: 'Seed' }], relationships: [] } });
  }
  const sent: Pair[] = [];

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.endsWith('/resolve/fuzzy')) return Response.json({ resolved: args.groups ?? [], unresolved: body.entities });
    if (url.endsWith('/resolve/embedding')) {
      return Response.json({ resolved: args.groups ?? [], ambiguous: args.ambiguous, unresolved: [], rerouted: args.rerouted ?? 0 });
    }
    if (url.endsWith('/resolve/disambiguate')) {
      const pairs = body.pairs as Pair[];
      sent.push(...pairs);
      return Response.json({
        results: pairs.map((p) => {
          const v = args.decide?.(p) ?? { decision: 'different', canonical: null };
          return { pair_id: p.pair_id ?? null, entity_a: p.entity_a.name, entity_b: p.entity_b.name, reason: 'mock', ...v };
        }),
        failed_pairs: args.failedPairs ?? 0,
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
  const json = (await res.json()) as { canonical_concepts: Group[]; canonical_entities: Group[]; stats: Stats };
  const activity = handle.db
    .prepare("SELECT action_type, details, step_key FROM activity_log WHERE action_type = 'resolution_pairs_unchecked'")
    .all() as Array<{ action_type: string; details: string; step_key: string }>;
  const complete = handle.db
    .prepare("SELECT details FROM activity_log WHERE action_type = 'resolution_complete'")
    .all() as Array<{ details: string }>;
  return { ...json, sent, activity, complete: complete.map((r) => JSON.parse(r.details) as Record<string, unknown>) };
}

it('gives pairs across sources and against pages their slots before a list article\'s pairs', async () => {
  const listPairs = Array.from({ length: 130 }, (_, i) => pair(ent(`Castle ${i}`, 'list'), ent(`Fortress ${i}`, 'list'), 0.88));
  const { sent, stats, activity } = await resolveWith({
    ambiguous: [
      ...listPairs,
      pair(ent('Gas fee', 's1'), ent('Transaction fee', 's2'), 0.72),
      pair(ent('Echo', 's3', 'ORG'), ent('Echo Corp', '__existing_page__', 'OTHER'), 0.71),
      pair(ent('JS', 's4', 'PRODUCT'), ent('JavaScript', 's4', 'PRODUCT'), 0.7),
    ],
  });
  const names = sent.map((p) => p.entity_a.name);
  expect(names).toHaveLength(MIN_DISAMBIGUATE_PAIRS);
  expect(names.slice(0, 3)).toEqual(['Gas fee', 'Echo', 'JS']);
  expect(stats).toMatchObject({ llm_pairs: 120, llm_pairs_over_cap: 13, llm_pairs_failed: 0 });
  expect(activity).toHaveLength(1);
  expect(activity[0].step_key).toBe('resolve');
  expect(JSON.parse(activity[0].details)).toMatchObject({ over_cap: 13, llm_failed: 0, cap: MIN_DISAMBIGUATE_PAIRS });
});

it('gives a session 10 pairs per source it adds, up to the 600 ceiling', async () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => pair(ent(`Castle ${i}`, 'a'), ent(`Fort ${i}`, 'b'), 0.8));
  const film = await resolveWith({ sources: 24, ambiguous: many(250) });
  expect(film.sent).toHaveLength(240);
  expect(JSON.parse(film.activity[0].details)).toMatchObject({ over_cap: 10, cap: 240 });
  handle?.cleanup();
  const big = await resolveWith({ sources: 80, ambiguous: many(700) });
  expect(big.sent).toHaveLength(600);
  expect(disambiguatePairCap(0)).toBe(MIN_DISAMBIGUATE_PAIRS);
});

it('asks a flagged acronym pair first and hands every pair\'s hints on to Layer 3', async () => {
  const { sent } = await resolveWith({
    ambiguous: [
      pair(ent('Gas fee', 's1'), ent('Transaction fee', 's2'), 0.9),
      // "LLMs" reads as no abbreviation; Layer 2 flags the pair through the group's "LLM".
      { ...pair(ent('LLMs', 's3'), ent('Large Language Model', 's4'), 0.2), abbreviation: true },
      { ...pair(ent('Kaunas Castle', 's5'), ent('Kaunas Fortress', 's5'), 0.85), same_source: true },
    ],
  });
  expect(sent.map((p) => [p.entity_a.name, p.same_source, p.abbreviation])).toEqual([
    ['LLMs', false, true],
    ['Gas fee', false, false],
    ['Kaunas Castle', true, false],
  ]);
});

it('counts the pairs Layer 2 sent to Layer 3 instead of merging them', async () => {
  const { stats, complete } = await resolveWith({
    ambiguous: [pair(ent('North Korea', 's1'), ent('South Korea', 's2'), 0.96)],
    rerouted: 1,
  });
  expect(stats.llm_pairs_rerouted).toBe(1);
  expect(complete).toHaveLength(1);
  expect(complete[0]).toMatchObject({ llm_pairs_rerouted: 1 });
});

it('logs nothing extra when every pair was asked', async () => {
  const { stats, activity } = await resolveWith({ ambiguous: [pair(ent('Gas fee', 's1'), ent('Transaction fee', 's2'), 0.72)] });
  expect(stats).toMatchObject({ llm_pairs: 1, llm_pairs_over_cap: 0, llm_pairs_failed: 0 });
  expect(activity).toEqual([]);
});

it('applies each verdict to its own pair when two pairs carry the same names', async () => {
  const groups: Group[] = [
    { canonical: 'Mercury', type: 'PERSON', aliases: [], source_ids: ['s1'], method: 'exact' },
    { canonical: 'Mercury', type: 'LOCATION', aliases: [], source_ids: ['s2'], method: 'exact' },
  ];
  const groupRef = (k: number, type: string): Ent => ({ name: 'Mercury', type, source_id: `__group__:${k}`, context: '' });
  const planet = ent('Mercury', 's3');
  const { canonical_entities, canonical_concepts } = await resolveWith({
    groups,
    ambiguous: [pair(groupRef(0, 'PERSON'), planet, 0.8), pair(groupRef(1, 'LOCATION'), planet, 0.8)],
    // Only the LOCATION pair is the same thing.
    decide: (p) => (p.entity_a.source_id === '__group__:1'
      ? { decision: 'same', canonical: 'Mercury' }
      : { decision: 'different', canonical: null }),
  });
  expect(canonical_entities).toEqual([
    { canonical: 'Mercury', type: 'PERSON', aliases: [], source_ids: ['s1'], method: 'exact' },
    { canonical: 'Mercury', type: 'LOCATION', aliases: [], source_ids: ['s2', 's3'], method: 'exact' },
  ]);
  expect(canonical_concepts).toEqual([]);
});

it('applies a same verdict on a rename asked by meaning, whatever its numbers, and nothing else that clashes', async () => {
  const renamed = { ...pair(ent('2019 novel coronavirus', 's1'), ent('SARS-CoV-2', 's2'), 0.8), by_meaning: true };
  const { canonical_concepts } = await resolveWith({
    ambiguous: [renamed, pair(ent('Python 2', 's3'), ent('Python 3', 's4'), 0.9)],
    decide: (p) => ({ decision: 'same', canonical: p.entity_b.name }),
  });
  expect(canonical_concepts.map((g) => [g.canonical, g.aliases]).sort()).toEqual([
    ['Python 2', []], ['Python 3', []], ['SARS-CoV-2', ['2019 novel coronavirus']],
  ]);
});

it('applies no verdict that comes back without its pair id', async () => {
  const { canonical_concepts } = await resolveWith({
    ambiguous: [pair(ent('Gas fee', 's1'), ent('Transaction fee', 's2'), 0.72)],
    decide: () => ({ decision: 'same', canonical: 'Gas fee', pair_id: null }),
  });
  expect(canonical_concepts.map((g) => g.canonical).sort()).toEqual(['Gas fee', 'Transaction fee']);
});

it('reports pairs whose LLM batch failed', async () => {
  const { stats, activity } = await resolveWith({
    ambiguous: Array.from({ length: 12 }, (_, i) => pair(ent(`A${i}`, 's1'), ent(`B${i}`, 's2'), 0.8)),
    decide: () => ({ decision: 'ambiguous', canonical: null }),
    failedPairs: 10,
  });
  expect(stats).toMatchObject({ llm_pairs: 12, llm_pairs_over_cap: 0, llm_pairs_failed: 10 });
  expect(JSON.parse(activity[0].details)).toMatchObject({ over_cap: 0, llm_failed: 10 });
});

it('sizes the disambiguate timeout from the number of pairs', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  await resolveWith({ ambiguous: Array.from({ length: 45 }, (_, i) => pair(ent(`A${i}`, 's1'), ent(`B${i}`, 's2'), 0.8)) });
  expect(timeout).toHaveBeenCalledWith(computeDisambiguateMs(45));
});

it('renders the unchecked-pairs row for the activity feed', () => {
  const def = getEventDef('resolution_pairs_unchecked');
  expect(def).not.toBeNull();
  const row: FeedActivityRow = {
    id: 1, timestamp: '2026-10-23 10:00:00', action_type: 'resolution_pairs_unchecked', source_id: null,
    source_title: null, details: JSON.stringify({ session_id: 's', over_cap: 13, llm_failed: 10, cap: 120 }),
  };
  const text = (node: unknown): string => {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(text).join('');
    return text((node as ReactElement<{ children?: unknown }>).props.children);
  };
  const content = def!.render(row);
  expect(text(content.primary)).toBe('23 possible duplicate pairs not checked');
  expect(text(content.secondary)).toBe('13 over the 120-pair limit · 10 in AI calls that failed');
});
