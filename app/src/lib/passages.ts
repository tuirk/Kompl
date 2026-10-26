/**
 * Passages of a source's stored text, and BM25 ranking of them against a
 * query, so an agent can quote the part of a long source that supports a
 * claim without reading all of it. Plain code: no NLP service, no LLM.
 */

import { topicTerms } from './fts-query';

export interface Passage {
  text: string;
  /** Nearest heading above the passage, if any. */
  heading: string | null;
  /** Character offset of the passage's first character in the source text. */
  start: number;
}

export interface RankedPassage extends Passage {
  score: number;
}

/** Paragraphs are merged until a passage reaches about this size… */
const TARGET_CHARS = 1_000;
/** …and never grow past this; longer paragraphs are cut at a space. */
const MAX_CHARS = 1_500;
/** Separator between merged paragraphs. */
const JOIN = '\n\n';
/** More query words than this add nothing but work. */
const MAX_QUERY_TERMS = 32;
/** BM25 parameters (the usual defaults). */
const K1 = 1.2;
const B = 0.75;

const HEADING_LINE = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const FENCE_LINE = /^\s*(```|~~~)/;

/** Split markdown into passages of about TARGET_CHARS, following paragraph breaks. */
export function splitPassages(markdown: string): Passage[] {
  const passages: Passage[] = [];
  let heading: string | null = null;
  let parts: string[] = [];
  let partsStart = 0;
  let partsLength = 0;
  // A "# comment" line inside a code block is not a heading.
  let inFence = false;

  const flush = () => {
    if (parts.length) passages.push({ text: parts.join(JOIN), heading, start: partsStart });
    parts = [];
    partsLength = 0;
  };
  const add = (text: string, start: number) => {
    if (parts.length && partsLength + JOIN.length + text.length > MAX_CHARS) flush();
    if (!parts.length) partsStart = start;
    partsLength += (parts.length ? JOIN.length : 0) + text.length;
    parts.push(text);
    if (partsLength >= TARGET_CHARS) flush();
  };

  for (const { text, start } of paragraphs(markdown)) {
    const lines = text.split('\n');
    const headingMatch = inFence ? null : HEADING_LINE.exec(lines[0]);
    for (const line of lines) if (FENCE_LINE.test(line)) inFence = !inFence;
    if (headingMatch) {
      flush();
      heading = headingMatch[1];
      if (lines.length > 1) addLong(lines.slice(1).join('\n'), start + lines[0].length + 1, add);
      continue;
    }
    addLong(text, start, add);
  }
  flush();
  return passages;
}

/** Rank passages against a query with BM25; returns the best `k` that match at all. */
export function rankPassages(query: string, passages: Passage[], k: number): RankedPassage[] {
  const terms = [...new Set(topicTerms(query).map((t) => t.toLowerCase()))].slice(0, MAX_QUERY_TERMS);
  if (!terms.length || !passages.length) return [];

  // Headings count as part of their passage: "## Mining" makes a passage about mining.
  const docs = passages.map((p) => words(p.heading ? `${p.heading} ${p.text}` : p.text));
  const avgLength = docs.reduce((sum, d) => sum + d.length, 0) / docs.length;
  // Prefix match, like the FTS search: "mine" finds "miners".
  const counts = docs.map((doc) => terms.map((t) => doc.filter((w) => w.startsWith(t)).length));
  const idf = terms.map((_, i) => {
    const df = counts.filter((c) => c[i] > 0).length;
    return Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
  });

  return passages
    .map((passage, d) => {
      const lengthNorm = 1 - B + (B * docs[d].length) / (avgLength || 1);
      const score = counts[d].reduce((sum, tf, i) => sum + (idf[i] * tf * (K1 + 1)) / (tf + K1 * lengthNorm), 0);
      return { ...passage, score };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .slice(0, k);
}

/**
 * Index just before which text can be cut without splitting a UTF-16
 * surrogate pair (an emoji or other character outside the BMP).
 */
export function safeCut(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const code = text.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}

/** Non-blank runs of lines, trimmed, with the offset of their first character. */
function paragraphs(markdown: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  const re = /[^\n]*\S[^\n]*(?:\n[^\n]*\S[^\n]*)*/g;
  for (const m of markdown.matchAll(re)) {
    out.push({ text: m[0].trim(), start: m.index + leadingSpace(m[0]) });
  }
  return out;
}

/** Add a paragraph, cutting one longer than MAX_CHARS at spaces. */
function addLong(text: string, start: number, add: (text: string, start: number) => void): void {
  let offset = 0;
  while (text.length - offset > MAX_CHARS) {
    const window = text.slice(offset, offset + MAX_CHARS);
    const space = window.lastIndexOf(' ');
    const cut = space > MAX_CHARS / 2 ? space : safeCut(text, offset + MAX_CHARS) - offset;
    const piece = text.slice(offset, offset + cut);
    if (piece.trim()) add(piece.trim(), start + offset + leadingSpace(piece));
    offset += cut;
  }
  const tail = text.slice(offset);
  if (tail.trim()) add(tail.trim(), start + offset + leadingSpace(tail));
}

function leadingSpace(text: string): number {
  return text.length - text.trimStart().length;
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
}
