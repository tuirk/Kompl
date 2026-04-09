import { NextResponse } from 'next/server';
import { getAllPages, getCategoryGroups } from '@/lib/db';

/** GET /api/pages — all compiled wiki pages, newest first.
 *  ?grouped=true returns {categories: [{category, pages}]} instead of flat list. */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const grouped = searchParams.get('grouped') === 'true';

  if (grouped) {
    const categories = getCategoryGroups();
    return NextResponse.json({ categories, count: categories.reduce((n, g) => n + g.pages.length, 0) });
  }

  const items = getAllPages();
  return NextResponse.json({ items, count: items.length });
}
