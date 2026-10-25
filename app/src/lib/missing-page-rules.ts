/**
 * Rules of a "missing page" (missing-pages.ts) that screens show or apply
 * without the database: pure, so client components can read them too.
 *
 * Names that count or order things ("second", "two", "21st", "1991") are not
 * topics a page could be about, whatever type the extraction gave them: the
 * same word is typed ORDINAL in one source and a concept in another. Shared
 * by the missing pages (missing-pages.ts) and by a saved health check result
 * (lint-result.ts), so an old result never lists one either.
 */

/** Sources a name needs before it counts as a missing page, on the map and in wiki_status alike. */
export const MISSING_PAGE_MIN_SOURCES = 3;

const NUMBER_WORDS: ReadonlySet<string> = new Set([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
  'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundred', 'thousand', 'million', 'billion', 'trillion', 'dozen', 'half', 'quarter',
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'twentieth', 'hundredth', 'thousandth', 'millionth', 'last',
]);

/** True when every word of the name is a number, a number word or an ordinal ("second", "2nd", "twenty one"). */
export function isNonTopicName(name: string): boolean {
  const words = name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return true;
  return words.every((w) => NUMBER_WORDS.has(w) || /^\d+(?:st|nd|rd|th|s)?$/.test(w));
}
