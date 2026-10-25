/**
 * Alias records, schema v29 (plan 1.7): how each alias was made and whether
 * compiles may use it.
 *
 * A stored alias binds every later source to its canonical page and is
 * never judged again, so a wrong one ("Ethereum" -> "Ethereum Foundation")
 * keeps sending sources to the wrong page. v29 lets such rows be set aside
 * without deleting them:
 *   - getAliases() returns active rows only (a NULL status counts as active)
 *   - bulkInsertAliases records method, score and session; a new match
 *     re-activates a suspended pair, never a retired one
 *   - getAllAliases() (backups) carries every column
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bulkInsertAliases, getAliases, getAllAliases } from '../lib/db';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function insertAlias(alias: string, canonical: string, status: string | null = 'active', method: string | null = null): number {
  return Number(
    handle!.db
      .prepare('INSERT INTO aliases (alias, canonical_name, status, method) VALUES (?, ?, ?, ?)')
      .run(alias, canonical, status, method).lastInsertRowid
  );
}

interface Row {
  alias: string;
  canonical_name: string;
  method: string | null;
  score: number | null;
  session_id: string | null;
  status: string | null;
  status_reason: string | null;
  status_at: string | null;
}

function rows(): Row[] {
  return handle!.db
    .prepare(
      'SELECT alias, canonical_name, method, score, session_id, status, status_reason, status_at FROM aliases ORDER BY id'
    )
    .all() as Row[];
}

describe('schema v29', () => {
  it('aliases has nullable method, score, session_id and status columns; status defaults to active', () => {
    handle = setupTestDb();
    const cols = handle.db.prepare('PRAGMA table_info(aliases)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    for (const name of ['method', 'score', 'session_id', 'status', 'status_reason', 'status_at']) {
      expect(byName.get(name)?.notnull, name).toBe(0);
    }
    expect(byName.get('status')?.dflt_value).toBe("'active'");
    // An older image inserts without the new columns: the row is active.
    handle.db.prepare('INSERT INTO aliases (alias, canonical_name) VALUES (?, ?)').run('GPT 4', 'GPT-4');
    expect(rows()[0].status).toBe('active');
  });

  it('migrate.py adds the columns behind a PRAGMA guard at the version schema.sql is seeded with', () => {
    const migrate = readFileSync(join(__dirname, '../../../scripts/migrate.py'), 'utf8');
    const schema = readFileSync(join(__dirname, 'helpers/schema.sql'), 'utf8');
    const version = /^SCHEMA_VERSION = (\d+)/m.exec(migrate)?.[1];
    expect(Number(version)).toBeGreaterThanOrEqual(29);
    expect(schema).toContain(`VALUES ('schema_version', '${version}')`);
    expect(migrate).toContain('if current < 29:');
    expect(migrate).toContain('PRAGMA table_info(aliases)');
    expect(migrate).toContain(`"status TEXT DEFAULT 'active'"`);
  });
});

describe('getAliases', () => {
  it('returns active rows only; NULL status counts as active; numbers still guard', () => {
    handle = setupTestDb();
    insertAlias('GPT 4', 'GPT-4');
    insertAlias('Ethereum', 'Ethereum Foundation', 'suspended');
    insertAlias('English', 'programming language', 'retired');
    insertAlias('ETH', 'Ethereum', null);
    insertAlias('Python 3', 'Python 2');

    expect(getAliases()).toEqual([
      { alias: 'GPT 4', canonical_name: 'GPT-4' },
      { alias: 'ETH', canonical_name: 'Ethereum' },
    ]);
    // Never deleted: backups still see every row.
    expect(getAllAliases()).toHaveLength(5);
  });
});

describe('bulkInsertAliases', () => {
  it('records method, score and session on new rows', () => {
    handle = setupTestDb();
    bulkInsertAliases([
      { alias: 'GPT 4', canonical: 'GPT-4', method: 'skeleton', session_id: 'sess-1' },
      { alias: 'Bitcoin network', canonical: 'Bitcoin', method: 'embedding', score: 0.93, session_id: 'sess-1' },
      { alias: 'BTC', canonical: 'Bitcoin' },
    ]);
    expect(rows().map((r) => [r.alias, r.method, r.score, r.session_id, r.status])).toEqual([
      ['GPT 4', 'skeleton', null, 'sess-1', 'active'],
      ['Bitcoin network', 'embedding', 0.93, 'sess-1', 'active'],
      ['BTC', null, null, null, 'active'],
    ]);
  });

  it('re-activates a suspended pair on a new match and records the new match', () => {
    handle = setupTestDb();
    insertAlias('Ethereum', 'Ethereum Foundation', 'suspended');
    bulkInsertAliases([{ alias: 'ethereum', canonical: 'ethereum foundation', method: 'llm', session_id: 'sess-2' }]);

    const all = rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'active', status_reason: 'rematched', method: 'llm', session_id: 'sess-2' });
    expect(all[0].status_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(getAliases()).toEqual([{ alias: 'Ethereum', canonical_name: 'Ethereum Foundation' }]);
  });

  it('never re-activates or re-adds a retired pair', () => {
    handle = setupTestDb();
    insertAlias('English', 'programming language', 'retired');
    // A pair with both a retired and a suspended row stays out as well.
    insertAlias('Paul Allen', 'Paul Graham', 'retired');
    insertAlias('Paul Allen', 'Paul Graham', 'suspended');
    bulkInsertAliases([
      { alias: 'English', canonical: 'programming language', method: 'embedding' },
      { alias: 'Paul Allen', canonical: 'Paul Graham', method: 'llm' },
    ]);
    expect(rows().map((r) => [r.alias, r.status, r.method])).toEqual([
      ['English', 'retired', null],
      ['Paul Allen', 'retired', null],
      ['Paul Allen', 'suspended', null],
    ]);
    expect(getAliases()).toEqual([]);
  });

  it('leaves an active pair as it is', () => {
    handle = setupTestDb();
    insertAlias('GPT 4', 'GPT-4', 'active', 'skeleton');
    bulkInsertAliases([{ alias: 'GPT 4', canonical: 'GPT-4', method: 'existing_alias', session_id: 's' }]);
    expect(rows().map((r) => [r.alias, r.method, r.session_id])).toEqual([['GPT 4', 'skeleton', null]]);
  });
});

describe('getAllAliases', () => {
  it('carries the v29 columns, oldest first', () => {
    handle = setupTestDb();
    bulkInsertAliases([{ alias: 'GPT 4', canonical: 'GPT-4', method: 'skeleton', score: null, session_id: 's1' }]);
    insertAlias('Ethereum', 'Ethereum Foundation', 'suspended');
    expect(getAllAliases()).toEqual([
      expect.objectContaining({
        alias: 'GPT 4',
        canonical_name: 'GPT-4',
        canonical_page_id: null,
        method: 'skeleton',
        score: null,
        session_id: 's1',
        status: 'active',
        status_reason: null,
        status_at: null,
      }),
      expect.objectContaining({ alias: 'Ethereum', status: 'suspended' }),
    ]);
  });
});
