/**
 * PATCH /api/onboarding/staging/[stage_id]
 *
 * Toggles the `included` flag on a single staging row. Called when the
 * user checks/unchecks an item on the review page. Durable (not just
 * client-side state) so a tab refresh preserves the selection.
 *
 * Request body: { included: boolean }
 * Response:     { stage_id: string; included: boolean }
 * 404 if the stage_id doesn't exist (defensive — prevents silent no-op).
 */

import { NextResponse } from 'next/server';

import { getStagingByStageId, updateStagingIncluded } from '../../../../../lib/db';

interface Context {
  params: Promise<{ stage_id: string }>;
}

export async function PATCH(request: Request, ctx: Context) {
  const { stage_id } = await ctx.params;
  if (!stage_id) {
    return NextResponse.json({ error: 'missing path param: stage_id' }, { status: 422 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (typeof rawBody !== 'object' || rawBody === null) {
    return NextResponse.json({ error: 'body must be an object' }, { status: 422 });
  }

  const body = rawBody as Record<string, unknown>;
  if (typeof body.included !== 'boolean') {
    return NextResponse.json({ error: 'included must be a boolean' }, { status: 422 });
  }

  const existing = getStagingByStageId(stage_id);
  if (!existing) {
    return NextResponse.json({ error: 'stage_id_not_found' }, { status: 404 });
  }

  updateStagingIncluded(stage_id, body.included);

  return NextResponse.json({ stage_id, included: body.included }, { status: 200 });
}
