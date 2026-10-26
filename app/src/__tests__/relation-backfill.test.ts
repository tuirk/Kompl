/**
 * backfillRelationDescriptions (lib/relation-backfill.ts): relations stored
 * before schema v28 get the LLM's sentence from extractions.llm_output, with
 * no LLM call. The boot hook runs it once per backfill version.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { register } from '../instrumentation';
import { getSetting, setSetting } from '../lib/db';
import { backfillRelationDescriptions } from '../lib/relation-backfill';
import { seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  handle?.cleanup();
  handle = null;
});

type Rel = { from_entity: string; to: string; type: string; description?: string };

/** An extraction plus pre-v28 rows (description NULL), stored as given. */
function seed(rels: Rel[], rows: Array<[string, string, string]>, llmOutput?: string): string {
  const db = handle!.db;
  const source_id = seedSource(db);
  db.prepare(
    `INSERT INTO extractions (source_id, ner_output, profile, llm_output) VALUES (?, '{}', 'default', ?)`
  ).run(source_id, llmOutput ?? JSON.stringify({ relationships: rels }));
  const ins = db.prepare(
    `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id) VALUES (?, ?, ?, ?)`
  );
  for (const [from, to, type] of rows) ins.run(from, to, type, source_id);
  return source_id;
}

/** A second unmatched row of the type, so the pair fallback can't fill the row under test. */
const DISTRACTOR = (type: string): [string, string, string] => ['Other', 'Row', type];

function addAlias(alias: string, canonical: string): void {
  handle!.db.prepare('INSERT INTO aliases (alias, canonical_name) VALUES (?, ?)').run(alias, canonical);
}

function described(sourceId: string): Record<string, string | null> {
  const rows = handle!.db
    .prepare(
      `SELECT from_canonical AS f, to_canonical AS t, relationship_type AS y, description AS d
         FROM relationship_mentions WHERE source_id = ?`
    )
    .all(sourceId) as Array<{ f: string; t: string; y: string; d: string | null }>;
  return Object.fromEntries(rows.map((r) => [`${r.f}|${r.y}|${r.t}`, r.d]));
}

describe('backfillRelationDescriptions', () => {
  it('fills an exact match, case-insensitively', () => {
    handle = setupTestDb();
    const s = seed(
      [{ from_entity: 'bitcoin', to: 'Proof-of-Work', type: 'uses', description: ' Bitcoin uses PoW. ' }],
      [['Bitcoin', 'proof-of-work', 'uses'], DISTRACTOR('uses')]
    );
    expect(backfillRelationDescriptions(handle.db)).toEqual({ filled: 1, unmatched: 1 });
    expect(described(s)).toEqual({ 'Bitcoin|uses|proof-of-work': 'Bitcoin uses PoW.', 'Other|uses|Row': null });
  });

  it('pins names through the current aliases table', () => {
    handle = setupTestDb();
    addAlias('GPT4', 'GPT-4');
    const s = seed(
      [{ from_entity: 'GPT4', to: 'OpenAI', type: 'created_by', description: 'OpenAI built GPT-4.' }],
      [['GPT-4', 'OpenAI', 'created_by'], DISTRACTOR('created_by')]
    );
    expect(backfillRelationDescriptions(handle.db).filled).toBe(1);
    expect(described(s)['GPT-4|created_by|OpenAI']).toBe('OpenAI built GPT-4.');
  });

  it('also tries the LLM names when the row kept a spelling from before a newer alias', () => {
    handle = setupTestDb();
    addAlias('Ether', 'Ethereum');
    const s = seed(
      [{ from_entity: 'Ether', to: 'Gas', type: 'uses', description: 'Ether pays for gas.' }],
      [['Ether', 'Gas', 'uses'], DISTRACTOR('uses')]
    );
    expect(backfillRelationDescriptions(handle.db).filled).toBe(1);
    expect(described(s)['Ether|uses|Gas']).toBe('Ether pays for gas.');
  });

  it('tries each end pinned or as written, so a row pinned on one end only still matches', () => {
    handle = setupTestDb();
    addAlias('proof-of-work', 'proof-of-work consensus');
    addAlias('Bitcoin', 'Bitcoin network'); // added after the row was written
    const s = seed(
      [{ from_entity: 'Bitcoin', to: 'proof-of-work', type: 'uses', description: 'Bitcoin uses proof-of-work.' }],
      [['Bitcoin', 'proof-of-work consensus', 'uses'], DISTRACTOR('uses')]
    );
    expect(backfillRelationDescriptions(handle.db).filled).toBe(1);
    expect(described(s)['Bitcoin|uses|proof-of-work consensus']).toBe('Bitcoin uses proof-of-work.');
  });

  it('also pins through aliases that getAliases() now leaves out', () => {
    handle = setupTestDb();
    addAlias('Python', 'Python 2'); // numbers differ: no longer used for new extractions
    const s = seed(
      [{ from_entity: 'Python', to: 'Guido van Rossum', type: 'created_by', description: 'Guido created Python.' }],
      [['Python 2', 'Guido van Rossum', 'created_by'], DISTRACTOR('created_by')]
    );
    expect(backfillRelationDescriptions(handle.db).filled).toBe(1);
    expect(described(s)['Python 2|created_by|Guido van Rossum']).toBe('Guido created Python.');
  });

  it('matches competes_with stored in sorted order', () => {
    handle = setupTestDb();
    const s = seed(
      [{ from_entity: 'Zcash', to: 'Monero', type: 'competes_with', description: 'Rival privacy coins.' }],
      [['Monero', 'Zcash', 'competes_with'], DISTRACTOR('competes_with')]
    );
    expect(backfillRelationDescriptions(handle.db).filled).toBe(1);
    expect(described(s)['Monero|competes_with|Zcash']).toBe('Rival privacy coins.');
  });

  it('pairs the one unmatched row with the one unmatched relation of the same source and type', () => {
    handle = setupTestDb();
    const s = seed(
      [
        { from_entity: 'Bitcoin', to: 'Proof of work', type: 'uses', description: 'Uses PoW.' },
        { from_entity: 'Lightning', to: 'Bitcoin', type: 'part_of', description: 'Matched.' },
      ],
      [
        ['Bitcoin network', 'Proof of work', 'uses'],
        ['Lightning', 'Bitcoin', 'part_of'],
      ]
    );
    expect(backfillRelationDescriptions(handle.db)).toEqual({ filled: 2, unmatched: 0 });
    expect(described(s)['Bitcoin network|uses|Proof of work']).toBe('Uses PoW.');
  });

  it('does not pair when the choice is ambiguous or the relation has no sentence', () => {
    handle = setupTestDb();
    const two = seed(
      [{ from_entity: 'X', to: 'Y', type: 'uses', description: 'X uses Y.' }],
      [
        ['X1', 'Y', 'uses'],
        ['X2', 'Y', 'uses'],
      ]
    );
    const silent = seed(
      [
        { from_entity: 'P', to: 'Q', type: 'uses' },
        { from_entity: 'R', to: 'S', type: 'uses', description: 'R uses S.' },
      ],
      [['P2', 'Q', 'uses']]
    );
    expect(backfillRelationDescriptions(handle.db)).toEqual({ filled: 0, unmatched: 3 });
    expect(Object.values(described(two))).toEqual([null, null]);
    expect(Object.values(described(silent))).toEqual([null]);
  });

  it('is idempotent and never replaces a stored sentence', () => {
    handle = setupTestDb();
    const s = seed(
      [
        { from_entity: 'A', to: 'B', type: 'uses', description: 'A uses B.' },
        { from_entity: 'C', to: 'D', type: 'part_of', description: 'C is part of D.' },
      ],
      [
        ['A', 'B', 'uses'],
        ['C2', 'D', 'part_of'],
      ]
    );
    handle.db.prepare(`UPDATE relationship_mentions SET description = 'Kept.' WHERE from_canonical = 'A'`).run();
    expect(backfillRelationDescriptions(handle.db)).toEqual({ filled: 1, unmatched: 0 });
    const after = described(s);
    expect(backfillRelationDescriptions(handle.db)).toEqual({ filled: 0, unmatched: 0 });
    expect(described(s)).toEqual(after);
    expect(after).toEqual({ 'A|uses|B': 'Kept.', 'C2|part_of|D': 'C is part of D.' });
  });

  it('skips malformed llm_output and keeps going', () => {
    handle = setupTestDb();
    const bad = seed([], [['A', 'B', 'uses']], '{not json');
    const arr = seed([], [['C', 'D', 'uses']], '[1, 2]');
    const good = seed([{ from_entity: 'E', to: 'F', type: 'uses', description: 'E uses F.' }], [['E', 'F', 'uses']]);
    expect(backfillRelationDescriptions(handle.db)).toEqual({ filled: 1, unmatched: 2 });
    expect(described(bad)['A|uses|B']).toBeNull();
    expect(described(arr)['C|uses|D']).toBeNull();
    expect(described(good)['E|uses|F']).toBe('E uses F.');
  });
});

describe('boot backfill (instrumentation.ts)', () => {
  it('runs once per version and logs relation_descriptions_backfill_done', async () => {
    handle = setupTestDb();
    setSetting('wikilinks_resync_version', '1'); // not under test here
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const s = seed([{ from_entity: 'A', to: 'B', type: 'uses', description: 'A uses B.' }], [['A', 'B', 'uses']]);

    await register();
    expect(described(s)['A|uses|B']).toBe('A uses B.');
    expect(getSetting('relation_descriptions_backfill_version')).toBe('1');
    const events = log.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'relation_descriptions_backfill_done', filled: 1, unmatched: 0 })
    );

    handle.db.prepare('UPDATE relationship_mentions SET description = NULL').run();
    await register();
    expect(described(s)['A|uses|B']).toBeNull();
  });
});
