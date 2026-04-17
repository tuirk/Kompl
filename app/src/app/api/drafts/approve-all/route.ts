/**
 * POST /api/drafts/approve-all
 *
 * Bulk-approve every draft currently in 'pending_approval'. Optional
 * { session_id } body filters to a single compile session — recommended
 * default for OFF-mode usage so chat-save-draft drafts from older sessions
 * are not swept up accidentally.
 *
 * Each plan is committed via commitSinglePlan (same path as /approve).
 * Per-plan failures are isolated; the bulk loop continues. Returns aggregate
 * { approved, failed, errors[] }. Single-user scale: ~20 plans × ~200ms ≈ 4s.
 */

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { commitSinglePlan } from '@/lib/approve-plan';

interface BulkRequestBody {
  session_id?: string;
}

export async function POST(request: Request) {
  let body: BulkRequestBody = {};
  try {
    const text = await request.text();
    if (text.trim().length > 0) body = JSON.parse(text) as BulkRequestBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const db = getDb();
  const planIds = body.session_id
    ? (db
        .prepare(
          `SELECT plan_id FROM page_plans
            WHERE draft_status = 'pending_approval' AND session_id = ?
            ORDER BY created_at ASC`
        )
        .all(body.session_id) as Array<{ plan_id: string }>)
    : (db
        .prepare(
          `SELECT plan_id FROM page_plans
            WHERE draft_status = 'pending_approval'
            ORDER BY created_at ASC`
        )
        .all() as Array<{ plan_id: string }>);

  let approved = 0;
  let failed = 0;
  const errors: Array<{ plan_id: string; error: string }> = [];

  for (const { plan_id } of planIds) {
    const result = await commitSinglePlan(plan_id);
    if (result.ok) {
      approved++;
    } else {
      failed++;
      errors.push({ plan_id, error: result.error });
    }
  }

  return NextResponse.json({
    approved,
    failed,
    total: planIds.length,
    session_id: body.session_id ?? null,
    errors,
  });
}
