import { NextResponse } from 'next/server';
import { getWikiGraph } from '@/lib/db';

/** GET /api/wiki/graph — nodes + links for the force-directed graph view.
 *  ?include_archived=true — include nodes for pages where all sources are archived
 *  (muted styling applied client-side via node.archived flag). */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const includeArchived = searchParams.get('include_archived') === 'true';
  const data = getWikiGraph(includeArchived);
  return NextResponse.json(data);
}
