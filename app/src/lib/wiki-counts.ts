/**
 * Page counts on the wiki index (app/wiki/page.tsx), worded so they agree
 * with the other screens that count pages. Pure, no DB.
 *
 *   - The sidebar lists comparison pages in their own "Comparisons" list, so
 *     its count for a category leaves them out; the index's category header
 *     says how many of its pages are comparisons.
 *   - Saved Links is a page Kompl writes, not one compiled from sources: the
 *     map leaves it out, so "pages compiled" does too and names it apart.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "14 pages", or "14 pages · 1 comparison" when the sidebar lists some of them under Comparisons. */
export function categoryCountLabel(pages: number, comparisons: number): string {
  return comparisons > 0 ? `${plural(pages, 'page')} · ${plural(comparisons, 'comparison')}` : plural(pages, 'page');
}

/** "76 pages compiled", with ", plus Saved Links" when that page is listed too. */
export function compiledPagesLabel(compiled: number, savedLinks: boolean): string {
  return `${plural(compiled, 'page')} compiled${savedLinks ? ', plus Saved Links' : ''}`;
}
