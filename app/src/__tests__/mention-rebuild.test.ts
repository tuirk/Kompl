/**
 * Mentions follow the resolver (plan item 1.5). After resolve, a session's
 * entity_mentions and relationship_mentions are rebuilt from the names in
 * each source's extraction, mapped through the resolver's groups. Before,
 * resolve only renamed rows by the aliases it had just written, so a merge
 * a later resolve undid (or an old alias had made at extract time) stayed
 * in the counts plan reads.
 *
 * Covers, through the resolve route:
 *   - a wrong old merge no longer survives once the resolver splits it
 *   - a merge renames rows, keeps relation sentences and first_seen_at, and
 *     keeps competes_with rows sorted (plan Rule 4 counts them sorted)
 *   - a rerun gives the same rows; a retried resolve that splits a merge
 *     takes it back out
 *   - other sessions' rows are left alone
 *   - a source extracted without mention rows (a crash between the two
 *     writes, before extract wrote them in one transaction: see
 *     source-mentions.test.ts) gets them
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as resolvePOST } from '../app/api/compile/resolve/route';
import { countSourcesForRelationship } from '../lib/db';
import { seedExtraction, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

interface Ent { name: string; type: string; source_id: string; context: string }
interface Group { canonical: string; type: string; aliases: string[]; source_ids: string[]; method: string }

const OLD = '2026-01-01 00:00:00';

function post(handler: (r: Request) => Promise<Response>, route: string, body: Record<string, unknown>): Promise<Response> {
  return handler(
    new Request(`http://test${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  );
}

/** A session source with this extraction; its mention rows are the given ones (or none), dated OLD. */
function seedExtracted(
  source_id: string,
  session: string,
  llm_output: Record<string, unknown>,
  rows: { entities?: Array<[string, string]>; relations?: Array<[string, string, string, string | null]> } = {}
): string {
  const db = handle!.db;
  seedSource(db, { source_id, onboarding_session_id: session, compile_status: 'extracted' });
  seedExtraction(db, { source_id, llm_output });
  db.prepare('DELETE FROM entity_mentions WHERE source_id = ?').run(source_id);
  db.prepare('DELETE FROM relationship_mentions WHERE source_id = ?').run(source_id);
  for (const [name, type] of rows.entities ?? []) {
    db.prepare('INSERT INTO entity_mentions (canonical_name, source_id, entity_type, first_seen_at) VALUES (?, ?, ?, ?)')
      .run(name, source_id, type, OLD);
  }
  for (const [from, type, to, description] of rows.relations ?? []) {
    db.prepare(
      `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id, first_seen_at, description)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(from, to, type, source_id, OLD, description);
  }
  return source_id;
}

/** Runs resolve with these groups; every other name comes back on its own. */
async function resolve(session_id: string, groups: Group[] = []): Promise<void> {
  const inGroup = (e: Ent) =>
    groups.some((g) => g.type === e.type && g.source_ids.includes(e.source_id) && [g.canonical, ...g.aliases].includes(e.name));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { entities: Ent[]; groups?: Array<Group & { context: string }> };
    if (url.endsWith('/resolve/fuzzy')) return Response.json({ resolved: groups, unresolved: body.entities.filter((e) => !inGroup(e)) });
    if (url.endsWith('/resolve/embedding')) {
      const resolved = (body.groups ?? []).map(({ context: _context, ...g }) => g);
      return Response.json({ resolved, ambiguous: [], unresolved: body.entities, rerouted: 0 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
  const res = await post(resolvePOST, '/api/compile/resolve', { session_id });
  expect(res.status).toBe(200);
  vi.unstubAllGlobals();
}

function entityRows(source_id: string): string[] {
  return (
    handle!.db
      .prepare('SELECT canonical_name, entity_type, first_seen_at FROM entity_mentions WHERE source_id = ? ORDER BY canonical_name')
      .all(source_id) as Array<{ canonical_name: string; entity_type: string | null; first_seen_at: string }>
  ).map((r) => `${r.canonical_name} (${r.entity_type}) @${r.first_seen_at}`);
}

function relationRows(source_id: string): string[] {
  return (
    handle!.db
      .prepare(
        `SELECT from_canonical, relationship_type, to_canonical, description, first_seen_at
           FROM relationship_mentions WHERE source_id = ? ORDER BY from_canonical, to_canonical`
      )
      .all(source_id) as Array<{ from_canonical: string; relationship_type: string; to_canonical: string; description: string | null; first_seen_at: string }>
  ).map((r) => `${r.from_canonical} ${r.relationship_type} ${r.to_canonical} (${r.description}) @${r.first_seen_at}`);
}

const ETHEREUM_SOURCE = {
  entities: [{ name: 'Ethereum', type: 'PRODUCT' }, { name: 'Ethereum Foundation', type: 'ORG' }, { name: 'Solidity', type: 'PRODUCT' }],
  concepts: [],
  relationships: [{ from_entity: 'Ethereum', to: 'Solidity', type: 'uses', description: 'Ethereum runs Solidity contracts.' }],
};

const BARD_SOURCE = {
  entities: [{ name: 'Bard', type: 'PRODUCT' }, { name: 'ChatGPT', type: 'PRODUCT' }],
  concepts: [],
  relationships: [{ from_entity: 'Bard', to: 'ChatGPT', type: 'Competes with', description: 'Bard rivals ChatGPT.' }],
};

const GEMINI_SOURCE = {
  entities: [{ name: 'Google Gemini', type: 'PRODUCT' }, { name: 'ChatGPT', type: 'PRODUCT' }],
  concepts: [],
  relationships: [{ from_entity: 'Google Gemini', to: 'ChatGPT', type: 'competes_with', description: 'Gemini rivals ChatGPT.' }],
};

const BARD_IS_GEMINI = (source_ids: string[]): Group => ({
  canonical: 'Google Gemini', type: 'PRODUCT', aliases: ['Bard'], source_ids, method: 'embedding',
});

describe('resolve rebuilds the session mention rows from the extractions', () => {
  it('a wrong old merge does not survive once the resolver splits it', async () => {
    handle = setupTestDb();
    // Extract once pinned "Ethereum" to "Ethereum Foundation" through an alias since suspended.
    const s1 = seedExtracted('s1', 'sess', ETHEREUM_SOURCE, {
      entities: [['Ethereum Foundation', 'ORG'], ['Solidity', 'PRODUCT']],
      relations: [['Ethereum Foundation', 'uses', 'Solidity', 'Ethereum runs Solidity contracts.']],
    });

    await resolve('sess'); // the resolver keeps the two apart

    expect(entityRows(s1)).toEqual([
      `Ethereum (PRODUCT) @${OLD}`,
      `Ethereum Foundation (ORG) @${OLD}`,
      `Solidity (PRODUCT) @${OLD}`,
    ]);
    expect(relationRows(s1)).toEqual([`Ethereum uses Solidity (Ethereum runs Solidity contracts.) @${OLD}`]);
  });

  it('follows a merge, keeps sentences and first_seen_at, and keeps competes_with rows sorted', async () => {
    handle = setupTestDb();
    const s1 = seedExtracted('s1', 'sess', BARD_SOURCE, {
      entities: [['Bard', 'PRODUCT'], ['ChatGPT', 'PRODUCT']],
      relations: [['Bard', 'competes_with', 'ChatGPT', 'Bard rivals ChatGPT.']],
    });
    const s2 = seedExtracted('s2', 'sess', GEMINI_SOURCE, {
      entities: [['Google Gemini', 'PRODUCT'], ['ChatGPT', 'PRODUCT']],
      relations: [['ChatGPT', 'competes_with', 'Google Gemini', 'Gemini rivals ChatGPT.']],
    });

    await resolve('sess', [BARD_IS_GEMINI([s1, s2])]);

    expect(entityRows(s1)).toEqual([`ChatGPT (PRODUCT) @${OLD}`, `Google Gemini (PRODUCT) @${OLD}`]);
    expect(relationRows(s1)).toEqual([`ChatGPT competes_with Google Gemini (Bard rivals ChatGPT.) @${OLD}`]);
    expect(countSourcesForRelationship('ChatGPT', 'Google Gemini', 'competes_with')).toBe(2);
  });

  it('gives the same rows on a rerun, and a retried resolve that splits the merge takes it back out', async () => {
    handle = setupTestDb();
    const s1 = seedExtracted('s1', 'sess', BARD_SOURCE, {
      entities: [['Bard', 'PRODUCT'], ['ChatGPT', 'PRODUCT']],
      relations: [['Bard', 'competes_with', 'ChatGPT', 'Bard rivals ChatGPT.']],
    });
    const s2 = seedExtracted('s2', 'sess', GEMINI_SOURCE);
    const snapshot = () => [entityRows(s1), relationRows(s1), entityRows(s2), relationRows(s2)];

    await resolve('sess', [BARD_IS_GEMINI([s1, s2])]);
    const first = snapshot();
    await resolve('sess', [BARD_IS_GEMINI([s1, s2])]);
    expect(snapshot()).toEqual(first);

    await resolve('sess'); // the retry keeps Bard and Gemini apart
    expect(entityRows(s1)).toEqual([`Bard (PRODUCT) @${OLD}`, `ChatGPT (PRODUCT) @${OLD}`]);
    expect(relationRows(s1)).toEqual([`Bard competes_with ChatGPT (Bard rivals ChatGPT.) @${OLD}`]);
  });

  it("leaves other sessions' sources alone", async () => {
    handle = setupTestDb();
    const s1 = seedExtracted('s1', 'sess', BARD_SOURCE);
    // An older session's source: its rows predate this fix and stay as they are.
    const old = seedExtracted('old', 'earlier', BARD_SOURCE, {
      entities: [['Bard', 'PRODUCT']],
      relations: [['ChatGPT', 'competes_with', 'Bard', null]],
    });
    const before = [entityRows(old), relationRows(old)];

    await resolve('sess', [BARD_IS_GEMINI([s1, old])]);

    expect([entityRows(old), relationRows(old)]).toEqual(before);
  });

  it('gives a source extracted without mention rows its rows, dated by its extraction', async () => {
    handle = setupTestDb();
    const s1 = seedExtracted('s1', 'sess', ETHEREUM_SOURCE);
    handle.db.prepare("UPDATE extractions SET created_at = '2026-02-02 00:00:00' WHERE source_id = ?").run(s1);

    await resolve('sess');

    expect(entityRows(s1)).toEqual([
      'Ethereum (PRODUCT) @2026-02-02 00:00:00',
      'Ethereum Foundation (ORG) @2026-02-02 00:00:00',
      'Solidity (PRODUCT) @2026-02-02 00:00:00',
    ]);
    expect(relationRows(s1)).toEqual(['Ethereum uses Solidity (Ethereum runs Solidity contracts.) @2026-02-02 00:00:00']);
  });
});
