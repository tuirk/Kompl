/**
 * Marks the words of a search result that match the query, the way keyword
 * search found them: topic words only (lib/fts-query.ts drops common words),
 * matched at the start of a word without case ("cryp" marks the start of
 * "Cryptocurrency"). A page found by meaning alone has no marked words.
 */

import { topicTerms } from './fts-query';

export interface HighlightPart {
  text: string;
  match: boolean;
}

export function highlightParts(text: string, query: string): HighlightPart[] {
  const terms = [...new Set(topicTerms(query).map((t) => t.toLowerCase()))]
    // Longest first, so "bitcoins" wins over "bitcoin" at the same place.
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (terms.length === 0 || text === '') return text === '' ? [] : [{ text, match: false }];

  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${terms.join('|')})`, 'giu');
  const parts: HighlightPart[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start), match: false });
    parts.push({ text: m[0], match: true });
    last = start + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false });
  return parts;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
