/**
 * The wiki sidebar's "Show archived" view (components/WikiSidebar.tsx):
 * every page, grouped the way the server groups them, plus which of them are
 * archived and a line that says what the toggle did, so turning it on never
 * looks like nothing happened.
 *
 * A page counts as archived when the normal list leaves it out: its type is
 * 'archived', or every source behind it is archived (db.getCategoryGroups).
 */

import type { CategoryGroup, PageRow } from './db';

/**
 * Pages grouped by category, categories and titles in order, like
 * db.getCategoryGroups (SQLite's default BINARY order compares the same
 * code units as `<`), so turning the toggle on doesn't reorder the list.
 */
export function groupPagesByCategory(pages: PageRow[]): CategoryGroup[] {
  const byOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const map = new Map<string, PageRow[]>();
  for (const p of pages) {
    const cat = p.category ?? 'Uncategorized';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(p);
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => byOrder(a, b))
    .map(([category, rows]) => ({ category, pages: [...rows].sort((a, b) => byOrder(a.title, b.title)) }));
}

/** The pages of `all` that the normal list (`shown`) leaves out. */
export function archivedPageIds(all: PageRow[], shown: CategoryGroup[]): Set<string> {
  const visible = new Set(shown.flatMap((g) => g.pages.map((p) => p.page_id)));
  return new Set(all.filter((p) => p.page_type === 'archived' || !visible.has(p.page_id)).map((p) => p.page_id));
}

/** What the sidebar says once the archived pages are loaded. */
export function archivedNote(count: number): string {
  if (count === 0) return 'No archived pages.';
  return count === 1 ? '1 archived page, shown in italics.' : `${count} archived pages, shown in italics.`;
}
