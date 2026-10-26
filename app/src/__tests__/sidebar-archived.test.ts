/**
 * "Show archived" in the wiki sidebar (lib/sidebar-archived.ts): the list
 * keeps the server's order, archived pages are known, and the toggle says
 * what it found.
 */

import { describe, expect, it } from 'vitest';
import type { CategoryGroup, PageRow } from '../lib/db';
import { archivedNote, archivedPageIds, groupPagesByCategory } from '../lib/sidebar-archived';

function page(page_id: string, title: string, category: string | null, page_type = 'entity', last_updated = '2026-10-10 10:00:00'): PageRow {
  return {
    page_id,
    title,
    page_type,
    category,
    summary: null,
    content_path: '',
    previous_content_path: null,
    last_updated,
    source_count: 1,
    created_at: last_updated,
  } as PageRow;
}

describe('groupPagesByCategory', () => {
  it('orders categories and titles like the server, not by last update', () => {
    const pages = [
      page('p', 'Products Overview', 'AI', 'overview', '2026-10-25 09:00:00'),
      page('c', 'Claude', 'AI', 'entity', '2026-10-01 09:00:00'),
      page('b', 'Bitcoin', 'Crypto'),
      page('u', 'Loose note', null),
    ];
    expect(groupPagesByCategory(pages).map((g) => [g.category, g.pages.map((p) => p.title)])).toEqual([
      ['AI', ['Claude', 'Products Overview']],
      ['Crypto', ['Bitcoin']],
      ['Uncategorized', ['Loose note']],
    ]);
  });
});

describe('archivedPageIds', () => {
  it('finds the pages the normal list leaves out, and archived-type pages', () => {
    const shown: CategoryGroup[] = [{ category: 'AI', pages: [page('c', 'Claude', 'AI')] }];
    const all = [page('c', 'Claude', 'AI'), page('old', 'Old page', 'AI'), page('arch', 'Retired', 'AI', 'archived')];
    expect([...archivedPageIds(all, shown)].sort()).toEqual(['arch', 'old']);
  });
});

describe('archivedNote', () => {
  it('says when there is nothing archived', () => {
    expect(archivedNote(0)).toBe('No archived pages.');
    expect(archivedNote(1)).toBe('1 archived page, shown in italics.');
    expect(archivedNote(3)).toBe('3 archived pages, shown in italics.');
  });
});
