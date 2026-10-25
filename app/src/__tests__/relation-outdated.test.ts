/**
 * "May be outdated" (lib/relation-outdated.ts): a relation whose every
 * source is the older side of a "Changed" finding about both of its ends.
 * Modelled on the film run: "APCA part_of WCAG 3.0" from one 2022 source,
 * while the WCAG 3.0 page records (### Changed: APCA in the WCAG 3 draft)
 * that a 2026 source says APCA was dropped from the draft. The card, the
 * graph line and the research pack mark it; unrelated relations stay as
 * they are, and nothing is deleted.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { recordDisagreement, setOwnerVerdict, syncPageTextDisagreements } from '../lib/disagreements';
import { buildGraphModel } from '../lib/graph-model';
import { hoverCardText } from '../lib/graph-focus';
import { LINE_ALPHA, LINE_HEX, LINE_OUTDATED, withAlpha } from '../lib/graph-palette';
import { namesPhrase } from '../lib/relation-outdated';
import { getPageConnections, getRelationEdges, getRelationsAmong } from '../lib/relations';
import { getWikiGraph } from '../lib/wiki-graph';
import { seedPage, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

const EGGERT = 'src-eggert'; // 2021
const DATAWRAPPER = 'src-datawrapper'; // 2022
const ROSELLI = 'src-roselli'; // 2026
const SMASHING = 'src-smashing'; // 2022

const CHANGED_SECTION = [
  '# WCAG 3.0',
  '',
  '### Changed: APCA in the WCAG 3 draft',
  '',
  `One article said the draft names APCA[^${EGGERT}], and a 2022 article said the draft mentions it[^${DATAWRAPPER}].`,
  `APCA was pulled from the July 2023 working draft[^${ROSELLI}].`,
].join('\n');

function seed() {
  handle = setupTestDb();
  const db = handle.db;
  const sources: Array<[string, string, string]> = [
    [EGGERT, 'Eggert', '2021-12-14'],
    [DATAWRAPPER, 'Datawrapper', '2022-01-12'],
    [ROSELLI, 'Roselli', '2026-04-10'],
    [SMASHING, 'Smashing', '2022-09-06'],
  ];
  const date = db.prepare(`UPDATE sources SET published_at = ?, published_at_source = 'page_published' WHERE source_id = ?`);
  for (const [source_id, title, published] of sources) {
    seedSource(db, { source_id, title });
    date.run(published, source_id);
  }
  for (const [page_id, title] of [['apca', 'APCA'], ['wcag3', 'WCAG 3.0'], ['somers', 'Andrew Somers'], ['wcag2', 'WCAG 2']]) {
    seedPage(db, { page_id, title });
  }
  db.prepare('INSERT INTO aliases (alias, canonical_name, canonical_page_id) VALUES (?, ?, ?)').run('WCAG 3', 'WCAG 3.0', 'wcag3');
  const rel = db.prepare(
    `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id, description)
     VALUES (?, ?, ?, ?, ?)`
  );
  rel.run('APCA', 'WCAG 3.0', 'part_of', DATAWRAPPER, 'The WCAG 3.0 draft would adopt APCA.');
  // A newer source states this one too: current.
  rel.run('APCA', 'WCAG 3.0', 'related_to', EGGERT, 'APCA was in the early draft.');
  rel.run('APCA', 'WCAG 3.0', 'related_to', ROSELLI, 'APCA is often promoted as the WCAG 3 method.');
  // Older sources of the finding, but the finding is not about these pairs.
  rel.run('APCA', 'Andrew Somers', 'created_by', DATAWRAPPER, 'Somers is developing APCA.');
  rel.run('APCA', 'WCAG 2', 'related_to', EGGERT, 'APCA departs from WCAG 2.');
  syncPageTextDisagreements(db, { page_id: 'wcag3', title: 'WCAG 3.0' }, CHANGED_SECTION, { log: false });
  return db;
}

const item = (pageId: string, title: string) =>
  getPageConnections(pageId).groups.flatMap((g) => g.items.map((i) => ({ label: g.label, ...i }))).filter((i) => i.title === title);

describe('may be outdated', () => {
  it('marks the relation every source of which a newer Changed finding supersedes, from both ends', () => {
    seed();
    const note = { source_id: ROSELLI, source_title: 'Roselli', topic: 'APCA in the WCAG 3 draft', page_id: 'wcag3' };
    expect(item('apca', 'WCAG 3.0')).toMatchObject([{ label: 'Part of', outdated: note }]);
    expect(item('wcag3', 'APCA')).toMatchObject([{ label: 'Includes', outdated: note }]);

    const edge = getRelationEdges().edges.find((e) => e.source === 'apca' && e.target === 'wcag3');
    expect(edge?.relations).toEqual([
      { type: 'related_to', direction: 'out', source_count: 2, direction_disputed: false, outdated: false },
      { type: 'part_of', direction: 'out', source_count: 1, direction_disputed: false, outdated: true },
    ]);
    // The line is named by its current relation and not dimmed; the hover card names the outdated one.
    const model = buildGraphModel(getWikiGraph(false));
    const line = model.links.find((l) => l.a === 'apca' && l.b === 'wcag3')!;
    expect(line).toMatchObject({ outdated: false, kind: 'related', colorType: 'related_to', color: withAlpha(LINE_HEX, LINE_ALPHA.related) });
    expect(hoverCardText({ kind: 'link', link: line }, model.byId)).toEqual({
      title: 'APCA — Related to → WCAG 3.0 (+1 more)',
      detail: 'Click for the evidence · 2 sources · part of: may be outdated',
    });

    const among = getRelationsAmong(['apca'], 10).find((r) => r.type === 'part_of');
    expect(among?.outdated).toEqual(note);
  });

  it('dims a line only when every relation on it may be outdated, and then names it by that relation', () => {
    const db = seed();
    db.prepare(`DELETE FROM relationship_mentions WHERE relationship_type = 'related_to' AND to_canonical = 'WCAG 3.0'`).run();
    const model = buildGraphModel(getWikiGraph(false));
    const line = model.links.find((l) => l.a === 'apca' && l.b === 'wcag3')!;
    expect(line).toMatchObject({ outdated: true, kind: 'typed', colorType: 'part_of', color: withAlpha(LINE_HEX, LINE_OUTDATED) });
    expect(hoverCardText({ kind: 'link', link: line }, model.byId)?.detail).toBe('Click for the evidence · 1 source · may be outdated');
  });

  it('leaves alone a relation a newer source also states, and one the finding does not name', () => {
    seed();
    // "Related to" is left out where "Part of" joins the pair; the graph edge keeps it, current.
    expect(item('somers', 'APCA')).toMatchObject([{ outdated: null }]);
    expect(item('wcag2', 'APCA')).toMatchObject([{ outdated: null }]);
    const somers = getRelationEdges().edges.find((e) => e.source === 'apca' && e.target === 'somers');
    expect(somers?.relations[0].outdated).toBe(false);
    const line = buildGraphModel(getWikiGraph(false)).links.find((l) => l.a === 'apca' && l.b === 'somers');
    expect(line?.outdated).toBe(false);
  });

  it('ignores a finding the owner dismissed or the page no longer records', () => {
    const db = seed();
    const id = (db.prepare(`SELECT disagreement_id FROM disagreements WHERE kind = 'changed'`).get() as { disagreement_id: string })
      .disagreement_id;
    setOwnerVerdict(id, 'dismissed');
    expect(item('apca', 'WCAG 3.0')[0].outdated).toBeNull();
    setOwnerVerdict(id, null);
    expect(item('apca', 'WCAG 3.0')[0].outdated).not.toBeNull();
    syncPageTextDisagreements(db, { page_id: 'wcag3', title: 'WCAG 3.0' }, '# WCAG 3.0\n\nNo changes recorded.', { log: false });
    expect(item('apca', 'WCAG 3.0')[0].outdated).toBeNull();
  });

  it('needs publication dates: a source known only by the day it was added has no place in time', () => {
    const db = seed();
    db.prepare(`UPDATE sources SET published_at = NULL, published_at_source = NULL WHERE source_id = ?`).run(ROSELLI);
    expect(item('apca', 'WCAG 3.0')[0].outdated).toBeNull();
  });

  it('counts a claim check finding the same way, by its sources and topic', () => {
    const db = seed();
    syncPageTextDisagreements(db, { page_id: 'wcag3', title: 'WCAG 3.0' }, '# WCAG 3.0', { log: false });
    recordDisagreement(db, {
      page_id: 'apca', found_by: 'claim_check', kind: 'changed', topic: 'APCA status in WCAG3',
      source_a: DATAWRAPPER, quote_a: 'The draft mentions APCA.', source_b: ROSELLI, quote_b: 'APCA was marked for removal.',
    });
    // "WCAG3" is no name of the WCAG 3.0 page here: not matched.
    expect(item('apca', 'WCAG 3.0')[0].outdated).toBeNull();
    db.prepare('INSERT INTO aliases (alias, canonical_name, canonical_page_id) VALUES (?, ?, ?)').run('WCAG3', 'WCAG 3.0', 'wcag3');
    expect(item('apca', 'WCAG 3.0')[0].outdated).toMatchObject({ source_id: ROSELLI, topic: 'APCA status in WCAG3', page_id: 'apca' });
  });
});

describe('namesPhrase', () => {
  it('matches a whole name in any case, never inside a word or a longer number', () => {
    expect(namesPhrase('APCA’s place in WCAG 3', 'apca')).toBe(true);
    expect(namesPhrase('APCA’s place in WCAG 3', 'WCAG 3')).toBe(true);
    expect(namesPhrase('APCA in the WCAG 3.1 draft', 'WCAG 3')).toBe(false);
    expect(namesPhrase('WCAG 3, then 4', 'WCAG 3')).toBe(true);
    expect(namesPhrase('The APCAx method', 'APCA')).toBe(false);
    expect(namesPhrase('Go and Rust', 'G')).toBe(false);
  });
});
