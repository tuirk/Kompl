/**
 * The Connections card's "Show all N" list (app/wiki/[page_id]/MoreRows.tsx):
 * once opened, "Show fewer" sits after the last row, not in the middle.
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ConnectionsPanel from '../app/wiki/[page_id]/ConnectionsPanel';

describe('Show all / Show fewer', () => {
  it('puts "Show all" before the hidden rows and "Show fewer" after the last one', () => {
    const linked = Array.from({ length: 20 }, (_, i) => ({ page_id: `linked-${i}`, title: `Linked ${i}` }));
    const html = renderToString(
      createElement(ConnectionsPanel, { pageId: 'lithuania', connections: { groups: [], linked_only: linked } }),
    );
    const more = html.slice(html.indexOf('<details class="wiki-rp-more">'));
    const showAll = more.indexOf('Show all');
    const lastRow = more.indexOf('Linked 19');
    const showFewer = more.indexOf('Show fewer');
    expect(showAll).toBeGreaterThan(-1);
    expect(showAll).toBeLessThan(lastRow);
    expect(showFewer).toBeGreaterThan(lastRow);
    expect(more.slice(0, showFewer)).toMatch(/<button type="button"[^>]*>$/);
  });
});
