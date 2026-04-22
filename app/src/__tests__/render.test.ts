/**
 * Wiki render pipeline — handles malformed drafts.
 *
 * Before the prompt fix, Gemini sometimes produced drafts with:
 *   (1) bare YAML frontmatter (no --- fences)
 *   (2) a ```markdown ... ``` fence around the body
 *   (3) a `## Sources` section duplicating the provenance footer
 * The renderer must heal all three so imported/legacy pages stay readable.
 */

import { describe, it, expect } from 'vitest';
import {
  stripFrontmatter,
  stripWrappingFence,
  stripSourcesSection,
  stripLeadingContentHeading,
  renderMarkdown,
} from '../lib/markdown';

describe('stripFrontmatter', () => {
  it('strips proper --- fenced frontmatter (regression)', () => {
    const md = '---\ntitle: Foo\npage_type: entity\n---\n\n# Body\n';
    expect(stripFrontmatter(md)).toBe('\n# Body\n');
  });

  it('returns input unchanged when --- fence has no close', () => {
    const md = '---\ntitle: Foo\n\nBody without closing fence';
    expect(stripFrontmatter(md)).toBe(md);
  });

  it('strips bare YAML when first line is a known frontmatter key', () => {
    const md = [
      'title: How to set up a business in Dubai',
      'page_type: source-summary',
      'category: Business & Finance',
      'summary: A short summary.',
      'sources:',
      '  - source_id: abc',
      '    title: A source',
      'last_updated: 2023-10-27',
      '',
      '## Content',
      'Body starts here.',
    ].join('\n');
    const out = stripFrontmatter(md);
    expect(out.startsWith('## Content')).toBe(true);
    expect(out).not.toContain('title:');
    expect(out).not.toContain('page_type:');
  });

  it('does not strip when first line looks like YAML but key is not known', () => {
    const md = 'foo: bar\nbaz: qux\n\n# Body';
    expect(stripFrontmatter(md)).toBe(md);
  });

  it('does not strip when first line is not YAML-shaped', () => {
    const md = '# A real heading\n\ntitle: not frontmatter\n';
    expect(stripFrontmatter(md)).toBe(md);
  });

  it('strips bare YAML terminated by a lone ``` line (dominant imported shape)', () => {
    // 13/15 surveyed pages had this shape: no --- fences, a ``` separator,
    // then the body (often without a closing fence).
    const md = [
      'title: TINYforming Mars components',
      'page_type: source-summary',
      'category: Gaming & 3D Printing',
      'summary: A summary.',
      'sources:',
      '  - source_id: abc',
      '    title: A source',
      'last_updated: 2024-07-30',
      '```',
      '',
      '## Content',
      'Body paragraph.',
    ].join('\n');
    const out = stripFrontmatter(md);
    expect(out.startsWith('## Content')).toBe(true);
    expect(out).not.toContain('title:');
    expect(out).not.toContain('page_type:');
    expect(out).not.toContain('```');
  });

  it('strips bare YAML terminated by a lone --- line (half-fenced)', () => {
    // Seen in imported legacy pages: LLM emitted only the closing fence.
    const md = [
      'title: Blogtrottr',
      'page_type: entity',
      'category: Software & Productivity',
      'summary: A short summary.',
      'sources:',
      '  - source_id: abc',
      '    title: A source',
      'last_updated: 2024-07-30',
      '---',
      'Body paragraph starts here.',
    ].join('\n');
    const out = stripFrontmatter(md);
    expect(out).toBe('Body paragraph starts here.');
  });

  it('aborts bare-YAML strip if non-YAML content appears mid-stream (safety)', () => {
    // A line starting with known key but followed by a body-looking line
    // without a blank separator: refuse to strip to avoid data loss.
    const md = 'title: Thing\nThis is a paragraph, not a yaml continuation.\n';
    expect(stripFrontmatter(md)).toBe(md);
  });
});

describe('stripWrappingFence', () => {
  it('unwraps a body wrapped in ```markdown ... ```', () => {
    const md = '```markdown\n# Heading\nBody text\n```';
    expect(stripWrappingFence(md)).toBe('# Heading\nBody text');
  });

  it('unwraps a plain ``` fence', () => {
    const md = '```\n## Content\nLine\n```';
    expect(stripWrappingFence(md)).toBe('## Content\nLine');
  });

  it('leaves non-fenced markdown alone', () => {
    const md = '# Heading\n\nBody paragraph.\n';
    expect(stripWrappingFence(md)).toBe(md);
  });

  it('leaves markdown that only has an internal fence (code sample)', () => {
    const md = '# Heading\n\n```js\nconsole.log(1);\n```\n\nMore prose.\n';
    expect(stripWrappingFence(md)).toBe(md);
  });

  it('strips an unmatched opening ``` wrapper (no closing fence)', () => {
    // Dominant imported shape: ``` opens but never closes. marked would render
    // everything to EOF as a code block — we have to drop the opener.
    const md = '```\n## Content\nReal body with [link](https://example.com)\n\nMore text.';
    const out = stripWrappingFence(md);
    expect(out.startsWith('## Content')).toBe(true);
    expect(out).not.toContain('```');
  });

  it('preserves inner code fences when stripping an unmatched wrapper', () => {
    // Some imported pages have a wrapper opener + paired real code blocks
    // inside. Stripping the wrapper must not touch the inner fences.
    const md = [
      '```',
      '## Body',
      '```js',
      'console.log(1);',
      '```',
      'More prose.',
    ].join('\n');
    const out = stripWrappingFence(md);
    expect(out.startsWith('## Body')).toBe(true);
    expect(out).toContain('```js');
    expect(out).toContain('console.log(1);');
  });

  it('does not strip a language-tagged ``` (real code block, not wrapper)', () => {
    const md = '```python\nprint(1)\n```';
    expect(stripWrappingFence(md)).toBe(md);
  });
});

describe('stripSourcesSection', () => {
  it('removes a `## Sources` section at end of document', () => {
    const md = '# Heading\n\nBody.\n\n## Sources\n- A source\n- Another source\n';
    const out = stripSourcesSection(md);
    expect(out).not.toContain('## Sources');
    expect(out).not.toContain('A source');
    expect(out).toContain('Body.');
  });

  it('removes only the Sources section when followed by another heading', () => {
    const md = '# Heading\n\n## Sources\n- A\n- B\n\n## Other\nStill here.\n';
    const out = stripSourcesSection(md);
    expect(out).not.toContain('## Sources');
    expect(out).toContain('## Other');
    expect(out).toContain('Still here.');
  });

  it('leaves `## Sources of Truth` or similar longer headings alone', () => {
    const md = '## Sources of Truth\nSome text.\n';
    expect(stripSourcesSection(md)).toBe(md);
  });

  it('is a no-op when there is no Sources section', () => {
    const md = '# Heading\n\nBody paragraph.\n';
    expect(stripSourcesSection(md)).toBe(md);
  });
});

describe('stripLeadingContentHeading', () => {
  it('removes a leading ## Content heading', () => {
    const md = '## Content\nActual body text.\n';
    expect(stripLeadingContentHeading(md)).toBe('Actual body text.\n');
  });

  it('is a no-op when there is no leading Content heading', () => {
    const md = '# Heading\n\nBody.\n';
    expect(stripLeadingContentHeading(md)).toBe(md);
  });

  it('leaves a non-leading ## Content heading alone', () => {
    const md = '## Intro\nBlah.\n\n## Content\nDeeper content.\n';
    expect(stripLeadingContentHeading(md)).toBe(md);
  });

  it('does not strip a similarly-named heading', () => {
    const md = '## Contents\nBody.\n';
    expect(stripLeadingContentHeading(md)).toBe(md);
  });
});

describe('renderMarkdown — heading renderer contract', () => {
  // Regression gate for the marked API. v12 → v18 changed `renderer.heading`
  // from `(text, level)` to `({tokens, depth})`. A renderer still on the v12
  // shape silently turns every heading into `[object Object]` under v18.
  // These tests fail loudly on that drift.

  it('renders a plain heading as <hN> with a slug id', () => {
    const html = renderMarkdown('## Hello world\n');
    expect(html).toContain('<h2');
    expect(html).toContain('id="hello-world"');
    expect(html).toContain('Hello world');
    expect(html).not.toContain('[object Object]');
    expect(html).not.toContain('undefined');
  });

  it('respects heading level (depth)', () => {
    const html = renderMarkdown('# A\n\n### B\n');
    expect(html).toContain('<h1 id="a"');
    expect(html).toContain('<h3 id="b"');
    expect(html).not.toContain('<hundefined');
  });

  it('preserves inline formatting inside headings', () => {
    // The v18 API hands you tokens, not a rendered string. If the migration
    // forgets `this.parser.parseInline(tokens)`, inline marks vanish.
    const html = renderMarkdown('## **bold** heading\n');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('heading');
    expect(html).not.toContain('[object Object]');
  });

  it('derives heading id from raw markdown, not rendered HTML', () => {
    // Regression: pre-fix the slug ran on rendered HTML, so inline-formatted
    // headings produced ids like `strongboldstrong-heading` from leaked tag
    // names. Slug must come from the raw `**bold** heading` source.
    const html = renderMarkdown('## **bold** heading\n');
    expect(html).toContain('id="bold-heading"');
    expect(html).not.toContain('strongboldstrong');
  });
});

describe('end-to-end malformed-draft heal', () => {
  it('produces clean HTML from a bare-YAML + body-fence + ##-Sources draft', () => {
    const draft = [
      'title: OpenAI Research',
      'page_type: entity',
      'category: Organizations',
      'summary: Research news section.',
      'sources:',
      '  - source_id: a1',
      '    title: Example',
      'last_updated: 2024-07-30',
      '',
      '```markdown',
      'OpenAI Research is identified as the research news section.',
      '',
      '## What this entity does',
      'Publishes updates.',
      '',
      '## Sources',
      '- Olshansk/rss-feeds',
      '- GitHub - Example',
      '```',
    ].join('\n');

    const stripped = stripFrontmatter(draft);
    const unwrapped = stripWrappingFence(stripped);
    const cleaned = stripSourcesSection(unwrapped);
    const html = renderMarkdown(cleaned);

    // Frontmatter keys must not leak into the rendered HTML.
    expect(html).not.toContain('page_type:');
    expect(html).not.toContain('last_updated:');
    // Body must render as real HTML, not a <code> block.
    expect(html).not.toContain('&lt;code&gt;');
    expect(html).toContain('<h2');
    expect(html).toContain('What this entity does');
    // `## Sources` section must be gone.
    expect(html).not.toMatch(/<h2[^>]*>Sources<\/h2>/);
    expect(html).not.toContain('Olshansk/rss-feeds');
  });
});
