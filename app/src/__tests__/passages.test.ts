/**
 * Source passages (lib/passages.ts), which let MCP read_source quote the part
 * of a long source that supports a claim: splitting follows headings and
 * paragraphs within a size cap, and BM25 ranking finds the relevant passage.
 */

import { describe, expect, it } from 'vitest';
import { rankPassages, splitPassages } from '../lib/passages';

const para = (word: string, n: number) => Array.from({ length: n }, () => word).join(' ');

describe('splitPassages', () => {
  it('keeps the nearest heading and the offset of each passage', () => {
    const md = '# Mining\n\nMiners compete to add blocks.\n\n## Energy\n\nMining uses a lot of power.';
    const passages = splitPassages(md);
    expect(passages.map((p) => [p.heading, p.text])).toEqual([
      ['Mining', 'Miners compete to add blocks.'],
      ['Energy', 'Mining uses a lot of power.'],
    ]);
    for (const p of passages) expect(md.slice(p.start, p.start + p.text.length)).toBe(p.text);
  });

  it('merges short paragraphs and keeps every passage within the size cap', () => {
    const md = [para('alpha', 100), para('beta', 100), para('gamma', 100), para('delta', 400)].join('\n\n');
    const passages = splitPassages(md);
    expect(passages.length).toBeGreaterThan(1);
    expect(passages[0].text).toContain('alpha');
    expect(passages[0].text).toContain('beta');
    for (const p of passages) expect(p.text.length).toBeLessThanOrEqual(1_500);
    expect(passages.map((p) => p.text).join(' ').split(/\s+/).length).toBe(700);
    for (const p of passages) expect(md.slice(p.start, p.start + 20)).toBe(p.text.slice(0, 20));
  });

  it('points at the first character of indented and cut paragraphs', () => {
    const md = `Intro line.\n\n   ${para('word', 700)}`;
    const passages = splitPassages(md);
    expect(passages.length).toBeGreaterThan(2);
    for (const p of passages) expect(md.slice(p.start, p.start + p.text.length)).toBe(p.text);
  });

  it('does not take comment lines inside code blocks for headings', () => {
    const md = '## Setup\n\n```bash\n\n# Install dependencies\nnpm install\n```\n\nThe tool measures energy.';
    const passages = splitPassages(md);
    expect(passages.every((p) => p.heading === 'Setup')).toBe(true);
  });

  it('never cuts an emoji in half', () => {
    const md = '😀'.repeat(1_000); // 2,000 UTF-16 units, no spaces
    const joined = splitPassages(md).map((p) => p.text).join('');
    expect(joined).toBe(md);
    for (const p of splitPassages(md)) expect(p.text.charCodeAt(p.text.length - 1)).not.toBe(0xd83d);
  });

  it('treats text right under a heading as part of that section', () => {
    const passages = splitPassages('## History\nPython appeared in 1991.');
    expect(passages).toEqual([{ text: 'Python appeared in 1991.', heading: 'History', start: 11 }]);
  });

  it('returns nothing for empty text', () => {
    expect(splitPassages('  \n\n ')).toEqual([]);
  });
});

describe('rankPassages', () => {
  const passages = splitPassages(
    [
      '## Origins',
      'Bitcoin was described in a 2008 paper by Satoshi Nakamoto.',
      '## Mining',
      'Miners secure the network with proof of work. Mining consumes significant energy.',
      '## Price',
      'The price of bitcoin is volatile.',
    ].join('\n\n')
  );

  it('ranks the passage that matches the question first', () => {
    const ranked = rankPassages('how much energy does mining use', passages, 2);
    expect(ranked[0].heading).toBe('Mining');
    expect(ranked[0].score).toBeGreaterThan(0);
  });

  it('matches word prefixes and counts headings', () => {
    expect(rankPassages('miner', passages, 1)[0].heading).toBe('Mining');
    expect(rankPassages('origins', passages, 1)[0].heading).toBe('Origins');
  });

  it('returns only passages that match, at most k', () => {
    expect(rankPassages('nakamoto', passages, 3).map((p) => p.heading)).toEqual(['Origins']);
    expect(rankPassages('volcano', passages, 3)).toEqual([]);
    expect(rankPassages('what is it', passages, 3)).toEqual([]);
  });
});
