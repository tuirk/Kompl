/**
 * POST /api/drafts/[plan_id]/reject
 *
 * Marks a pending_approval draft as rejected. The row is kept for audit trail.
 */

import { NextResponse } from 'next/server';
import { getDb, updatePlanStatus, insertActivity } from '@/lib/db';

interface RouteContext {
  params: Promise<{ plan_id: string }>;
}

export async function POST(_request: Request, { params }: RouteContext) {
  const { plan_id } = await params;
  const db = getDb();

  const plan = db
    .prepare('SELECT plan_id, title, draft_status FROM page_plans WHERE plan_id = ?')
    .get(plan_id) as { plan_id: string; title: string; draft_status: string } | undefined;

  if (!plan) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (plan.draft_status !== 'pending_approval') {
    return NextResponse.json({ error: 'not_pending_approval', current_status: plan.draft_status }, { status: 409 });
  }

  updatePlanStatus(plan_id, 'rejected');
  insertActivity({
    action_type: 'draft_rejected',
    source_id: null,
    details: { plan_id, title: plan.title },
  });

  return NextResponse.json({ plan_id, rejected: true });
}
