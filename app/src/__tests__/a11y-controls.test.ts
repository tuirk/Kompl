/**
 * Accessibility fixes from the desktop browser crawl (axe): named controls
 * (sources filters, settings gear, settings switches), focusable code blocks,
 * and links in running text that do not rely on colour alone.
 */

import { createElement, isValidElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/wiki',
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import TopNav from '../components/TopNav';
import SourcesPage from '../app/sources/page';
import { CodeBlock, TogglePill } from '../app/settings/_ui';
import { renderMarkdown } from '../lib/markdown';
import { INLINE_LINK_STYLE, renderInlineWikilinks } from '../lib/wikilink-render';

// ── Named controls ───────────────────────────────────────────────────────────

describe('controls carry an accessible name', () => {
  it('the sources filters: named selects, date inputs with visible labels', () => {
    const html = renderToString(createElement(SourcesPage));
    expect(html).toContain('aria-label="Status"');
    expect(html).toContain('aria-label="Source type"');
    expect(html).toContain('aria-label="Search titles and addresses"');
    expect(html).not.toContain('title="Ingested from"');
    expect(html).toMatch(/<label[^>]*>Ingested from<input[^>]*type="date"/);
    expect(html).toMatch(/<label[^>]*>to<input[^>]*type="date"/);
  });

  it('the nav settings gear is a named link', () => {
    const html = renderToString(createElement(TopNav));
    expect(html).toMatch(/<a[^>]*href="\/settings"[^>]*aria-label="Settings"|<a[^>]*aria-label="Settings"[^>]*href="\/settings"/);
    expect(html).toContain('aria-label="Search wiki"');
  });

  it('a settings switch is named by its content, which includes the visible ON/OFF', () => {
    for (const value of [true, false]) {
      const html = renderToString(
        createElement(TogglePill, { value, onClick: () => {}, disabled: false, label: 'Auto-approve wiki changes' }),
      );
      expect(html).toContain('role="switch"');
      expect(html).toContain(`aria-checked="${value}"`);
      expect(html).not.toContain('aria-label');
      expect(html).not.toContain('aria-pressed');
      // Tags stripped until none is left, so no tag survives a strip.
      let text = html;
      for (let prev = ''; prev !== text; ) {
        prev = text;
        text = text.replace(/<[^>]*>/g, '');
      }
      expect(text).toContain('Auto-approve wiki changes');
      expect(text).toContain(value ? 'ON' : 'OFF');
    }
  });
});

// ── Scrollable code blocks ───────────────────────────────────────────────────

describe('code blocks take keyboard focus and have a name', () => {
  it('markdown code blocks, with and without a language', () => {
    expect(renderMarkdown('```\nnpm ci\n```')).toContain('<pre tabindex="0" role="group" aria-label="Code block"><code>');
    expect(renderMarkdown('```bash\nnpm ci\n```')).toContain(
      '<pre tabindex="0" role="group" aria-label="Code block"><code class="language-bash">',
    );
  });

  it('inline code is untouched', () => {
    expect(renderMarkdown('Run `npm ci` first.')).not.toContain('tabindex');
  });

  it('the settings command blocks', () => {
    const html = renderToString(createElement(CodeBlock, { label: 'Codex command', children: 'codex mcp add' }));
    expect(html).toMatch(/<pre[^>]*tabindex="0"/i);
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Codex command"');
  });
});

// ── Links in running text ────────────────────────────────────────────────────

describe('links in running text do not rely on colour alone', () => {
  it('summary wikilinks are underlined', () => {
    const parts = renderInlineWikilinks('Capital of [[Lithuania]] and [[Nowhere]].', new Map([['lithuania', 'lt-1']]));
    const links = parts.filter((p): p is ReactElement<{ style?: object; href?: string }> => isValidElement(p));
    expect(links).toHaveLength(1);
    expect(links[0].props.href).toBe('/wiki/lt-1');
    expect(links[0].props.style).toBe(INLINE_LINK_STYLE);
    expect(INLINE_LINK_STYLE.textDecoration).toBe('underline');
    expect(parts).toContain('Nowhere');
  });
});
