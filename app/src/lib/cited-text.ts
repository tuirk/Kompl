/**
 * Working with fragments of scanCitations() output, where each citation is a
 * placeholder pair around local source numbers: split it into sentences,
 * clip it, and turn its placeholders into "[n]" markers numbered in a list
 * shared across pages (MCP research_topic). Placeholders never appear in page
 * text, so none of this can mistake a literal "[1]" for a citation.
 */

import { CITATION_CLOSE, CITATION_OPEN } from './citations';

const MARKER = `${CITATION_OPEN}[\\d,]+${CITATION_CLOSE}`;
const MARKERS = new RegExp(MARKER, 'g');

/** End of a sentence: punctuation, the sentence's own citations, a space, then a new sentence. */
const BOUNDARY = new RegExp(`([.!?])((?:${MARKER})*)(\\s+)(?=[\\p{Lu}\\p{N}"“'(\\[*_])`, 'gu');
/** Words that end in a period without ending the sentence. */
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'cf', 'approx', 'ca', 'dr', 'mr', 'mrs', 'ms', 'st', 'no']);

export function hasCitationPlaceholder(text: string): boolean {
  return text.includes(CITATION_OPEN);
}

/**
 * Sentences of one line, each keeping the citations that follow its period
 * ("…energy.[1] Next…" → "…energy.[1]"). "U.S." and "e.g." don't end one.
 */
export function citedSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (const m of text.matchAll(BOUNDARY)) {
    const lastWord = text.slice(start, m.index).split(/\s/).pop() ?? '';
    if (/^(?:[A-Za-z]\.)*[A-Za-z]$/.test(lastWord) || ABBREVIATIONS.has(lastWord.toLowerCase())) continue;
    const end = m.index + m[1].length + m[2].length;
    out.push(text.slice(start, end).trim());
    start = end + m[3].length;
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

/**
 * Clip to `max` visible characters without cutting a citation: citations
 * from the clipped tail move after the "…" so the line still cites them.
 */
export function clipCited(text: string, max: number): string {
  if (text.replace(MARKERS, '').length <= max) return text;
  let visible = 0;
  let cut = text.length;
  for (let i = 0; i < text.length; ) {
    const marker = new RegExp(`^${MARKER}`).exec(text.slice(i));
    if (marker) {
      i += marker[0].length;
      continue;
    }
    if (visible === max - 1) {
      cut = i;
      break;
    }
    visible++;
    i++;
  }
  // Don't split a surrogate pair (an emoji).
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  const dropped = text.slice(cut).match(MARKERS) ?? [];
  return `${text.slice(0, cut).trimEnd()}…${dropped.join('')}`;
}

/**
 * Turn placeholders into "[n]" markers numbered in `sharedOrder`, a source
 * list shared across pages. `localOrder` is the fragment's CitationScan.order;
 * sources not yet shared are appended. Only text actually passed in gets
 * numbers, so sources cited elsewhere on a page don't enter the list.
 */
export function placeholdersToSharedText(text: string, localOrder: string[], sharedOrder: string[]): string {
  return text.replace(new RegExp(`${CITATION_OPEN}([\\d,]+)${CITATION_CLOSE}`, 'g'), (_m, nums: string) => {
    const shared = nums.split(',').map((n) => {
      const id = localOrder[Number(n) - 1];
      let i = sharedOrder.indexOf(id);
      if (i === -1) i = sharedOrder.push(id) - 1;
      return i + 1;
    });
    return [...new Set(shared)]
      .sort((a, b) => a - b)
      .map((n) => `[${n}]`)
      .join('');
  });
}

/** The words of a line, citations left out: two lines saying the same thing share a key. */
export function lineKey(text: string): string {
  return text
    .replace(MARKERS, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
