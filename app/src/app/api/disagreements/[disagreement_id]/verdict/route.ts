/**
 * POST /api/disagreements/[disagreement_id]/verdict — the owner confirms or
 * dismisses a disagreement Kompl recorded (lib/disagreements.ts), or takes
 * the verdict back. No compile or check ever overwrites it.
 *
 * Request:      { verdict: 'confirmed' | 'dismissed' | null }
 * Response 200: { disagreement_id, status, owner_verdict, owner_verdict_at }
 * Errors:       { error, message } — 400 invalid_json, 403 cross_site,
 *               404 not_found, 422 invalid_verdict
 */

import { NextResponse } from 'next/server';

import { setOwnerVerdict, type OwnerVerdict } from '../../../../../lib/disagreements';
import { CROSS_SITE_MESSAGE, isCrossSiteRequest } from '../../../../../lib/same-origin';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ disagreement_id: string }>;
}

const VERDICTS: ReadonlyArray<OwnerVerdict | null> = ['confirmed', 'dismissed', null];

export async function POST(request: Request, { params }: RouteContext) {
  if (isCrossSiteRequest(request)) {
    return NextResponse.json({ error: 'cross_site', message: CROSS_SITE_MESSAGE }, { status: 403 });
  }
  const { disagreement_id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json', message: 'Send a JSON body.' }, { status: 400 });
  }
  const verdict = body && typeof body === 'object' ? (body as { verdict?: unknown }).verdict : undefined;
  if (!VERDICTS.includes(verdict as OwnerVerdict | null)) {
    return NextResponse.json(
      { error: 'invalid_verdict', message: 'verdict must be "confirmed", "dismissed" or null.' },
      { status: 422 },
    );
  }
  const updated = setOwnerVerdict(disagreement_id, verdict as OwnerVerdict | null);
  if (!updated) {
    return NextResponse.json({ error: 'not_found', message: 'No such disagreement.' }, { status: 404 });
  }
  return NextResponse.json({
    disagreement_id: updated.disagreement_id,
    status: updated.status,
    owner_verdict: updated.owner_verdict,
    owner_verdict_at: updated.owner_verdict_at,
  });
}
