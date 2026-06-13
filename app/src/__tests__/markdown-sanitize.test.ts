/**
 * XSS hardening in lib/markdown.ts + lib/safe-url.ts.
 *
 * Regression target: marked 12 passes raw HTML through by default, and
 * renderMarkdown() output lands in dangerouslySetInnerHTML on wiki/source
 * pages. Ingested scrapes, LLM drafts, and import zips are untrusted, so
 * a literal <script> in page markdown executed in the reader's browser.
 *
 * Covers:
 *   - raw HTML (block + inline) is escaped, not rendered
 *   - javascript:/data:/vbscript: links render as text, no <a>
 *   - unsafe image src renders alt text, no <img>
 *   - safe markdown (headings, links, images, code, tables) still renders
 *   - safeExternalUrl / safeMarkdownHref allowlists
 */

import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../lib/markdown';
import { safeExternalUrl, safeMarkdownHref } from '../lib/safe-url';

describe('renderMarkdown — raw HTML escaping', () => {
  it('escapes a block-level <script> tag', () => {
    const html = renderMarkdown('hello\n\n<script>alert(1)</script>\n\nworld');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes inline HTML inside a paragraph', () => {
    const html = renderMarkdown('before <img src=x onerror=alert(1)> after');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('escapes iframe/svg event-handler vectors', () => {
    const html = renderMarkdown('<iframe src="https://evil.example"></iframe>\n\n<svg onload=alert(1)>');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<svg');
  });
});

describe('renderMarkdown — link/image scheme allowlist', () => {
  it('drops javascript: links but keeps the link text', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
    expect(html).toContain('click me');
  });

  it('drops data: links', () => {
    const html = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)');
    expect(html).not.toContain('data:');
    expect(html).not.toContain('<a ');
  });

  it('drops unsafe image src and renders alt text', () => {
    const html = renderMarkdown('![alt text](javascript:alert(1))');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('alt text');
  });

  it('keeps https links and images', () => {
    const html = renderMarkdown('[ok](https://example.org/a) ![pic](https://example.org/p.png "cap")');
    expect(html).toContain('<a href="https://example.org/a">ok</a>');
    expect(html).toContain('<img src="https://example.org/p.png" alt="pic" title="cap">');
  });

  it('keeps anchors and relative links', () => {
    const html = renderMarkdown('[toc](#section) and [wiki](/wiki/some-page)');
    expect(html).toContain('href="#section"');
    expect(html).toContain('href="/wiki/some-page"');
  });

  it('escapes quotes in titles so attributes cannot be broken out of', () => {
    const html = renderMarkdown('[t](https://example.org "x\" onmouseover=\"alert(1)")');
    expect(html).not.toContain('onmouseover="alert');
  });
});

describe('renderMarkdown — sane markdown still renders', () => {
  it('renders headings with slug ids, bold, code, and tables', () => {
    const html = renderMarkdown(
      '## My Heading\n\n**bold** and `code`\n\n| a | b |\n| - | - |\n| 1 | 2 |'
    );
    expect(html).toContain('<h2 id="my-heading">');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<table>');
  });
});

describe('safeExternalUrl', () => {
  it.each([
    ['https://example.org/x', 'https://example.org/x'],
    ['http://example.org', 'http://example.org'],
    ['  https://padded.example  ', 'https://padded.example'],
  ])('allows %s', (input, expected) => {
    expect(safeExternalUrl(input)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox',
    'file:///etc/passwd',
    '//protocol-relative.example',
    '/relative/path',
    '',
    null,
    undefined,
    42,
  ])('rejects %s', (input) => {
    expect(safeExternalUrl(input)).toBeNull();
  });
});

describe('safeMarkdownHref', () => {
  it('additionally allows anchors and relative paths', () => {
    expect(safeMarkdownHref('#anchor')).toBe('#anchor');
    expect(safeMarkdownHref('/wiki/page')).toBe('/wiki/page');
    expect(safeMarkdownHref('./sibling')).toBe('./sibling');
    expect(safeMarkdownHref('../up')).toBe('../up');
  });

  it('still rejects script schemes and protocol-relative', () => {
    expect(safeMarkdownHref('javascript:alert(1)')).toBeNull();
    expect(safeMarkdownHref('//evil.example')).toBeNull();
    expect(safeMarkdownHref('data:x')).toBeNull();
  });
});
