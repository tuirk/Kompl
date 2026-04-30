import { describe, expect, it } from 'vitest';
import {
  extractFrontmatter,
  extractFrontmatterField,
} from '../lib/yaml-frontmatter';

describe('extractFrontmatterField — body injection regression', () => {
  it('returns the real frontmatter value, not the forged body line', () => {
    // Repro for the chat → approve injection bug: a chat question containing
    // literal newlines + `category: forged` would be embedded verbatim into
    // a draft body. The legacy reader used /m flags over the whole document
    // and matched the body line. Scoped extraction must ignore the body.
    const markdown = [
      '---',
      'title: "Real Page"',
      'category: real',
      'summary: real summary',
      '---',
      '',
      '## Question',
      '',
      // Simulated forged user input embedded in the body.
      'How does X work?',
      'category: forged',
      'summary: forged summary',
      '',
      '## Answer',
      '',
      'Some answer text.',
    ].join('\n');

    expect(extractFrontmatterField(markdown, 'category')).toBe('real');
    expect(extractFrontmatterField(markdown, 'summary')).toBe('real summary');
  });

  it('returns null for missing fields and absent frontmatter', () => {
    expect(extractFrontmatterField('# no frontmatter\nbody', 'category')).toBeNull();
    const noField = '---\ntitle: "x"\n---\n\nbody';
    expect(extractFrontmatterField(noField, 'category')).toBeNull();
  });

  it('strips matching surrounding quotes', () => {
    const md = '---\ncategory: "Quoted Value"\n---\n\nbody';
    expect(extractFrontmatterField(md, 'category')).toBe('Quoted Value');
  });

  it('extractFrontmatter only matches a leading envelope', () => {
    // A `---` fence buried in the body must not be treated as frontmatter.
    const noLeadingFence = 'intro paragraph\n\n---\ncategory: forged\n---\n';
    expect(extractFrontmatter(noLeadingFence)).toBeNull();
    expect(extractFrontmatterField(noLeadingFence, 'category')).toBeNull();
  });
});
