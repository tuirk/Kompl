/**
 * The wiki index's counts (lib/wiki-counts.ts) agree with the sidebar and the
 * map: a category says how many of its pages the sidebar lists under
 * Comparisons, and "pages compiled" leaves out Saved Links, as the map does.
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import WikiCategorySection from '../components/WikiCategorySection';
import { categoryCountLabel, compiledPagesLabel } from '../lib/wiki-counts';

describe('wiki index counts', () => {
  it('names the comparisons the sidebar lists apart', () => {
    expect(categoryCountLabel(14, 1)).toBe('14 pages · 1 comparison');
    expect(categoryCountLabel(25, 2)).toBe('25 pages · 2 comparisons');
    expect(categoryCountLabel(1, 0)).toBe('1 page');
  });

  it('counts compiled pages without Saved Links', () => {
    expect(compiledPagesLabel(76, true)).toBe('76 pages compiled, plus Saved Links');
    expect(compiledPagesLabel(1, false)).toBe('1 page compiled');
  });

  it('shows the label on the category header', () => {
    const html = renderToString(
      createElement(WikiCategorySection, { category: 'Travel', countLabel: '25 pages · 1 comparison', defaultOpen: true, children: 'x' }),
    );
    expect(html).toContain('25 pages · 1 comparison');
  });
});
