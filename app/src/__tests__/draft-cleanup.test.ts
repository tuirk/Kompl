/**
 * Draft-time cleanup (lib/draft-cleanup.ts, lib/page-sections.ts).
 *
 * Fixtures are taken from the 2026-10-09 e2e wiki, where pages linked source
 * notes, re-linked the same page, listed 12 "Related Concepts" and carried
 * invented frontmatter and empty Contradictions sections.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_RELATED_LINKS,
  normalizeFrontmatter,
  relatedLinkTargets,
  sourceOnlyTitles,
  tidyDraftLinks,
} from '../lib/draft-cleanup';
import { removeEmptyContradictionSections } from '../lib/page-sections';
import { findWikilinks } from '../lib/wikilink-syntax';

const UUID = '0b4db637-b010-431f-97c5-3dd25e8ed416';

describe('normalizeFrontmatter', () => {
  const drafted = [
    '---',
    'title: SHA-256 Hashing',
    'page_type: concept',
    'category: Cryptocurrency',
    'entity_type: other',
    'founded: null',
    'contested: true',
    'summary: "SHA-256 is a hash function: used by Bitcoin."',
    'sources:',
    '  - source_id: S1',
    '    title: Stage 14 canary',
    'entities: [Bitcoin, Satoshi Nakamoto]',
    'last_updated: 2025-04-09',
    'status: draft',
    '---',
    '',
    'Body text.',
  ].join('\n');

  it('keeps only the keys the app reads', () => {
    expect(normalizeFrontmatter(drafted)).toBe(
      [
        '---',
        'title: SHA-256 Hashing',
        'page_type: concept',
        'category: Cryptocurrency',
        'summary: "SHA-256 is a hash function: used by Bitcoin."',
        'entities: [Bitcoin, Satoshi Nakamoto]',
        '---',
        '',
        'Body text.',
      ].join('\n'),
    );
  });

  it('is idempotent and keeps folded summaries', () => {
    const folded = '---\ntitle: X\nsummary: >\n  Line one\n  line two\nlast_updated: 2023-10-27\n---\n\nBody';
    const once = normalizeFrontmatter(folded);
    expect(once).toBe('---\ntitle: X\nsummary: >\n  Line one\n  line two\n---\n\nBody');
    expect(normalizeFrontmatter(once)).toBe(once);
  });

  it('drops citation labels from the summary, folded lines included, and nowhere else', () => {
    const md = [
      '---',
      'title: Gediminas Avenue',
      'summary: A street known for its cafes [S1][S2] and parks [S1, S3] [^a1b2c3d4-0000-4000-8000-000000000001].',
      'category: Travel [S1]',
      '---',
      '',
      'Body text [S1].',
    ].join('\n');
    expect(normalizeFrontmatter(md)).toBe(
      [
        '---',
        'title: Gediminas Avenue',
        'summary: A street known for its cafes and parks.',
        'category: Travel [S1]',
        '---',
        '',
        'Body text [S1].',
      ].join('\n'),
    );
    const folded = '---\ntitle: X\nsummary: >\n  The primary metric [S1]\n  in production [S2].\n---\n\nBody';
    expect(normalizeFrontmatter(folded)).toBe('---\ntitle: X\nsummary: >\n  The primary metric\n  in production.\n---\n\nBody');
  });

  it('leaves markdown without a closed frontmatter block alone', () => {
    expect(normalizeFrontmatter('# Heading\n\nlast_updated: 2020')).toBe('# Heading\n\nlast_updated: 2020');
    expect(normalizeFrontmatter('---\ntitle: X\nno closing fence')).toBe('---\ntitle: X\nno closing fence');
  });
});

describe('removeEmptyContradictionSections', () => {
  const page = (section: string) => `Intro.\n\n## Key Claims\n- A claim.\n\n${section}\n\n## Related Concepts\n- [[Mining]]\n`;

  it('removes the two empty e2e variants', () => {
    for (const body of [
      '## Contradictions\nNo contradictions found among the sources regarding proof-of-stake.',
      "## Contradictions\n\nNone. Both sources agree on the core claims about Ethereum's support for decentralized applications and Bitcoin's lack thereof.",
      '### Contradictions\n- None.',
      '## Contradictions',
    ]) {
      const out = removeEmptyContradictionSections(page(body));
      expect(out.removed).toBe(1);
      expect(out.markdown).toBe('Intro.\n\n## Key Claims\n- A claim.\n\n## Related Concepts\n- [[Mining]]\n');
    }
  });

  it('keeps real contradictions and disputes', () => {
    for (const body of [
      `## Contradictions\nSources disagree on the founding year: one gives 2013[^${UUID}].`,
      '## Disputed: Python creation timeline\nNone of the sources agree on a date.',
      '## Contradictions\nNone. However, one source gives 2013 and another 2015.',
      '## Contradictions\nNone of the sources agree on the founding year.',
      '## Contradictions\nNo contradictions, but the dates differ by two years.',
    ]) {
      const out = removeEmptyContradictionSections(page(body));
      expect(out.removed).toBe(0);
      expect(out.markdown).toBe(page(body));
    }
  });

  it('ignores headings inside fenced code', () => {
    const md = 'Intro.\n\n```\n## Contradictions\nNone.\n```\n';
    expect(removeEmptyContradictionSections(md).removed).toBe(0);
  });
});

describe('sourceOnlyTitles', () => {
  it('collects source titles unless a non-source page shares the title', () => {
    const titles = sourceOnlyTitles([
      { title: 'Bitcoin Basics', page_type: 'original-source' },
      { title: 'Attention Is All You Need', page_type: 'source-summary' },
      { title: 'Satoshi Nakamoto', page_type: 'original-source' },
      { title: 'Satoshi Nakamoto', page_type: 'entity' },
      { title: 'Proof-of-stake', page_type: 'concept' },
    ]);
    expect([...titles].sort()).toEqual(['attention is all you need', 'bitcoin basics']);
  });
});

// The e2e Proof-of-stake page (shortened): links to source notes, a repeated
// link, and a 12-entry Related Concepts list.
const POS_PAGE = [
  '---',
  'title: Proof-of-stake',
  'page_type: concept',
  '---',
  '',
  'Proof-of-stake (PoS) differs from [[proof-of-work consensus]]. [[Ethereum Overview|Ethereum]] adopted it in 2022 via the Merge.',
  'Created by [[Vitalik Buterin]] as an improvement over [[Bitcoin network|Bitcoin]], [[Ethereum Foundation|Ethereum]] supports [[Smart contracts]] and [[Decentralized applications]]. Before the Merge, Ethereum used [[proof-of-work consensus|proof-of-work]]. [[Bitcoin Basics|Bitcoin]] continues to use proof-of-work.',
  '',
  '## Key Claims',
  '- Ethereum processes around 15 transactions per second, a metric relevant to [[Transaction throughput]].',
  '',
  '## Related Concepts',
  '- [[proof-of-work consensus]]',
  '- [[Ethereum Overview]]',
  '- [[Bitcoin Basics]]',
  '- [[BTC vs ETH Comparison]]',
  '- [[Vitalik Buterin]]',
  '- [[Smart contracts]]',
  '- [[Decentralized applications]]',
  '- [[Transaction throughput]]',
  '- [[Bitcoin network]]',
  '- [[Ethereum Foundation]]',
  '- [[Satoshi Nakamoto]]',
  '- [[SHA-256 hashing]]',
  '',
].join('\n');

const BLOCKED = new Set(['ethereum overview', 'bitcoin basics', 'btc vs eth comparison', 'proof-of-stake']);
const SOURCES = 'Ethereum moved from proof-of-work to proof-of-stake in 2022 via the Merge. Bitcoin uses proof-of-work.';

function bodyOf(md: string): string {
  return md.split('## Related Concepts')[0];
}

describe('tidyDraftLinks', () => {
  it('cleans the e2e Proof-of-stake page', () => {
    const out = tidyDraftLinks(POS_PAGE, { blocked: BLOCKED, sourceText: SOURCES });
    const links = findWikilinks(out.markdown).map((l) => l.target.toLowerCase());
    // No links to source notes or to the page itself.
    for (const target of links) expect(BLOCKED.has(target)).toBe(false);
    // Each page linked once in the body.
    const bodyTargets = findWikilinks(bodyOf(out.markdown)).map((l) => l.target.toLowerCase());
    expect(new Set(bodyTargets).size).toBe(bodyTargets.length);
    // The words of unlinked mentions stay.
    expect(bodyOf(out.markdown)).toContain('Ethereum adopted it in 2022');
    expect(bodyOf(out.markdown)).toContain('Ethereum used proof-of-work.');
    expect(bodyOf(out.markdown)).toContain('Bitcoin continues to use proof-of-work.');
    // Related: relevant, capped, no unrelated people or hashing.
    const related = findWikilinks(out.markdown.split('## Related Concepts')[1]).map((l) => l.target);
    expect(related.length).toBeLessThanOrEqual(MAX_RELATED_LINKS);
    expect(related).toEqual([
      'proof-of-work consensus',
      'Vitalik Buterin',
      'Smart contracts',
      'Decentralized applications',
      'Transaction throughput',
    ]);
    expect(out.relatedDropped).toBe(7);
  });

  it('always keeps Related entries the page already had', () => {
    const out = tidyDraftLinks(POS_PAGE, {
      blocked: BLOCKED,
      sourceText: SOURCES,
      keepRelated: new Set(['satoshi nakamoto']),
    });
    const related = findWikilinks(out.markdown.split('## Related Concepts')[1]).map((l) => l.target);
    expect(related).toContain('Satoshi Nakamoto');
    expect(related.length).toBe(MAX_RELATED_LINKS);
  });

  it('counts alias mentions as relevance', () => {
    const md = 'Intro mentions BTC.\n\n## Related Concepts\n- [[Bitcoin network]]\n';
    const out = tidyDraftLinks(md, {
      blocked: new Set(),
      sourceText: '',
      surfaces: new Map([['bitcoin network', ['BTC']]]),
    });
    expect(out.markdown).toContain('- [[Bitcoin network]]');
  });

  it('removes a Related section left empty', () => {
    const md = 'Intro.\n\n## Related Concepts\n- [[Ethereum Overview]]\n- [[Unmentioned Page]]\n';
    const out = tidyDraftLinks(md, { blocked: BLOCKED, sourceText: '' });
    expect(out.markdown).toBe('Intro.\n');
  });

  it('does not trim Related lists when trimRelated is false, but still unlinks blocked targets', () => {
    const md = 'Text [[Bitcoin Basics|Bitcoin]].\n\n## See also\n- [[Unmentioned Page]]\n';
    const out = tidyDraftLinks(md, { blocked: BLOCKED, sourceText: '', trimRelated: false });
    expect(out.markdown).toBe('Text Bitcoin.\n\n## See also\n- [[Unmentioned Page]]\n');
  });

  it('unlinks headings and leaves code alone', () => {
    const md = '## About [[Mining]]\n\nUses [[Mining]] and `[[Mining]]`.\n\n```\n[[Mining]]\n```\n';
    const out = tidyDraftLinks(md, { blocked: new Set(), sourceText: '' });
    expect(out.markdown).toBe('## About Mining\n\nUses [[Mining]] and `[[Mining]]`.\n\n```\n[[Mining]]\n```\n');
  });
});

describe('relatedLinkTargets', () => {
  it('lists the targets of Related sections only', () => {
    expect([...relatedLinkTargets(POS_PAGE)]).toHaveLength(12);
    expect(relatedLinkTargets('Body [[A]].\n\n## See also\n- [[B]]\n').has('a')).toBe(false);
  });
});
