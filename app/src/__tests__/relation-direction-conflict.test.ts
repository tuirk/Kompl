/**
 * A directed relation type stated both ways round for one pair (film run
 * 2026-10-25: "Henryk Tomaszewski part_of Polish School of Posters" from one
 * source, the reverse from another). Every read model shows one direction:
 * the one more sources state, then a checked quote, then the more recent
 * source, then the newest row; the other side stays visible as a conflict.
 *
 * The reverse row came from the extraction itself (the BFI source's
 * llm_output reads "Polish School of Posters part_of Henryk Tomaszewski"
 * for "a loose association of artists headed by Henryk Tomaszewski"): the
 * mention rebuild keeps each extraction's direction, and the competes_with
 * re-sort never touches a directed type. The first test pins that down.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { bulkInsertAliases } from '../lib/db';
import { prefersFirst } from '../lib/relation-direction';
import { sortDirectionAgnosticRelations } from '../lib/relation-order';
import { getPageConnections, getRelationEdges, getRelationsAmong } from '../lib/relations';
import { rebuildMentionsLikeResolve } from './helpers/rebuild-mentions';
import { seedExtraction, seedPage, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

const BFI = 'src-bfi';
const DAILYART = 'src-dailyart';

/** The film's two sources, as extracted, and their pages; the second spells the school differently. */
function seedFilm(dates: { bfi: string; dailyart: string } = { bfi: '2019-03-01', dailyart: '2021-06-15' }) {
  handle = setupTestDb();
  const db = handle.db;
  seedPage(db, { page_id: 'tomaszewski', title: 'Henryk Tomaszewski' });
  seedPage(db, { page_id: 'school', title: 'Polish School of Posters' });
  bulkInsertAliases([{ alias: 'Polish Poster School', canonical: 'Polish School of Posters' }]);
  const extracted: Array<[string, string, string, string, string]> = [
    [BFI, 'BFI', 'Polish School of Posters', 'Henryk Tomaszewski',
      'Established in 1947, the Polish School of Posters was a loose association of artists headed by Henryk Tomaszewski.'],
    [DAILYART, 'DailyArt', 'Henryk Tomaszewski', 'Polish Poster School',
      'Winning five awards at the International Poster Biennale in Vienna in 1948, Henryk Tomaszewski was to become one of the central figures of the Polish Poster School.'],
  ];
  for (const [source_id, title, from_entity, to, quote] of extracted) {
    seedSource(db, { source_id, title, onboarding_session_id: 'sess' });
    seedExtraction(db, {
      source_id,
      llm_output: { relationships: [{ from_entity, to, type: 'part_of', description: `${title} says so.`, quote, quote_verified: true }] },
    });
  }
  const date = db.prepare(`UPDATE sources SET published_at = ?, published_at_source = 'page_published' WHERE source_id = ?`);
  date.run(dates.bfi, BFI);
  date.run(dates.dailyart, DAILYART);
  rebuildMentionsLikeResolve('sess');
  return db;
}

describe('how the reverse row is stored', () => {
  it('keeps each extraction’s own direction through the rebuild and the competes_with re-sort', () => {
    const db = seedFilm();
    sortDirectionAgnosticRelations(db);
    const rows = db
      .prepare('SELECT from_canonical AS f, to_canonical AS t, source_id AS s FROM relationship_mentions ORDER BY source_id')
      .all();
    expect(rows).toEqual([
      { f: 'Polish School of Posters', t: 'Henryk Tomaszewski', s: BFI },
      { f: 'Henryk Tomaszewski', t: 'Polish School of Posters', s: DAILYART },
    ]);
  });
});

describe('one direction per directed type and pair', () => {
  it('on a tie with quotes on both sides, shows the reading of the more recent source and lists both', () => {
    seedFilm();
    const [group] = getPageConnections('tomaszewski').groups;
    expect(group.label).toBe('Part of');
    expect(group.items).toHaveLength(1);
    expect(group.items[0]).toMatchObject({
      page_id: 'school',
      direction: 'out',
      source_count: 1,
      direction_dispute: {
        kept: { label: 'Part of', sources: [{ source_id: DAILYART, source_title: 'DailyArt' }] },
        other: { label: 'Includes', sources: [{ source_id: BFI, source_title: 'BFI' }] },
      },
      outdated: null,
    });
    // The other page reads the same relation from its side.
    expect(getPageConnections('school').groups).toMatchObject([
      {
        label: 'Includes',
        items: [{
          page_id: 'tomaszewski',
          direction_dispute: { kept: { label: 'Includes' }, other: { label: 'Part of' } },
        }],
      },
    ]);

    const [edge] = getRelationEdges().edges;
    expect(edge).toMatchObject({ source: 'school', target: 'tomaszewski' });
    expect(edge.relations).toEqual([
      { type: 'part_of', direction: 'in', source_count: 1, direction_disputed: true, outdated: false },
    ]);

    const among = getRelationsAmong(['tomaszewski'], 10);
    expect(among).toHaveLength(1);
    expect(among[0]).toMatchObject({
      from: { page_id: 'tomaszewski' },
      to: { page_id: 'school' },
      source_ids: [DAILYART],
      direction_dispute: { other_source_ids: [BFI] },
    });
  });

  it('follows the dates: the more recent source wins the tie', () => {
    seedFilm({ bfi: '2024-01-01', dailyart: '2021-06-15' });
    expect(getPageConnections('tomaszewski').groups).toMatchObject([
      { label: 'Includes', items: [{ page_id: 'school', direction: 'in' }] },
    ]);
  });

  it('a reading more sources state wins, whatever the dates', () => {
    const db = seedFilm({ bfi: '2024-01-01', dailyart: '2021-06-15' });
    seedSource(db, { source_id: 'src-third', title: 'Third' });
    db.prepare(
      `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id, description)
       VALUES ('Henryk Tomaszewski', 'Polish School of Posters', 'part_of', 'src-third', 'He was one of its figures.')`
    ).run();
    const [item] = getPageConnections('tomaszewski').groups[0].items;
    expect(item).toMatchObject({ direction: 'out', source_count: 2 });
    expect(item.direction_dispute?.other.sources.map((s) => s.source_id)).toEqual([BFI]);
  });
});

describe('prefersFirst', () => {
  const day = (days: Record<string, string>) => (id: string) => days[id] ?? null;
  const reading = (sourceIds: string[], quoted = false, firstRow = 0) => ({ sourceIds, quoted, firstRow });

  it('counts sources first, then a checked quote, then the newer source, then the newer row', () => {
    const none = day({});
    expect(prefersFirst(reading(['a', 'b']), reading(['c'], true), none)).toBe(true);
    expect(prefersFirst(reading(['a']), reading(['c'], true), none)).toBe(false);
    const dated = day({ a: '2020-01-01', c: '2022-01-01' });
    expect(prefersFirst(reading(['a'], true, 0), reading(['c'], true, 5), dated)).toBe(false);
    expect(prefersFirst(reading(['a'], true, 5), reading(['b'], true, 0), day({ a: '2020-01-01', b: '2020-01-01' }))).toBe(false);
    expect(prefersFirst(reading(['a'], true, 0), reading(['b'], true, 5), none)).toBe(true);
  });
});
