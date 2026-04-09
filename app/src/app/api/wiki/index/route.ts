import { NextResponse } from 'next/server';
import { getAllPages } from '@/lib/db';

/** GET /api/wiki/index — machine-readable catalog for the LLM chat agent.
 *  Returns every page with metadata (no body content) so the agent can
 *  pick relevant page_ids before fetching full content. */
export async function GET() {
  const pages = getAllPages();

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
