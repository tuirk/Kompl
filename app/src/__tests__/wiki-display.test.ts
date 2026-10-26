/**
 * Display-time cleanup (lib/wiki-display.ts + page-sections): every page,
 * old ones included, links each page once and hides empty Contradictions
 * sections, without changing stored markdown.
 */

import { describe, it, expect } from 'vitest';
import { expandWikilinksForDisplay } from '../lib/wiki-display';

const PAGE_IDS: Record<string, string> = {
  'proof-of-work consensus': 'pow',
  'ethereum overview': 'eo',
  'ethereum foundation': 'ef',
  'bitcoin network': 'bn',
  'smart contracts': 'sc',
  'proof-of-stake': 'pos',
  mining: 'mining',
};
const idOf = (title: string) => PAGE_IDS[title.toLowerCase()];

function links(md: string): string[] {
  return [...md.matchAll(/\]\(\/wiki\/([^)]+)\)/g)].map((m) => m[1]);
}

describe('expandWikilinksForDisplay', () => {
  it('links each page once in the body; later mentions show as text', () => {
    const md =
      'PoS differs from [[proof-of-work consensus]]. Before the Merge, Ethereum used [[proof-of-work consensus|proof-of-work]].';
    const out = expandWikilinksForDisplay(md, idOf, 'pos');
    expect(out).toBe(
      'PoS differs from [proof-of-work consensus](/wiki/pow). Before the Merge, Ethereum used proof-of-work.',
    );
  });

  it('keeps links to different pages that share a label', () => {
    const md = '[[Ethereum Overview|Ethereum]] and [[Ethereum Foundation|Ethereum]].';
    expect(links(expandWikilinksForDisplay(md, idOf, 'pos'))).toEqual(['eo', 'ef']);
  });

  it('gives Related lists and tables their own first-link scope', () => {
    const md = [
      'Body links [[Smart contracts]] and [[Mining]].',
      '',
      '| Page | Note |',
      '| --- | --- |',
      '| [[Smart contracts]] | [[Smart contracts]] again |',
      '',
      '## Related Concepts',
      '- [[Smart contracts]]',
      '- [[Mining]]',
      '- [[Mining]]',
    ].join('\n');
    const out = expandWikilinksForDisplay(md, idOf, 'pos');
    // body: sc, mining · table: sc (second one plain) · related: sc, mining (repeat plain)
    expect(links(out)).toEqual(['sc', 'mining', 'sc', 'sc', 'mining']);
    expect(out).toContain('| [Smart contracts](/wiki/sc) | Smart contracts again |');
  });

  it('never links headings, unknown pages, the page itself, or code', () => {
    const md = [
      '## About [[Mining]]',
      'See [[Mining]], [[Unknown Page|elsewhere]] and [[Proof-of-stake|this page]].',
      'Inline `[[Mining]]` stays.',
      '```',
      '[[Mining]]',
      '```',
    ].join('\n');
    expect(expandWikilinksForDisplay(md, idOf, 'pos')).toBe(
      [
        '## About Mining',
        'See [Mining](/wiki/mining), elsewhere and this page.',
        'Inline `[[Mining]]` stays.',
        '```',
        '[[Mining]]',
        '```',
      ].join('\n'),
    );
  });

  it('resolves titles case-insensitively and counts them as one page', () => {
    const md = '[[smart contracts]] then [[Smart Contracts|they]].';
    expect(expandWikilinksForDisplay(md, idOf, 'pos')).toBe('[smart contracts](/wiki/sc) then they.');
  });
});
