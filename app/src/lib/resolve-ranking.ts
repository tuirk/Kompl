/**
 * Which ambiguous pairs get Layer 3's capped LLM budget. Mirrors
 * _layer3_rank and _is_abbreviation in nlp-service/routers/resolution.py;
 * nlp-service/tests/fixtures/abbreviation_cases.json keeps the abbreviation
 * check equal on both sides (resolve-ranking.test.ts and
 * tests/test_resolution_layer3.py read it).
 */

// Must match nlp-service/routers/resolution.py DISAMBIGUATE_MAX_PAIRS.
// Hard bound on Layer-3 LLM pairs per resolve (CLAUDE.md rule #7); overflow
// pairs are kept as separate singletons instead of being sent to the LLM.
export const MAX_DISAMBIGUATE_PAIRS = 120;

export interface RankedPair {
  entity_a: { name: string };
  entity_b: { name: string };
  similarity: number;
  name_similarity: number;
}

const LETTER = /\p{L}/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

function isUpper(s: string): boolean {
  return s === s.toUpperCase() && s !== s.toLowerCase();
}

/**
 * `short` reads as the abbreviation of `long`: one word in capitals whose
 * letters appear in `long` in order, the first one starting it ("WCAG" /
 * "Web Content Accessibility Guidelines", "ETH" / "Ethereum").
 */
export function isAbbreviation(short: string, long: string): boolean {
  const letters = [...short.toLowerCase()].filter((c) => LETTER.test(c));
  const text = long.toLowerCase();
  const first = [...text].find((c) => LETTER_OR_DIGIT.test(c)) ?? '';
  if (letters.length < 2 || !isUpper(short) || /\s/u.test(short) || letters[0] !== first) return false;
  let pos = 0;
  for (const c of letters) {
    pos = text.indexOf(c, pos) + 1;
    if (pos === 0) return false;
  }
  return true;
}

/**
 * Orders pairs for the capped budget, best first. Tiers: a pair against the
 * wiki (a page, or a group bound to one) or across sources before a pair
 * whose two sides one source names — a list article gives many of those,
 * usually different things. Within a tier an abbreviation and its long form
 * first, since their names score low ("ETH" / "Ethereum"); then name
 * similarity, so a pair alike only in context never buys a slot; then
 * similarity. Stable: equal pairs keep their order.
 */
export function rankForLayer3<P extends RankedPair>(pairs: P[], oneSource: (pair: P) => boolean): P[] {
  return pairs
    .map((p, i) => ({
      p,
      i,
      tier: oneSource(p) ? 1 : 0,
      abbreviation: isAbbreviation(p.entity_a.name, p.entity_b.name) || isAbbreviation(p.entity_b.name, p.entity_a.name),
    }))
    .sort((x, y) =>
      x.tier - y.tier ||
      Number(y.abbreviation) - Number(x.abbreviation) ||
      y.p.name_similarity - x.p.name_similarity ||
      y.p.similarity - x.p.similarity ||
      x.i - y.i)
    .map((e) => e.p);
}
