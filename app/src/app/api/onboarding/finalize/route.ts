/**
 * POST /api/onboarding/finalize
 *
 * Promotes staging rows into a real compile pipeline run. The work lives in
 * lib/finalize-session.ts, shared with POST /api/agent/sources:
 *   - Read included/pending staging rows for the session
 *   - Create compile_progress (creates the 'queued' row the orchestrator
 *     + reconciler + dashboard banner all observe)
 *   - Log an onboarding_confirmed activity row
 *   - Trigger n8n /webhook/session-compile which hits /api/compile/run
 *
 * 503 is returned on n8n trigger failure. The compile_progress row stays
 * 'queued' so the reconciler (markStaleSessionsFailed +
 * reconcileStuckCompileSessions) recovers it if this process dies before
 * the trigger POST.
 */

import { NextResponse } from 'next/server';
import { finalizeSession } from '@/lib/finalize-session';

export async function POST(request: Request) {
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
  if (typeof body.session_id !== 'string' || !body.session_id) {
    return NextResponse.json({ error: 'missing field: session_id' }, { status: 422 });
  }

  const result = await finalizeSession(body.session_id);
  return NextResponse.json(result.body, { status: result.status });
}
