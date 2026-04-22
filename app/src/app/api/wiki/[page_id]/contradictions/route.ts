/**
 * GET /api/wiki/[page_id]/contradictions
 *
 * Returns the contradiction events logged against this page, newest first.
 * Backed by activity_log rows with action_type='page_contradiction_detected'
 * — there's no separate table. See getPageContradictions in lib/db.ts.
 *
 * Powers the "Contradicting sources" sidebar panel on /wiki/[page_id].
 * Zero LLM cost, bounded by page_id scan over an indexed column.
 */

import { NextResponse } from 'next/server';
import { getPage, getPageContradictions, type PageContradiction } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';

interface ContradictionsResponse {
  items: PageContradiction[];
  count: number;
}

interface RouteContext {
  params: Promise<{ page_id: string }>;
}

export async function GET(
  _request: Request,
  { params }: RouteContext
): Promise<NextResponse<ContradictionsResponse>> {
  const { page_id } = await params;

  const page = getPage(page_id);
  if (!page) {
    return NextResponse.json({ items: [], count: 0 }, { status: 404 });
  }

  const items = getPageContradictions(page_id);
  return NextResponse.json({ items, count: items.length }, { status: 200 });
}
