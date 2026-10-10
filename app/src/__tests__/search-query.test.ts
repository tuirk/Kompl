/**
 * Search query tokenization (lib/fts-query.ts) and its effect on
 * searchPages(), which backs /api/pages/search and the MCP search_wiki tool.
 * Regression: hyphenated and possessive terms ("sha-256", "proof-of-work",
 * "bitcoin's") used to return nothing.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { buildFtsQuery, buildFtsQueryAll, buildFtsQueryAny } from '../lib/fts-query';
import { searchPages } from '../lib/db';
import { setupTestDb, seedPage, type TestDbHandle } from './helpers/test-db';

describe('buildFtsQuery', () => {
  it.each([
    ['sha-256', '"sha"* "256"*'],
    ['proof-of-work', '"proof"* "of"* "work"*'],
    ["bitcoin's", '"bitcoin"*'],
    ['AT&T', '"AT"*'],
    ['rock AND roll', '"rock"* "AND"* "roll"*'],
    ['cryp', '"cryp"*'],
    ['Zürich café', '"Zürich"* "café"*'],
    ['c', '"c"*'],
  ])('%s → %s', (input, expected) => {
    expect(buildFtsQuery(input)).toBe(expected);
  });

  it('returns null when nothing is searchable', () => {
    expect(buildFtsQuery('  -- ** ')).toBeNull();
    expect(buildFtsQuery('')).toBeNull();
  });
});

describe('buildFtsQueryAny', () => {
  it.each([
    ['who created bitcoin', '"created"* OR "bitcoin"*'],
    ['How do networks agree on history?', '"networks"* OR "agree"* OR "history"*'],
    ['sha-256', '"sha"* OR "256"*'],
    ['rock AND roll', '"rock"* OR "roll"*'],
  ])('%s → %s', (input, expected) => {
    expect(buildFtsQueryAny(input)).toBe(expected);
  });

  it('returns null when only common words are left', () => {
    expect(buildFtsQueryAny('what is it')).toBeNull();
    expect(buildFtsQueryAny('')).toBeNull();
  });
});

describe('buildFtsQueryAll', () => {
  it.each([
    ['who created bitcoin', '"created"* "bitcoin"*'],
    ['What is the Merge?', '"Merge"*'],
    ['proof-of-work', '"proof"* "work"*'],
  ])('%s → %s', (input, expected) => {
    expect(buildFtsQueryAll(input)).toBe(expected);
  });

  it('returns null when only common words are left', () => {
    expect(buildFtsQueryAll('what is it')).toBeNull();
  });
});

describe('searchPages', () => {
  let handle: TestDbHandle | null = null;
  afterEach(() => {
    handle?.cleanup();
    handle = null;
  });

  function seed(title: string, content: string): string {
    const id = seedPage(handle!.db, { title });
    handle!.db.prepare('INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)').run(id, title, content);
    return id;
  }

  it('finds hyphenated and possessive terms', () => {
    handle = setupTestDb();
    const sha = seed('SHA-256', 'A cryptographic hash function used by Bitcoin.');
    const pow = seed('Proof-of-Work Consensus', "Bitcoin's consensus mechanism.");

    expect(searchPages('sha-256').map((p) => p.page_id)).toEqual([sha]);
    expect(searchPages('proof-of-work').map((p) => p.page_id)).toEqual([pow]);
    expect(searchPages("bitcoin's").map((p) => p.page_id).sort()).toEqual([sha, pow].sort());
  });

  it('does not throw on FTS5 operator words or stray syntax', () => {
    handle = setupTestDb();
    seed('Rock and Roll', 'Music.');
    expect(() => searchPages('rock AND (roll')).not.toThrow();
    expect(searchPages('NEAR')).toEqual([]);
  });
});
