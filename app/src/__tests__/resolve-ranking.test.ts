/**
 * Ranking for Layer 3's capped budget (lib/resolve-ranking.ts), mirrored in
 * nlp-service. Pairs used to be ranked by name similarity alone: a list
 * article's same-source pairs pushed out pairs across sources and against
 * pages, and abbreviations ("ETH" / "Ethereum") were cut first (audit
 * 2026-10-23).
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAbbreviation, rankForLayer3 } from '../lib/resolve-ranking';

const CASES = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../nlp-service/tests/fixtures/abbreviation_cases.json'), 'utf-8'),
) as Array<{ short: string; long: string; abbreviation: boolean }>;

describe('isAbbreviation (shared with nlp-service _is_abbreviation)', () => {
  it.each(CASES)('$short / $long → $abbreviation', ({ short, long, abbreviation }) => {
    expect(isAbbreviation(short, long)).toBe(abbreviation);
  });
});

describe('rankForLayer3', () => {
  const pair = (a: string, b: string, name: number, sim = name, oneSource = false) =>
    ({ entity_a: { name: a }, entity_b: { name: b }, name_similarity: name, similarity: sim, oneSource });

  it('puts pairs across sources before pairs one source names, abbreviations first in each tier', () => {
    const pairs = [
      pair('Kaunas Castle', 'Kaunas Fortress', 0.88, 0.88, true),
      pair('Gas fee', 'Transaction fee', 0.75),
      pair('JS', 'JavaScript', 0.71, 0.71, true),
      pair('ETH', 'Ethereum', 0.62, 0.7),
      pair('Set collection', 'Route planning', 0.1, 0.98, true),
      pair('Web typography', 'Typography on the web', 0.9),
      pair('Dutch auction', 'Reverse auction', 0.85, 0.95, true),
      pair('Colour analyser', 'Color analyzer', 0.85, 0.85),
      pair('Colour analysers', 'Color analyzers', 0.85, 0.85),
    ];
    expect(rankForLayer3(pairs, (p) => p.oneSource).map((p) => p.entity_a.name)).toEqual([
      'ETH', 'Web typography', 'Colour analyser', 'Colour analysers', 'Gas fee',
      'JS', 'Kaunas Castle', 'Dutch auction', 'Set collection',
    ]);
  });

  it('ranks an acronym pair Layer 2 flags with the abbreviations, within its tier', () => {
    const pairs = [
      pair('Gas fee', 'Transaction fee', 0.75),
      { ...pair('LLMs', 'Large Language Model', 0.2, 0.2), abbreviation: true },
      { ...pair('PM', 'Project Manager', 0.3, 0.3, true), abbreviation: true },
      pair('Kaunas Castle', 'Kaunas Fortress', 0.88, 0.88, true),
    ];
    expect(rankForLayer3(pairs, (p) => p.oneSource).map((p) => p.entity_a.name)).toEqual([
      'LLMs', 'Gas fee', 'PM', 'Kaunas Castle',
    ]);
  });
});
