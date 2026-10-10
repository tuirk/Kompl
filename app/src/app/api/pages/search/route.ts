import { NextResponse } from 'next/server';
import { searchPages } from '@/lib/db';
import { hybridSearch } from '@/lib/hybrid-search';

/**
 * GET /api/pages/search?q=<query>[&limit=N]
 *   Keyword search (FTS5, every term must match) for the app's search box,
 *   which calls it on each keystroke.
 *
 * GET /api/pages/search?q=<query>&mode=hybrid[&limit=N][&category=][&page_type=]
 *   Keyword + meaning search for AI agents (MCP search_wiki); see
 *   lib/hybrid-search.ts. Leaves out archived pages and Saved Links.
 *   Response adds `degraded: true` when only keyword matches were available.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') ?? '').trim();

  if (searchParams.get('mode') === 'hybrid') {
    const requested = parseInt(searchParams.get('limit') ?? '20', 10);
    const limit = Number.isNaN(requested) ? 20 : Math.min(Math.max(requested, 1), 100);
    if (!q) return NextResponse.json({ items: [], count: 0, degraded: false });
    const { items, degraded } = await hybridSearch(q, {
      limit,
      category: optionalParam(searchParams, 'category'),
      pageType: optionalParam(searchParams, 'page_type'),
    });
    return NextResponse.json({ items, count: items.length, degraded });
  }

  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 100);

  if (!q) {
    return NextResponse.json({ items: [], count: 0 });
  }

  try {
    const items = searchPages(q, limit);
    return NextResponse.json({ items, count: items.length });
  } catch {
    // FTS5 syntax error (malformed query) — return empty rather than 500
    return NextResponse.json({ items: [], count: 0 });
  }
}

/** A trimmed query parameter, or undefined when absent or blank. */
function optionalParam(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name)?.trim();
  return value ? value : undefined;
}
