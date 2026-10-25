/**
 * What match triage judges a (source, page) pair on (plan 3.5): the claims
 * the source's extraction makes about the page's subject (with the source's
 * own sentence when kept) and the page's related section; the source's text
 * when the extraction makes no such claim.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_TRIAGE_CLAIMS,
  TRIAGE_SECTION_MAX_CHARS,
  claimsAbout,
  formatClaims,
  relevantPageSection,
  subjectNames,
  triageInput,
} from '../lib/triage-evidence';

const claim = (text: string, entities: string[] = [], quote?: string) => ({
  claim: text,
  confidence: 'stated',
  entities_involved: entities,
  ...(quote !== undefined ? { quote } : {}),
});

describe('claimsAbout', () => {
  const aliases = new Map([['gpt-4', ['GPT 4', 'gpt4']]]);
  const names = subjectNames({ title: 'GPT-4', page_type: 'entity' }, aliases);

  it('keeps claims naming the subject or an alias, named ones first, with their quotes', () => {
    const extraction = {
      claims: [
        claim('Claude is made by Anthropic.', ['Claude', 'Anthropic']),
        claim('Its successor GPT-4 handles images.', ['OpenAI']),
        claim('gpt4 has a 32k context window.', ['gpt4'], 'GPT-4 supports 32,768 tokens.'),
      ],
    };
    expect(claimsAbout(extraction, names)).toEqual([
      { claim: 'gpt4 has a 32k context window.', quote: 'GPT-4 supports 32,768 tokens.' },
      { claim: 'Its successor GPT-4 handles images.', quote: null },
    ]);
  });

  it('matches a name in the text only as a whole word', () => {
    const extraction = { claims: [claim('The GPT-40 rumour is false.'), claim('Nothing about it.')] };
    expect(claimsAbout(extraction, names)).toEqual([]);
  });

  it('reads both ends of a comparison page', () => {
    const both = subjectNames({ title: 'Claude vs GPT-4', page_type: 'comparison' }, aliases);
    const extraction = { claims: [claim('Claude writes code.', ['Claude']), claim('GPT 4 is older.', ['GPT 4'])] };
    expect(claimsAbout(extraction, both).map((c) => c.claim)).toEqual(['Claude writes code.', 'GPT 4 is older.']);
  });

  it('carries at most MAX_TRIAGE_CLAIMS claims', () => {
    const extraction = { claims: Array.from({ length: MAX_TRIAGE_CLAIMS + 5 }, (_, i) => claim(`Fact ${i}.`, ['GPT-4'])) };
    expect(claimsAbout(extraction, names)).toHaveLength(MAX_TRIAGE_CLAIMS);
  });

  it('has nothing for an extraction without claims, or none at all', () => {
    expect(claimsAbout({ entities: [] }, names)).toEqual([]);
    expect(claimsAbout(null, names)).toEqual([]);
  });
});

describe('formatClaims', () => {
  it('lists each claim, with the source sentence when it says more', () => {
    expect(
      formatClaims([
        { claim: 'GPT-4 has a 32k context window.', quote: 'GPT-4 supports 32,768 tokens.' },
        { claim: 'Same words.', quote: 'Same words.' },
        { claim: 'No sentence kept.', quote: null },
      ]),
    ).toBe(
      '- GPT-4 has a 32k context window.\n  Source sentence: "GPT-4 supports 32,768 tokens."\n- Same words.\n- No sentence kept.',
    );
  });
});

describe('relevantPageSection', () => {
  const page = [
    '---',
    'title: GPT-4',
    'summary: A model.',
    '---',
    '# GPT-4',
    '',
    'GPT-4 is a large language model released by OpenAI.',
    '',
    '## Context window',
    'GPT-4 accepts a context window of 128k tokens [^s1].',
    '',
    '## Pricing',
    'Pricing is per million tokens.',
    '',
    '## Related',
    '- context window tokens everywhere',
    '',
    '## Sources',
    '[^s1]: context window tokens',
  ].join('\n');
  const claims = [{ claim: 'GPT-4 has a 32k context window.', quote: null }];

  it('picks the sections sharing words with the claims, in page order, without lists of sources or links', () => {
    const section = relevantPageSection(page, claims);
    expect(section).toContain('## Context window');
    expect(section).toContain('128k tokens');
    expect(section).not.toContain('## Related');
    expect(section).not.toContain('## Sources');
    expect(section).not.toContain('Pricing');
    expect(section).not.toContain('summary:');
  });

  it('adds another section only when it is at least half as related', () => {
    const md = '## Limits\nThe context window limit.\n\n## Pricing\nPer million tokens.\n\n## Window\nThe window context grows.';
    // Limits shares 3 words, Window 2, Pricing 1 ("tokens").
    const section = relevantPageSection(md, [{ claim: 'A larger context window limit.', quote: 'Tokens per context window.' }]);
    expect(section).toBe('## Limits\nThe context window limit.\n\n## Window\nThe window context grows.');
  });

  it('cuts to TRIAGE_SECTION_MAX_CHARS', () => {
    const long = `## Context window\n${'context window '.repeat(600)}`;
    expect(relevantPageSection(long, claims).length).toBeLessThanOrEqual(TRIAGE_SECTION_MAX_CHARS);
  });

  it('is empty when nothing on the page relates to the claims', () => {
    expect(relevantPageSection('## Pricing\nPricing is per million.', claims)).toBe('');
    expect(relevantPageSection(null, claims)).toBe('');
  });
});

describe('triageInput', () => {
  it('judges on the claims and the related section when there are claims', () => {
    const input = triageInput('the whole source', [{ claim: 'GPT-4 has a 32k context window.', quote: null }], '## Context window\nGPT-4 context window is 128k.');
    expect(input).toEqual({
      evidence: 'claims',
      source_claims: '- GPT-4 has a 32k context window.',
      page_section: '## Context window\nGPT-4 context window is 128k.',
    });
  });

  it('falls back to the source text without claims', () => {
    expect(triageInput('the whole source', [], '## Anything')).toEqual({
      evidence: 'source_text',
      source_claims: 'the whole source',
      page_section: '',
    });
  });
});
