/**
 * lib/cited-text.ts — sentences, clipping and shared numbering on
 * scanCitations() output, as used by research_topic. Pins that a sentence
 * keeps its own citations, abbreviations don't end sentences, clipping never
 * loses or breaks a citation, and shared numbers are stable and sorted.
 */

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { scanCitations } from '../lib/citations';
import { citedSentences, clipCited, lineKey, placeholdersToSharedText } from '../lib/cited-text';

const [A, B, C] = [randomUUID(), randomUUID(), randomUUID()];

/** Scan, apply `fn` to the placeholder text, then show it with numbers. */
function scanned(markdown: string) {
  const scan = scanCitations(markdown);
  const show = (text: string, shared: string[] = []) => placeholdersToSharedText(text, scan.order, shared);
  return { text: scan.markdown, show };
}

describe('citedSentences', () => {
  it('keeps each sentence’s citations, also when they follow the period', () => {
    const { text, show } = scanned(`Mining uses energy [^${A}]. It grows. (${B}) Ethereum moved on.`);
    const shared: string[] = [];
    expect(citedSentences(text).map((s) => show(s, shared))).toEqual(['Mining uses energy[1].', 'It grows.[2]', 'Ethereum moved on.']);
  });

  it('starts a new sentence at a link or emphasis, but not after an abbreviation', () => {
    const { text, show } = scanned(
      `Trustless transfers [^${A}]. [[Ethereum]] added contracts [^${B}]. The U.S. Treasury agrees, e.g. on rules.`
    );
    const shared: string[] = [];
    expect(citedSentences(text).map((s) => show(s, shared))).toEqual([
      'Trustless transfers[1].',
      '[[Ethereum]] added contracts[2].',
      'The U.S. Treasury agrees, e.g. on rules.',
    ]);
  });
});

describe('clipCited', () => {
  it('moves the citations of the clipped tail after the ellipsis', () => {
    const { text, show } = scanned(`${'word '.repeat(100)}end [^${A}][^${B}].`);
    const clipped = clipCited(text, 50);
    expect(show(clipped)).toMatch(/^word word .*…\[1\]\[2\]$/);
    expect(clipped.replace(/[^\p{L} ]/gu, '').length).toBeLessThanOrEqual(50);
  });

  it('never cuts inside a citation and leaves short text alone', () => {
    const { text, show } = scanned(`Twelve chars[^${A}] and more text here.`);
    for (let max = 8; max < 20; max++) expect(show(clipCited(text, max))).toMatch(/\[1\]/);
    expect(clipCited(text, 500)).toBe(text);
  });
});

describe('placeholdersToSharedText', () => {
  it('gives a source the same number on every page, sorted within a group', () => {
    const shared: string[] = [];
    const first = scanCitations(`One [^${A}]. Two [^${B}].`);
    const second = scanCitations(`Three [^${C}][^${A}].`);
    expect(placeholdersToSharedText(first.markdown, first.order, shared)).toBe('One[1]. Two[2].');
    expect(placeholdersToSharedText(second.markdown, second.order, shared)).toBe('Three[1][3].');
    expect(shared).toEqual([A, B, C]);
  });
});

describe('lineKey', () => {
  it('ignores citations, case and punctuation', () => {
    const one = scanCitations(`Bitcoin mining consumes energy [^${A}].`).markdown;
    const two = scanCitations(`bitcoin mining consumes energy [^${B}]`).markdown;
    expect(lineKey(one)).toBe(lineKey(two));
  });
});
