/**
 * POST /api/onboarding/finalize
 *
 * Promotes staging rows into a real compile pipeline run. Mirror of the
 * legacy /api/onboarding/confirm for the staging-based flow:
 *   - Read included/pending staging rows for the session
 *   - Create compile_progress (creates the 'queued' row the orchestrator
 *     + reconciler + dashboard banner all observe)
 *   - Log an onboarding_confirmed activity row
 *   - Trigger n8n /webhook/session-compile which hits /api/compile/run
 *
 * 503 is returned on n8n trigger failure — same contract as /confirm so
 * the existing progress-page retry UX works unchanged. The compile_progress
 * row stays 'queued' so the reconciler (markStaleSessionsFailed +
 * reconcileStuckCompileSessions) recovers it if this process dies before
 * the trigger POST.
 */

import { NextResponse } from 'next/server';

import {
  createCompileProgress,
  getSetting,
  getStagingBySession,
  insertActivity,
  setSetting,
} from '../../../../lib/db';
import { triggerSessionCompile } from '@/lib/trigger-n8n';

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
  const session_id = body.session_id;

  const staged = getStagingBySession(session_id).filter(
    (s) => s.included && s.status === 'pending'
  );
  if (staged.length === 0) {
    return NextResponse.json(
      { error: 'no_items_staged', message: 'No included pending staging rows for this session.' },
      { status: 400 }
    );
  }

  // Mark first-time onboarding complete so dashboard redirect stops sending
  // the user back to /onboarding. Matches the behaviour of /confirm.
  if (!getSetting('onboarding_completed')) {
    setSetting('onboarding_completed', '1');
  }

  // Create the compile_progress row BEFORE the n8n trigger so a POST failure
  // still leaves a row for the reconciler to find. Same ordering as /confirm.
  createCompileProgress(session_id, staged.length);
  insertActivity({
    action_type: 'onboarding_confirmed',
    source_id: null,
    details: { session_id, queued: staged.length, deleted: 0 },
  });

  const trigger = await triggerSessionCompile(session_id);
  if (!trigger.ok) {
    insertActivity({
      action_type: 'compile_trigger_failed',
      source_id: null,
      details: {
        session_id,
        reason: trigger.reason,
        upstream_status: trigger.upstreamStatus,
      },
    });
    return NextResponse.json(
      {
        error: trigger.reason,
        session_id,
        queued: staged.length,
        upstream_status: trigger.upstreamStatus,
      },
      { status: 503 }
    );
  }

  return NextResponse.json({ session_id, queued: staged.length }, { status: 200 });
}
