/**
 * Name guard (lib/name-guard.ts) and the alias filter built on it.
 *
 * The 2026-10-09 e2e wiki stored "Python 3" → "Python 2" and "Python" →
 * "Python 2": resolution merged versions. getAliases() now leaves such rows
 * out so new sources stop going to the wrong page; the rows are kept.
 * The vectors are shared with nlp-service (tests/fixtures/name_guard_cases.json).
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { isTokenExtension, numericConflict } from '../lib/name-guard';
import { bulkInsertAliases, getAliases, getAllAliases } from '../lib/db';
import { injectWikilinks } from '../lib/wikilink-injector';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

interface GuardCase {
  a: string;
  b: string;
  conflict: 'hard' | 'soft' | null;
  extension: boolean;
}

const CASES = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../nlp-service/tests/fixtures/name_guard_cases.json'), 'utf-8'),
) as GuardCase[];

describe('name guard parity with nlp-service', () => {
  it.each(CASES.map((c) => [`${c.a} | ${c.b}`, c] as const))('%s', (_label, c) => {
    expect(numericConflict(c.a, c.b)).toBe(c.conflict);
    expect(numericConflict(c.b, c.a)).toBe(c.conflict);
    expect(isTokenExtension(c.a, c.b)).toBe(c.extension);
  });
});

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function insertAlias(alias: string, canonical: string): void {
  handle!.db.prepare('INSERT INTO aliases (alias, canonical_name) VALUES (?, ?)').run(alias, canonical);
}

describe('stored aliases', () => {
  it('getAliases leaves out version merges but keeps every row in the table', () => {
    handle = setupTestDb();
    insertAlias('Python', 'Python 2');
    insertAlias('Python 3', 'Python 2');
    insertAlias('Stage 17', 'Stage 16');
    insertAlias('Ethereum', 'Ethereum Foundation');
    insertAlias('Satoshi', 'Satoshi Nakamoto');
    insertAlias('GPT 4', 'GPT-4');

    expect(getAliases().map((r) => r.alias)).toEqual(['Ethereum', 'Satoshi', 'GPT 4']);
    expect(getAllAliases()).toHaveLength(6);
  });

  it('bulkInsertAliases dedupes on the alias-canonical pair', () => {
    handle = setupTestDb();
    insertAlias('Python', 'Python 2');
    bulkInsertAliases([
      { alias: 'python', canonical: 'python 2' }, // same pair, different case: skipped
      { alias: 'Python', canonical: 'Python (programming language)' }, // new mapping: added
      { alias: 'Satoshi', canonical: 'Satoshi Nakamoto' },
      { alias: 'Satoshi', canonical: 'Satoshi Nakamoto' },
    ]);
    const rows = getAllAliases().map((r) => `${r.alias} → ${r.canonical_name}`);
    expect(rows).toEqual([
      'Python → Python 2',
      'Python → Python (programming language)',
      'Satoshi → Satoshi Nakamoto',
    ]);
    // The old version merge is still ignored; the new mapping is used.
    expect(getAliases().map((r) => r.canonical_name)).toEqual(['Python (programming language)', 'Satoshi Nakamoto']);
  });
});

describe('wikilink injector', () => {
  it('never lets an alias shadow another page title', () => {
    const out = injectWikilinks('Python is popular.', [
      { title: 'Python 2', aliases: ['Python'] },
      { title: 'Python', aliases: [] },
    ]);
    expect(out.markdown).toBe('[[Python]] is popular.');
  });
});
