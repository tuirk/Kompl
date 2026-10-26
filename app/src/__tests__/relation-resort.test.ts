/**
 * competes_with / contradicts rows are stored with from/to sorted lowercase
 * (relation-rows.ts), and plan Rule 4 counts them with an exact sorted match
 * (countSourcesForRelationship). When resolve maps one end to another name
 * (the mention rebuild, db.ts rebuildSessionMentions), the row must still be
 * sorted, or that source drops out of the count.
 *
 * Covers:
 *   - the rebuild keeps the session's direction-agnostic rows sorted and
 *     keeps their sentence, also when a renamed row lands on an existing one;
 *     directional rows keep their order, and other sessions' rows are left
 *     alone
 *   - Rule 4 then counts all three sources and plans the comparison page
 *   - the description backfill finds rows an older rename re-sorted
 *   - sortDirectionAgnosticRelations over every row (the one-time repair for
 *     rows renamed before the re-sort; not run at boot)
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  bulkInsertAliases,
  countSourcesForRelationship,
  getSourceIdsForRelationship,
  insertRelationshipMentions,
} from '../lib/db';
import { sortDirectionAgnosticRelations } from '../lib/relation-order';
import { backfillRelationDescriptions } from '../lib/relation-backfill';
import { POST as planPOST } from '../app/api/compile/plan/route';
import { rebuildMentionsLikeResolve } from './helpers/rebuild-mentions';
import { seedExtraction, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

type Row = { from: string; to: string; type: string; source_id: string; description: string | null };

function rows(): Row[] {
  return handle!.db
    .prepare(
      `SELECT from_canonical AS "from", to_canonical AS "to", relationship_type AS type, source_id, description
         FROM relationship_mentions ORDER BY source_id, relationship_type, from_canonical, to_canonical`
    )
    .all() as Row[];
}

const BARD_IS_GEMINI = [{ alias: 'Bard', canonical: 'Google Gemini' }];
const geminiGroup = (source_ids: string[]) => ({ canonical: 'Google Gemini', type: 'PRODUCT', aliases: ['Bard'], source_ids });

/** A session source whose extraction lists these relations (and their ends as products). */
function seedRelations(source_id: string, session: string, relationships: Array<Record<string, string>>): string {
  const names = [...new Set(relationships.flatMap((r) => [r.from_entity, r.to]))];
  seedSource(handle!.db, { source_id, onboarding_session_id: session });
  seedExtraction(handle!.db, {
    source_id,
    llm_output: { entities: names.map((name) => ({ name, type: 'PRODUCT' })), concepts: [], relationships },
  });
  return source_id;
}

describe('the resolve mention rebuild keeps direction-agnostic rows sorted', () => {
  it('sorts a renamed competes_with / contradicts row and keeps its sentence', () => {
    handle = setupTestDb();
    const s1 = seedRelations('s1', 'sess', [
      { from_entity: 'Bard', to: 'ChatGPT', type: 'competes_with', description: 'Bard rivals ChatGPT.' },
      { from_entity: 'Bard', to: 'Claude', type: 'contradicts', description: 'They disagree.' },
      // directional: keeps its natural order after the rename
      { from_entity: 'Bard', to: 'ChatGPT', type: 'uses', description: 'Directional.' },
    ]);

    rebuildMentionsLikeResolve('sess', [geminiGroup([s1])]);

    expect(rows()).toEqual([
      { from: 'ChatGPT', to: 'Google Gemini', type: 'competes_with', source_id: 's1', description: 'Bard rivals ChatGPT.' },
      { from: 'Claude', to: 'Google Gemini', type: 'contradicts', source_id: 's1', description: 'They disagree.' },
      { from: 'Google Gemini', to: 'ChatGPT', type: 'uses', source_id: 's1', description: 'Directional.' },
    ]);
  });

  it('collapses onto a row the source already has, keeping a sentence', () => {
    handle = setupTestDb();
    const s1 = seedRelations('s1', 'sess', [
      // renamed row without a sentence: takes the existing row's
      { from_entity: 'Bard', to: 'ChatGPT', type: 'competes_with' },
      { from_entity: 'ChatGPT', to: 'Google Gemini', type: 'competes_with', description: 'Existing sentence.' },
      // the first entry's own sentence stays
      { from_entity: 'Bard', to: 'Claude', type: 'contradicts', description: 'Renamed sentence.' },
      { from_entity: 'Claude', to: 'Google Gemini', type: 'contradicts', description: 'Older sentence.' },
    ]);

    rebuildMentionsLikeResolve('sess', [geminiGroup([s1])]);

    expect(rows()).toEqual([
      { from: 'ChatGPT', to: 'Google Gemini', type: 'competes_with', source_id: 's1', description: 'Existing sentence.' },
      { from: 'Claude', to: 'Google Gemini', type: 'contradicts', source_id: 's1', description: 'Renamed sentence.' },
    ]);
  });

  it("leaves other sessions' rows as they are", () => {
    handle = setupTestDb();
    const old = seedSource(handle.db, { source_id: 'old', onboarding_session_id: 'earlier' });
    const s1 = seedRelations('s1', 'sess', []);
    // An unsorted row from before the re-sort, in another session.
    handle.db
      .prepare(
        `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id)
         VALUES ('Zeta', 'Alpha', 'competes_with', ?)`
      )
      .run(old);

    rebuildMentionsLikeResolve('sess', [geminiGroup([s1, old])]);

    expect(rows()).toEqual([{ from: 'Zeta', to: 'Alpha', type: 'competes_with', source_id: 'old', description: null }]);
  });
});

describe('Rule 4 after a rename (audit scenario)', () => {
  it('counts all three sources and plans the comparison page', async () => {
    handle = setupTestDb();
    const session_id = 'sess-b1';
    const seed = (source_id: string, a: string, b: string) => {
      seedSource(handle!.db, {
        source_id,
        onboarding_session_id: session_id,
        compile_status: 'pending',
        raw_markdown: 'x'.repeat(600),
      });
      seedExtraction(handle!.db, {
        source_id,
        llm_output: {
          entities: [{ name: a, type: 'PRODUCT' }, { name: b, type: 'PRODUCT' }],
          concepts: [],
          relationships: [{ from_entity: a, to: b, type: 'competes_with' }],
        },
      });
    };
    seed('resort-1', 'Bard', 'ChatGPT'); // stored (Bard, ChatGPT)
    seed('resort-2', 'ChatGPT', 'Google Gemini');
    seed('resort-3', 'Google Gemini', 'ChatGPT'); // stored sorted: (ChatGPT, Google Gemini)

    // What resolve does: Bard is an alias of Google Gemini.
    const all = ['resort-1', 'resort-2', 'resort-3'];
    bulkInsertAliases(BARD_IS_GEMINI);
    rebuildMentionsLikeResolve(session_id, [geminiGroup(all)]);

    expect(countSourcesForRelationship('ChatGPT', 'Google Gemini', 'competes_with')).toBe(3);

    const res = await planPOST(
      new Request('http://test/api/compile/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id,
          canonical_entities: [
            { canonical: 'ChatGPT', type: 'PRODUCT', aliases: [], source_ids: all, method: 'exact' },
            { canonical: 'Google Gemini', type: 'PRODUCT', aliases: ['Bard'], source_ids: all, method: 'exact' },
          ],
        }),
      })
    );
    const body = (await res.json()) as {
      pages: Array<{ title: string; page_type: string; source_ids: string[] }>;
      stats: { comparison_pages: number };
    };

    expect(body.stats.comparison_pages).toBe(1);
    const comparison = body.pages.find((p) => p.page_type === 'comparison');
    expect(comparison?.title).toBe('ChatGPT vs Google Gemini');
    expect([...(comparison?.source_ids ?? [])].sort()).toEqual(all);
    expect(getSourceIdsForRelationship('ChatGPT', 'Google Gemini', 'competes_with').sort()).toEqual(all);
  });
});

describe('description backfill after an older rename', () => {
  it('fills the re-sorted rows from llm_output', () => {
    handle = setupTestDb();
    const s1 = seedSource(handle.db, { source_id: 's1', onboarding_session_id: 'sess' });
    // Two renamed rows of one type, so the leftover pairing cannot rescue them.
    handle.db
      .prepare(`INSERT INTO extractions (source_id, ner_output, profile, llm_output) VALUES (?, '{}', 'default', ?)`)
      .run(
        s1,
        JSON.stringify({
          relationships: [
            { from_entity: 'Bard', to: 'ChatGPT', type: 'competes_with', description: 'Bard rivals ChatGPT.' },
            { from_entity: 'Bard', to: 'Copilot', type: 'competes_with', description: 'Bard rivals Copilot.' },
          ],
        })
      );
    // Rows from before v28, renamed (Bard -> Google Gemini) and re-sorted by an
    // older resolve: no sentence yet.
    insertRelationshipMentions([
      { from_canonical: 'ChatGPT', to_canonical: 'Google Gemini', relationship_type: 'competes_with', source_id: s1 },
      { from_canonical: 'Copilot', to_canonical: 'Google Gemini', relationship_type: 'competes_with', source_id: s1 },
    ]);
    bulkInsertAliases(BARD_IS_GEMINI);

    expect(backfillRelationDescriptions(handle.db)).toEqual({ filled: 2, unmatched: 0 });
    expect(rows().map((r) => [r.from, r.to, r.description])).toEqual([
      ['ChatGPT', 'Google Gemini', 'Bard rivals ChatGPT.'],
      ['Copilot', 'Google Gemini', 'Bard rivals Copilot.'],
    ]);
  });
});

describe('sortDirectionAgnosticRelations over every row (one-time repair, not wired)', () => {
  it('sorts unsorted rows in every source, keeps sentences, and a rerun changes nothing', () => {
    handle = setupTestDb();
    const a = seedSource(handle.db, { source_id: 'a', onboarding_session_id: 'one' });
    const b = seedSource(handle.db, { source_id: 'b', onboarding_session_id: 'two' });
    const insert = handle.db.prepare(
      `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id, description)
       VALUES (?, ?, ?, ?, ?)`
    );
    insert.run('Google Gemini', 'ChatGPT', 'competes_with', a, 'Unsorted sentence.');
    insert.run('Zeta', 'alpha', 'contradicts', b, null);
    insert.run('alpha', 'Zeta', 'contradicts', b, 'Sorted twin sentence.');
    insert.run('Zeta', 'Alpha', 'uses', b, 'Directional, untouched.');
    insert.run('same', 'SAME', 'competes_with', b, 'Equal names, untouched.');

    expect(sortDirectionAgnosticRelations(handle.db)).toBe(2);
    expect(rows()).toEqual([
      { from: 'ChatGPT', to: 'Google Gemini', type: 'competes_with', source_id: 'a', description: 'Unsorted sentence.' },
      { from: 'same', to: 'SAME', type: 'competes_with', source_id: 'b', description: 'Equal names, untouched.' },
      { from: 'alpha', to: 'Zeta', type: 'contradicts', source_id: 'b', description: 'Sorted twin sentence.' },
      { from: 'Zeta', to: 'Alpha', type: 'uses', source_id: 'b', description: 'Directional, untouched.' },
    ]);
    expect(sortDirectionAgnosticRelations(handle.db)).toBe(0);
  });

  it('limits itself to the given sources', () => {
    handle = setupTestDb();
    const a = seedSource(handle.db, { source_id: 'a' });
    const b = seedSource(handle.db, { source_id: 'b' });
    const insert = handle.db.prepare(
      `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id)
       VALUES ('Zeta', 'Alpha', 'competes_with', ?)`
    );
    insert.run(a);
    insert.run(b);

    expect(sortDirectionAgnosticRelations(handle.db, [a])).toBe(1);
    expect(rows().map((r) => [r.source_id, r.from, r.to])).toEqual([
      ['a', 'Alpha', 'Zeta'],
      ['b', 'Zeta', 'Alpha'],
    ]);
  });
});
