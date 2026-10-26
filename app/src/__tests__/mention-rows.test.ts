/**
 * The pieces of the resolve mention rebuild (plan item 1.5):
 *   - buildResolverPin: a source's names take its resolver group's canonical,
 *     by kind; other names take the session's agreed canonical, else the
 *     extract-time pin (page title before alias)
 *   - buildSourceMentionRows: entity_type kept, one row per canonical,
 *     relation ends named as the source's own entities, relation rows built
 *     by buildRelationRows (type spelling, sorted competes_with)
 *   - rebuildSessionMentions: one transaction, sources outside the session
 *     skipped, first_seen_at and sentences kept
 */

import { describe, it, expect, afterEach } from 'vitest';
import { rebuildSessionMentions } from '../lib/db';
import { buildMentionPin, buildResolverPin, type ResolverGroup } from '../lib/mention-pin';
import { buildSourceMentionRows, sessionMentionRows } from '../lib/mention-rows';
import { seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

const group = (canonical: string, type: string, aliases: string[], source_ids: string[]): ResolverGroup => ({
  canonical, type, aliases, source_ids,
});

const GROUPS = [
  group('Google Chrome', 'ORG', ['Chrome'], ['s1']),
  group('Chrome', 'CONCEPT', [], ['s1']),
  group('Google Gemini', 'PRODUCT', ['Bard'], ['s1', 's2']),
];
const fallback = buildMentionPin(
  [{ title: 'Ethereum' }],
  [{ alias: 'Ethereum', canonical_name: 'Ethereum Foundation' }, { alias: 'ETH', canonical_name: 'Ethereum Foundation' }]
);


/** Extractions made before quotes (plan 3.2) carry none. */
const NO_QUOTE = { quote: null, quote_verified: null };
describe('buildResolverPin', () => {
  const pin = buildResolverPin(GROUPS, fallback);

  it("maps a source's name through the group holding it with that source, by kind", () => {
    expect(pin('s1')('Chrome', 'ORG')).toBe('Google Chrome');
    expect(pin('s1')('Chrome', 'PRODUCT')).toBe('Google Chrome'); // same family as ORG
    expect(pin('s1')('chrome', 'CONCEPT')).toBe('Chrome');
    expect(pin('s1')(' CHROME ')).toBe('Google Chrome'); // no kind: the first group
  });

  it('maps a name no group holds with the source through the groups that agree, else the extract pin', () => {
    expect(pin('s3')('bard')).toBe('Google Gemini');
    expect(pin('s3')('Chrome')).toBe('Chrome'); // two groups disagree: as written
    expect(pin('s3')('ethereum')).toBe('Ethereum'); // the page title before the alias
    expect(pin('s3')('ETH')).toBe('Ethereum Foundation');
    expect(pin('s3')('Vyper')).toBe('Vyper');
  });
});

describe('buildSourceMentionRows', () => {
  it('turns a created_by written with the person first (film run 2026-10-25)', () => {
    const rows = buildSourceMentionRows(
      {
        entities: [
          { name: 'Saul Bass', type: 'PERSON' },
          { name: 'The Man with the Golden Arm', type: 'OTHER' },
          { name: 'Otto Preminger', type: 'PERSON' },
          { name: 'Elaine Bass', type: 'PERSON' },
        ],
        concepts: [{ name: 'Title sequence' }],
        relationships: [
          { from_entity: 'Saul Bass', to: 'The Man with the Golden Arm', type: 'created_by' },
          { from_entity: 'The Man with the Golden Arm', to: 'Otto Preminger', type: 'created_by' },
          { from_entity: 'Saul Bass', to: 'Title sequence', type: 'created_by' },
          { from_entity: 'Saul Bass', to: 'Elaine Bass', type: 'created_by' }, // two people: left as written
          { from_entity: 'Saul Bass', to: 'Unlisted film', type: 'created_by' }, // kind unknown: left as written
          { from_entity: 'Saul Bass', to: 'Title sequence', type: 'uses' },
        ],
      },
      's1',
      (n) => n
    );
    expect(rows.relations.map((r) => [r.from_canonical, r.relationship_type, r.to_canonical])).toEqual([
      ['The Man with the Golden Arm', 'created_by', 'Saul Bass'],
      ['The Man with the Golden Arm', 'created_by', 'Otto Preminger'],
      ['Title sequence', 'created_by', 'Saul Bass'],
      ['Saul Bass', 'created_by', 'Elaine Bass'],
      ['Saul Bass', 'created_by', 'Unlisted film'],
      ['Saul Bass', 'uses', 'Title sequence'],
    ]);
  });

  it('leaves a created_by whose maker is an organisation as written: a character typed PERSON is made', () => {
    const rows = buildSourceMentionRows(
      {
        entities: [
          { name: 'Mickey Mouse', type: 'PERSON' },
          { name: 'The Walt Disney Company', type: 'ORG' },
        ],
        relationships: [{ from_entity: 'Mickey Mouse', to: 'The Walt Disney Company', type: 'created_by' }],
      },
      's1',
      (n) => n
    );
    expect(rows.relations.map((r) => [r.from_canonical, r.relationship_type, r.to_canonical])).toEqual([
      ['Mickey Mouse', 'created_by', 'The Walt Disney Company'],
    ]);
  });

  it('keeps entity types, one row per canonical, and names relation ends as the source names its entities', () => {
    const rows = buildSourceMentionRows(
      {
        entities: [
          { name: 'Chrome', type: 'ORG' },
          { name: 'Bard', type: 'PRODUCT' },
          { name: 'Google Gemini', type: 'PRODUCT' }, // same canonical as Bard: the first row stays
          { name: '  ', type: 'ORG' },
          { name: 42, type: 'ORG' },
        ],
        concepts: [{ name: 'Chrome' }, { name: 'Browser engine' }],
        relationships: [
          { from_entity: 'Chrome', to: 'Bard', type: 'Competes with' },
          { from_entity: 'Gemini app', to: 'chrome', type: 'competes_with', description: 'Later sentence.' },
          { from_entity: 'Google Gemini', to: 'Chrome', type: 'competes_with', description: 'Fills the first.' },
        ],
      },
      's1',
      buildResolverPin(GROUPS, (n) => n)('s1')
    );
    expect(rows.entities).toEqual([
      { canonical_name: 'Google Chrome', source_id: 's1', entity_type: 'ORG' },
      { canonical_name: 'Google Gemini', source_id: 's1', entity_type: 'PRODUCT' },
      { canonical_name: 'Chrome', source_id: 's1', entity_type: 'CONCEPT' },
      { canonical_name: 'Browser engine', source_id: 's1', entity_type: 'CONCEPT' },
    ]);
    expect(rows.relations).toEqual([
      // "Chrome" is the source's ORG first, so both ends name its rows; competes_with is sorted
      { from_canonical: 'Google Chrome', to_canonical: 'Google Gemini', relationship_type: 'competes_with', source_id: 's1', description: 'Fills the first.', ...NO_QUOTE },
      { from_canonical: 'Gemini app', to_canonical: 'Google Chrome', relationship_type: 'competes_with', source_id: 's1', description: 'Later sentence.', ...NO_QUOTE },
    ]);
  });

  it('leaves out an extraction whose llm_output does not parse', () => {
    const rows = sessionMentionRows(
      [{ source_id: 'bad', llm_output: '{not json' }, { source_id: 'ok', llm_output: '{"entities":[{"name":"Bard","type":"PRODUCT"}]}' }],
      GROUPS,
      (n) => n
    );
    expect(rows.map((r) => [r.source_id, r.entities.map((e) => e.canonical_name)])).toEqual([['ok', ['Google Gemini']]]);
  });
});

describe('rebuildSessionMentions', () => {
  function seedRows(source_id: string, session: string): void {
    seedSource(handle!.db, { source_id, onboarding_session_id: session });
    handle!.db
      .prepare("INSERT INTO entity_mentions (canonical_name, source_id, entity_type, first_seen_at) VALUES ('Bard', ?, 'PRODUCT', '2026-01-02 00:00:00')")
      .run(source_id);
    handle!.db
      .prepare(
        `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id, first_seen_at, description)
         VALUES ('ChatGPT', 'google gemini', 'competes_with', ?, '2026-01-01 00:00:00', 'Stored sentence.')`
      )
      .run(source_id);
  }
  const rowsOf = (sid: string) => ({
    entities: [{ canonical_name: 'Google Gemini', source_id: sid, entity_type: 'PRODUCT' }],
    relations: [
      {
        from_canonical: 'ChatGPT',
        to_canonical: 'Google Gemini',
        relationship_type: 'competes_with',
        source_id: sid,
        description: null,
        quote: null,
        quote_verified: null,
      },
    ],
  });
  const dump = () =>
    handle!.db
      .prepare(
        `SELECT source_id, canonical_name AS name, first_seen_at AS at, NULL AS description FROM entity_mentions
         UNION ALL SELECT source_id, from_canonical || ' ~ ' || to_canonical, first_seen_at, description FROM relationship_mentions
         ORDER BY 1, 2`
      )
      .all();

  it("keeps the matching row's first_seen_at and sentence, else the source's earliest; skips other sessions", () => {
    handle = setupTestDb();
    seedRows('s1', 'sess');
    seedRows('other', 'earlier');

    expect(rebuildSessionMentions('sess', [{ source_id: 's1', ...rowsOf('s1') }, { source_id: 'other', ...rowsOf('other') }])).toBe(1);

    expect(dump()).toEqual([
      { source_id: 'other', name: 'Bard', at: '2026-01-02 00:00:00', description: null },
      { source_id: 'other', name: 'ChatGPT ~ google gemini', at: '2026-01-01 00:00:00', description: 'Stored sentence.' },
      { source_id: 's1', name: 'ChatGPT ~ Google Gemini', at: '2026-01-01 00:00:00', description: 'Stored sentence.' },
      { source_id: 's1', name: 'Google Gemini', at: '2026-01-01 00:00:00', description: null },
    ]);
  });

  it('writes nothing when one source fails part-way', () => {
    handle = setupTestDb();
    seedRows('s1', 'sess');
    seedRows('s2', 'sess');
    const before = dump();
    handle.db.exec(
      `CREATE TRIGGER fail_s2 BEFORE INSERT ON entity_mentions WHEN NEW.source_id = 's2'
       BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`
    );

    expect(() => rebuildSessionMentions('sess', [{ source_id: 's1', ...rowsOf('s1') }, { source_id: 's2', ...rowsOf('s2') }])).toThrow(
      /disk I\/O error/
    );
    expect(dump()).toEqual(before);
  });
});
