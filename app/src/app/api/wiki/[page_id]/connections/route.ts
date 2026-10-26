import { NextResponse } from 'next/server';
import { getPage } from '@/lib/db';
import { getPageConnections } from '@/lib/relations';

export const dynamic = 'force-dynamic';

/** GET /api/wiki/[page_id]/connections — the page's connections, the same
 *  JSON as the `connections` field of /api/wiki/[page_id]/data: typed
 *  relations grouped by label, each with its source count and evidence
 *  sentences, then `linked_only`, the pages it shares only a plain link with
 *  (lib/relations.ts getPageConnections). For the graph's page and line
 *  panels. 404 for an unknown page. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ page_id: string }> }
) {
  const { page_id } = await params;
  if (!getPage(page_id)) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }
  return NextResponse.json(getPageConnections(page_id));
}
