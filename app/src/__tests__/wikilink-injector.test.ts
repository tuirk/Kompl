/**
 * Deterministic wikilink injection (lib/wikilink-injector.ts).
 *
 * The injector used to start each page with an empty "already linked" set,
 * so it added a second link to pages the drafting model had already linked
 * (most of the repeat links in the 2026-10-09 e2e wiki).
 */

import { describe, it, expect } from 'vitest';
import { injectWikilinks } from '../lib/wikilink-injector';
import { findWikilinks } from '../lib/wikilink-syntax';

const targets = [
  { title: 'Bitcoin network', aliases: ['Bitcoin'] },
  { title: 'Smart contracts', aliases: [] },
];

describe('injectWikilinks', () => {
  it('never adds a second link to a page the draft already links', () => {
    const md = 'The [[Bitcoin network|Bitcoin]] network launched. Later Bitcoin grew. Smart contracts came later.';
    const out = injectWikilinks(md, targets);
    const linked = findWikilinks(out.markdown).map((l) => l.target);
    expect(linked).toEqual(['Bitcoin network', 'Smart contracts']);
    expect(out.linksAdded).toBe(1);
  });

  it('matches already-linked pages case-insensitively', () => {
    const out = injectWikilinks('See [[smart contracts]]. Smart contracts run code.', targets);
    expect(out.linksAdded).toBe(0);
    expect(out.markdown).toBe('See [[smart contracts]]. Smart contracts run code.');
  });

  it('still links the first mention of pages the draft did not link', () => {
    const out = injectWikilinks('Bitcoin uses proof-of-work. Bitcoin is old.', targets);
    expect(out.markdown).toBe('[[Bitcoin network|Bitcoin]] uses proof-of-work. Bitcoin is old.');
  });
});
