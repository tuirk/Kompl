/**
 * POST /api/drafts/[plan_id]/approve
 *
 * Commits a single pending_approval draft to the wiki via the shared
 * commitSinglePlan helper. Bulk equivalent: POST /api/drafts/approve-all.
 */

import { NextResponse } from 'next/server';
import { commitSinglePlan } from '@/lib/approve-plan';

interface RouteContext {
  params: Promise<{ plan_id: string }>;
}

export async function POST(_request: Request, { params }: RouteContext) {
  const { plan_id } = await params;
  const result = await commitSinglePlan(plan_id);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status ?? 500 }
    );
  }

  return NextResponse.json({ page_id: result.page_id, title: result.title, committed: true });
}
