/**
 * The alias screen (lib/alias-screen.ts, lib/alias-shapes.ts) sets aside
 * stored aliases made before schema v29 whose shape is clearly wrong:
 *   - a token extension that is not one person's shorter / fuller name
 *   - "Full Name (ABBR)" against a different expansion of ABBR
 *   - content words that differ, with name-only similarity below 0.9
 * No LLM; one transaction and one activity event per run; never deletes;
 * idempotent; records that it ran; writes nothing when the similarity it
 * needs can't be had (and is retried later).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { ReactElement } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { acronymPair, aliasShape } from '../lib/alias-shapes';
import {
  ALIAS_SCREEN_THROUGH_KEY,
  ALIAS_SCREEN_VERSION,
  ALIAS_SCREEN_VERSION_KEY,
  aliasScreenIdle,
  scheduleAliasScreen,
  screenAliases,
  type NameSimilarity,
} from '../lib/alias-screen';
import { getEventDef, type FeedActivityRow } from '../lib/activity-events';
import { register } from '../instrumentation';
import { getAliases, getSetting } from '../lib/db';
import { seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  handle?.cleanup();
  handle = null;
});

describe('aliasShape', () => {
  it.each([
    ['GPT 4', 'GPT-4', false],
    ['LLMs', 'LLM', false],
    ['Zürich', 'Zurich', false],
    ['The Beatles', 'Beatles', false],
    ['APCA', 'APCA', false],
    ['Karpathy', 'Andrej Karpathy', true],
    ['A. Karpathy', 'Andrej Karpathy', true],
    ['WCAG', 'Web Content Accessibility Guidelines (WCAG)', false],
    ['Web Content Accessibility Guidelines', 'Web Content Accessibility Guidelines (WCAG)', false],
    ['Python', 'Python 2', false], // numbers: getAliases() already leaves it out
  ])('keeps %s -> %s', (alias, canonical, person) => {
    expect(aliasShape(alias, canonical, person)).toBe('keep');
  });

  // Acronym and ticker pairs are for the Layer 3 AI check to judge, never set
  // aside by shape: an all-capitals name of 2-6 letters that gives the other
  // name's content-word initials, or starts its first word.
  it.each([
    ['ETH', 'Ethereum'],
    ['LLM', 'Large language model'],
    ['LLM', 'Large Language Models'],
    ['ML', 'Machine Learning'],
    ['CI', 'Confidence Interval'], // wrong or not, Layer 3 decides
    ['GPT', 'Generative Pre-trained Transformer'],
    ['UNESCO', 'United Nations Educational, Scientific and Cultural Organization'],
    ['Machine Learning', 'ML'],
  ])('keeps the acronym pair %s -> %s', (alias, canonical) => {
    expect(aliasShape(alias, canonical, false)).toBe('keep');
  });

  it.each([
    ['art', 'Adaptive Resonance Theory'], // not in capitals
    ['ML', 'Deep learning'], // letters are not the initials
    ['ETHEREUMX', 'Ethereum'], // longer than six letters
  ])('still asks for name similarity on %s -> %s', (alias, canonical) => {
    expect(aliasShape(alias, canonical, false)).toBe('needs_similarity');
  });

  it('still sets aside an acronym that only adds words to its expansion', () => {
    expect(aliasShape('AI', 'AI Act', false)).toBe('token_extension');
  });

  // The resolver asks Layer 3 about exactly these pairs whatever their
  // similarity (nlp-service routers/resolution.py _is_acronym_pair), so the
  // screen leaves them to it, either way round: also an initialism with a
  // stopword's letter, which the old Layer 1 acronym rule merged.
  it.each([
    ['LOTR', 'Lord of the Rings'],
    ['BOE', 'Bank of England'],
    ['Ethereum', 'ETH'],
  ])('keeps the acronym pair %s -> %s either way round', (alias, canonical) => {
    expect(aliasShape(alias, canonical, false)).toBe('keep');
    expect(aliasShape(canonical, alias, false)).toBe('keep');
  });

  it.each([
    ['Ethereum', 'Ethereum Foundation', false],
    ['Kaunas City', 'Kaunas City Hall', false],
    ['APCA contrast algorithm', 'APCA', false],
    ['Paul', 'Paul Graham', false], // not known to be a person
    ['J. Edwards', 'J. Edwards Deming', true], // an initial is not a fuller name
  ])('sets aside the token extension %s -> %s', (alias, canonical, person) => {
    expect(aliasShape(alias, canonical, person)).toBe('token_extension');
  });

  it.each([
    ['Confidence Interval', 'Continuous Integration (CI)'],
    ['Project Manager', 'Product Manager (PM)'],
    ['Maximum Likelihood', 'Machine Learning (ML)'],
    ['Continuous Integration (CI)', 'Confidence Interval (CI)'],
  ])('sets aside the other expansion %s -> %s', (alias, canonical) => {
    expect(aliasShape(alias, canonical, false)).toBe('parenthetical_expansion');
  });

  it.each([
    ['English', 'programming language', false],
    ['Kaunas City Hall', 'Kaunas City Museum', false],
    ['Paul Allen', 'Paul Graham', true],
    ['John Edward', 'John Edwards', true], // no plural rule for people
  ])('asks for name similarity on %s -> %s', (alias, canonical, person) => {
    expect(aliasShape(alias, canonical, person)).toBe('needs_similarity');
  });
});

interface AcronymCase {
  a: string;
  b: string;
  acronym: boolean;
}

const ACRONYM_CASES = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../nlp-service/tests/fixtures/acronym_pair_cases.json'), 'utf-8'),
) as AcronymCase[];

describe('acronymPair parity with the resolver (nlp-service tests/fixtures/acronym_pair_cases.json)', () => {
  it.each(ACRONYM_CASES.map((c) => [`${c.a} | ${c.b}`, c] as const))('%s', (_label, c) => {
    expect(acronymPair(c.a, c.b)).toBe(c.acronym);
    expect(acronymPair(c.b, c.a)).toBe(c.acronym);
  });
});

function seed(alias: string, canonical: string, extra: { status?: string; method?: string } = {}): number {
  return Number(
    handle!.db
      .prepare('INSERT INTO aliases (alias, canonical_name, status, method) VALUES (?, ?, ?, ?)')
      .run(alias, canonical, extra.status ?? 'active', extra.method ?? null).lastInsertRowid
  );
}

function statuses(): Array<[string, string | null, string | null]> {
  return (
    handle!.db.prepare('SELECT alias, status, status_reason FROM aliases ORDER BY id').all() as Array<{
      alias: string;
      status: string | null;
      status_reason: string | null;
    }>
  ).map((r) => [r.alias, r.status, r.status_reason]);
}

function events(): Array<Record<string, unknown>> {
  return (
    handle!.db.prepare("SELECT details FROM activity_log WHERE action_type = 'aliases_suspended' ORDER BY id").all() as Array<{
      details: string;
    }>
  ).map((r) => JSON.parse(r.details) as Record<string, unknown>);
}

/** Similarity by pair, from a table; records what was asked. */
function similarityFrom(table: Record<string, number>): NameSimilarity & { asked: string[] } {
  const asked: string[] = [];
  const fn = (async (pairs) => {
    return pairs.map((p) => {
      asked.push(`${p.a}|${p.b}`);
      return table[`${p.a}|${p.b}`] ?? 0;
    });
  }) as NameSimilarity & { asked: string[] };
  fn.asked = asked;
  return fn;
}

describe('screenAliases', () => {
  it('sets aside the clearly wrong shapes in one run, one event, and deletes nothing', async () => {
    handle = setupTestDb();
    seed('GPT 4', 'GPT-4');
    seed('Ethereum', 'Ethereum Foundation');
    seed('Confidence Interval', 'Continuous Integration (CI)');
    seed('English', 'programming language');
    seed('Large language model', 'Large language models');
    seed('Kaunas City Hall', 'Kaunas City Museum');
    const sim = similarityFrom({ 'English|programming language': 0.41, 'Kaunas City Hall|Kaunas City Museum': 0.93 });

    const result = await screenAliases(handle.db, { trigger: 'boot', similarity: sim });

    expect(result).toEqual({ status: 'done', screened: 6, suspended: 3 });
    expect(sim.asked).toEqual(['English|programming language', 'Kaunas City Hall|Kaunas City Museum']);
    expect(statuses()).toEqual([
      ['GPT 4', 'active', null],
      ['Ethereum', 'suspended', 'token_extension'],
      ['Confidence Interval', 'suspended', 'parenthetical_expansion'],
      ['English', 'suspended', 'content_words'],
      ['Large language model', 'active', null],
      ['Kaunas City Hall', 'active', null],
    ]);
    expect(getAliases().map((a) => a.alias)).toEqual(['GPT 4', 'Large language model', 'Kaunas City Hall']);
    expect(events()).toEqual([
      {
        trigger: 'boot',
        suspended: 3,
        reasons: { token_extension: 1, parenthetical_expansion: 1, content_words: 1 },
        examples: [
          { alias: 'Ethereum', canonical: 'Ethereum Foundation' },
          { alias: 'Confidence Interval', canonical: 'Continuous Integration (CI)' },
          { alias: 'English', canonical: 'programming language' },
        ],
      },
    ]);
    expect(getSetting(ALIAS_SCREEN_VERSION_KEY)).toBe(ALIAS_SCREEN_VERSION);
    expect(getSetting(ALIAS_SCREEN_THROUGH_KEY)).toBe('6');
  });

  it('screens only active rows with no method; people come from entity mentions', async () => {
    handle = setupTestDb();
    const sid = seedSource(handle.db);
    handle.db
      .prepare(`INSERT INTO entity_mentions (canonical_name, source_id, entity_type) VALUES ('Paul Graham', ?, 'PERSON')`)
      .run(sid);
    seed('Ethereum', 'Ethereum Foundation', { method: 'llm' }); // the resolver made it: trusted
    seed('Bitcoin', 'Bitcoin Core', { status: 'retired' });
    seed('Paul', 'Paul Graham'); // a person's shorter name
    const result = await screenAliases(handle.db, { trigger: 'boot', similarity: null });
    expect(result).toEqual({ status: 'done', screened: 1, suspended: 0 });
    expect(statuses()).toEqual([
      ['Ethereum', 'active', null],
      ['Bitcoin', 'retired', null],
      ['Paul', 'active', null],
    ]);
    expect(events()).toEqual([]); // nothing set aside, no event
    expect(getSetting(ALIAS_SCREEN_VERSION_KEY)).toBe(ALIAS_SCREEN_VERSION);
  });

  it('writes nothing when it needs similarity it may not ask for, or nlp-service fails', async () => {
    handle = setupTestDb();
    seed('Ethereum', 'Ethereum Foundation');
    seed('English', 'programming language');

    expect(await screenAliases(handle.db, { trigger: 'boot', similarity: null })).toEqual({
      status: 'needs_similarity', screened: 2, suspended: 0,
    });
    const failing: NameSimilarity = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    expect(await screenAliases(handle.db, { trigger: 'boot', similarity: failing })).toEqual({
      status: 'unavailable', screened: 2, suspended: 0,
    });
    const short: NameSimilarity = async () => [];
    expect((await screenAliases(handle.db, { trigger: 'boot', similarity: short })).status).toBe('unavailable');

    expect(statuses()).toEqual([
      ['Ethereum', 'active', null],
      ['English', 'active', null],
    ]);
    expect(events()).toEqual([]);
    expect(getSetting(ALIAS_SCREEN_VERSION_KEY)).toBeNull();
  });

  it('is idempotent: a boot run after a finished one looks only at newer rows', async () => {
    handle = setupTestDb();
    seed('Ethereum', 'Ethereum Foundation');
    await screenAliases(handle.db, { trigger: 'boot', similarity: null });
    const sim = similarityFrom({});

    expect(await screenAliases(handle.db, { trigger: 'boot', similarity: sim })).toEqual({
      status: 'done', screened: 0, suspended: 0,
    });
    // An older image wrote a row since (no method): the next boot screens it.
    seed('Solana', 'Solana Labs');
    expect(await screenAliases(handle.db, { trigger: 'boot', similarity: sim })).toEqual({
      status: 'done', screened: 1, suspended: 1,
    });
    // A forced run (after an import) looks at every row again; nothing changes.
    expect(await screenAliases(handle.db, { trigger: 'import', force: true, similarity: sim })).toEqual({
      status: 'done', screened: 0, suspended: 0,
    });
    expect(events()).toHaveLength(2);
    expect(handle.db.prepare('SELECT COUNT(*) AS n FROM aliases').get()).toEqual({ n: 2 });
  });

  it('leaves a row a compile re-activated while the screen waited for similarity', async () => {
    handle = setupTestDb();
    const id = seed('English', 'programming language');
    const sim: NameSimilarity = async (pairs) => {
      handle!.db.prepare(`UPDATE aliases SET method = 'llm' WHERE id = ?`).run(id);
      return pairs.map(() => 0.2);
    };
    expect(await screenAliases(handle.db, { trigger: 'boot', similarity: sim })).toEqual({
      status: 'done', screened: 1, suspended: 0,
    });
    expect(statuses()).toEqual([['English', 'active', null]]);
    expect(events()).toEqual([]);
  });
});

describe('scheduleAliasScreen', () => {
  it('asks nlp-service, and retries later when it cannot be reached', async () => {
    handle = setupTestDb();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    seed('English', 'programming language');
    let up = false;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!up) throw new Error('connect ECONNREFUSED');
      const { pairs } = JSON.parse(String(init?.body)) as { pairs: Array<{ a: string; b: string }> };
      return Response.json({ items: pairs.map((p) => ({ ...p, similarity: 0.3 })), count: pairs.length });
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await scheduleAliasScreen(handle.db, 'boot');
    expect(first?.status).toBe('unavailable');
    expect(statuses()).toEqual([['English', 'active', null]]);

    up = true;
    await vi.advanceTimersByTimeAsync(30_000);
    await aliasScreenIdle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/resolve\/name-similarity$/);
    expect(statuses()).toEqual([['English', 'suspended', 'content_words']]);
  });

  it('stops retrying once the database is closed', async () => {
    handle = setupTestDb();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers();
    seed('English', 'programming language');
    const fetchMock = vi.fn(async () => {
      throw new Error('down');
    });
    vi.stubGlobal('fetch', fetchMock);
    await scheduleAliasScreen(handle.db, 'boot');
    handle.cleanup();
    handle = null;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await aliasScreenIdle()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('boot (instrumentation.ts)', () => {
  it('screens at boot without waiting for nlp-service, and only once', async () => {
    handle = setupTestDb();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    seed('Ethereum', 'Ethereum Foundation');
    seed('English', 'programming language');
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const { pairs } = JSON.parse(String(init?.body)) as { pairs: Array<{ a: string; b: string }> };
      return Response.json({ items: pairs.map((p) => ({ ...p, similarity: 0.2 })), count: pairs.length });
    });
    vi.stubGlobal('fetch', fetchMock);

    await register();
    await aliasScreenIdle();
    expect(statuses()).toEqual([
      ['Ethereum', 'suspended', 'token_extension'],
      ['English', 'suspended', 'content_words'],
    ]);
    expect(events()).toHaveLength(1);

    await register();
    await aliasScreenIdle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events()).toHaveLength(1);
  });
});

describe('activity feed', () => {
  it('renders the set-aside row', () => {
    const def = getEventDef('aliases_suspended');
    expect(def).not.toBeNull();
    const row: FeedActivityRow = {
      id: 1, timestamp: '2026-10-23 10:00:00', action_type: 'aliases_suspended', source_id: null, source_title: null,
      details: JSON.stringify({
        trigger: 'boot', suspended: 3, reasons: { token_extension: 3 },
        examples: [{ alias: 'Ethereum', canonical: 'Ethereum Foundation' }],
      }),
    };
    const text = (node: unknown): string => {
      if (node === null || node === undefined || typeof node === 'boolean') return '';
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (Array.isArray(node)) return node.map(text).join('');
      return text((node as ReactElement<{ children?: unknown }>).props.children);
    };
    const content = def!.render(row);
    expect(text(content.primary)).toBe('3 name matches set aside');
    expect(text(content.secondary)).toBe(
      'Ethereum → Ethereum Foundation and 2 more · new sources no longer go to these pages under these names'
    );
  });
});
