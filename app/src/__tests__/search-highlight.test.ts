/**
 * Search result highlighting (lib/search-highlight.ts): topic words of the
 * query are marked at word starts, without case; common words never are.
 */

import { describe, expect, it } from 'vitest';
import { highlightParts } from '../lib/search-highlight';

const marked = (text: string, query: string) =>
  highlightParts(text, query)
    .filter((p) => p.match)
    .map((p) => p.text);

describe('highlightParts', () => {
  it('marks topic words at word starts, ignoring case', () => {
    expect(marked('Vilnius is the capital of Lithuania.', 'vilnius')).toEqual(['Vilnius']);
    expect(marked('Cryptocurrency and crypto wallets', 'cryp')).toEqual(['Cryp', 'cryp']);
  });

  it('never marks common words or the middle of a word', () => {
    expect(marked('Who created bitcoin? Whoever it was.', 'who created bitcoin')).toEqual(['created', 'bitcoin']);
    expect(marked('Unbitcoin', 'bitcoin')).toEqual([]);
  });

  it('keeps the whole text in order, and treats query symbols as plain text', () => {
    const parts = highlightParts('C++ (and SHA-256) here', 'sha 256 (and');
    expect(parts.map((p) => p.text).join('')).toBe('C++ (and SHA-256) here');
    expect(parts.filter((p) => p.match).map((p) => p.text)).toEqual(['SHA', '256']);
  });

  it('returns the text unmarked when the query has no topic words', () => {
    expect(highlightParts('What is it', 'what is it')).toEqual([{ text: 'What is it', match: false }]);
    expect(highlightParts('', 'bitcoin')).toEqual([]);
  });
});
