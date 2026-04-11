/**
 * GET /api/drafts/pending
 *
 * Returns all page_plans with draft_status = 'pending_approval'.
 * Used by the dashboard draft approval section.
 */

import { NextResponse } from 'next/server';
import { getPendingDrafts } from '../../../../lib/db';

export async function GET() {
  const drafts = getPendingDrafts().map((d) => ({
    plan_id: d.plan_id,
    session_id: d.session_id,
    title: d.title,
    page_type: d.page_type,
    action: d.action,
    draft_content_preview: d.draft_content ? d.draft_content.slice(0, 300) : null,
    draft_content: d.draft_content ?? null,
    created_at: d.created_at,
  }));
  return NextResponse.json({ drafts, total: drafts.length });
}
