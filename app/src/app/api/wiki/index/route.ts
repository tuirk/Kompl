import { NextResponse } from 'next/server';
import { getAllPages } from '@/lib/db';

/** GET /api/wiki/index — machine-readable page catalog. Consumed by the MCP
 *  server (list_pages, wiki_stats) and the wiki sidebar. Returns every page
 *  with metadata (no body content) so an agent can pick relevant page_ids
 *  before fetching full content.
 *  ?include_archived=true — include pages where all sources are archived
 *  (used by WikiSidebar "Show archived" toggle). */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const includeArchived = searchParams.get('include_archived') === 'true';
  const pages = getAllPages(includeArchived);

  // Group page_ids by category for quick category-level lookup
  const categories: Record<string, string[]> = {};
  for (const p of pages) {
    const cat = p.category ?? 'Uncategorized';
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(p.page_id);
  }

  return NextResponse.json({
    generated_at: new Date().toISOString(),
    total_pages: pages.length,
    categories,
    pages: pages.map((p) => ({
      page_id: p.page_id,
      title: p.title,
      page_type: p.page_type,
      category: p.category,
      summary: p.summary,
      source_count: p.source_count,
      last_updated: p.last_updated,
    })),
  });
}
