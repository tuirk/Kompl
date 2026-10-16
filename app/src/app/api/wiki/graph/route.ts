import { NextResponse } from 'next/server';
import { getWikiGraph } from '@/lib/wiki-graph';

export const dynamic = 'force-dynamic';

/** GET /api/wiki/graph — the knowledge graph page's data (lib/wiki-graph.ts):
 *  `nodes` (every page with its type, category, source count and degree),
 *  `links` (one per page pair: typed `relations`, `wikilink`, `weight`) and
 *  `missing` (names typed-linked to pages, with no page yet).
 *  ?include_archived=true — also archived pages, flagged `archived`
 *  (drawn muted client-side). */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const includeArchived = searchParams.get('include_archived') === 'true';
  return NextResponse.json(getWikiGraph(includeArchived));
}
