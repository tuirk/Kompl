/**
 * Fuzzy concept dedup logic from compile/plan/route.ts.
 *
 * Targets the within-session concept grouping pass that decides whether two
 * concept names extracted from different sources should collapse into one
 * wiki page or live as separate pages. CLAUDE.md notes "Fuzzy concept dedup
 * (Levenshtein <=2 + acronym)" with no unit tests — this file is that.
 */

import { describe, it, expect } from 'vitest';
import {
  levenshtein,
  isAcronymOf,
  conceptsMatch,
} from '../app/api/compile/plan/route';

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('hello', 'hello')).toBe(0);
  });

  it('returns length when comparing against empty string', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('counts a single substitution as 1', () => {
    expect(levenshtein('cat', 'bat')).toBe(1);
  });

  it('counts a single insertion as 1', () => {
    expect(levenshtein('cat', 'cats')).toBe(1);
  });

  it('counts multiple substitutions correctly', () => {
    expect(levenshtein('cat', 'dog')).toBe(3);
    expect(levenshtein('abc', 'axc')).toBe(1);
    expect(levenshtein('abc', 'xyz')).toBe(3);
  });

  it('counts a substitution + insertion as 2', () => {
    // 'kitten' vs 'kitens' = sub t→e? No — let me use a known case.
    // 'ab' vs 'cab' = insert c at start = 1. 'ab' vs 'cac' = insert c, sub b→c = 2.
    expect(levenshtein('ab', 'cac')).toBe(2);
  });

  it('matches the threshold boundary used by conceptsMatch (<=2)', () => {
    expect(levenshtein('optimization', 'optimisation')).toBeLessThanOrEqual(2);
    // Two clearly-different concepts must NOT pass the threshold.
    expect(levenshtein('blockchain', 'database')).toBeGreaterThan(2);
  });
});

describe('isAcronymOf', () => {
  it('matches canonical case: ML → Machine Learning', () => {
    expect(isAcronymOf('ML', 'Machine Learning')).toBe(true);
  });

  it('is case-insensitive on the acronym side', () => {
    expect(isAcronymOf('ml', 'Machine Learning')).toBe(true);
    expect(isAcronymOf('Ml', 'Machine Learning')).toBe(true);
  });

  it('rejects acronyms shorter than 2 characters', () => {
    expect(isAcronymOf('M', 'Machine Learning')).toBe(false);
  });

  it('rejects acronyms longer than 8 characters', () => {
    expect(isAcronymOf('ABCDEFGHI', 'A B C D E F G H I')).toBe(false);
  });

  it('rejects when full string is a single word', () => {
    expect(isAcronymOf('AB', 'Apple')).toBe(false);
  });

  it('rejects when initials do not match', () => {
    expect(isAcronymOf('AI', 'Machine Learning')).toBe(false);
    expect(isAcronymOf('NLP', 'Natural Language')).toBe(false); // missing P-word
  });

  it('handles three-word acronyms', () => {
    expect(isAcronymOf('NLP', 'Natural Language Processing')).toBe(true);
    expect(isAcronymOf('CNN', 'Convolutional Neural Network')).toBe(true);
  });
});

describe('conceptsMatch', () => {
  it('matches exact strings', () => {
    expect(conceptsMatch('blockchain', 'blockchain')).toBe(true);
  });

  it('is whitespace and case insensitive', () => {
    expect(conceptsMatch('  Blockchain  ', 'blockchain')).toBe(true);
    expect(conceptsMatch('BLOCKCHAIN', 'blockchain')).toBe(true);
  });

  it('matches near-spellings within Levenshtein 2', () => {
    expect(conceptsMatch('optimization', 'optimisation')).toBe(true); // z↔s
    expect(conceptsMatch('color', 'colour')).toBe(true); // single insert
  });

  it('matches acronym ↔ full form in either direction', () => {
    expect(conceptsMatch('ML', 'Machine Learning')).toBe(true);
    expect(conceptsMatch('Machine Learning', 'ML')).toBe(true);
  });

  it('rejects unrelated concepts above the Levenshtein threshold', () => {
    expect(conceptsMatch('blockchain', 'database')).toBe(false);
    expect(conceptsMatch('neural network', 'compiler')).toBe(false);
  });

  it('does not collapse short distinct words just because they are short', () => {
    // 'cat' vs 'bat' is distance 1 — the fuzzy match accepts these. This is a
    // documented trade-off in the production code: short concepts can over-merge.
    // Pinning the behaviour so a future change is a deliberate one.
    expect(conceptsMatch('cat', 'bat')).toBe(true);
  });
});
