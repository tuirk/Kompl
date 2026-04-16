/**
 * POST /api/sources/[source_id]/recompile
 *
 * Manual re-trigger for a stuck or failed source. Resets the source's
 * compile_status back to 'pending' and fires the session-compile pipeline.
 *
 * All sources go through the session pipeline. Sources without an
 * onboarding_session_id cannot be recompiled (return 422).
 *
 * Guards:
 *   404 — source not found
 *   409 — source is already active (nothing to do)
 *   422 — source has no session (legacy standalone, cannot recompile)
 *
 * Request:  (no body required)
 * Response: { source_id, session_id: string|null, status: 'queued' }
 */

import { NextResponse } from 'next/server';
import {
  getSource,
  resetSourceForRecompile,
  createCompileProgress,
  insertActivity,
} from '@/lib/db';

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL ?? 'http://n8n:5678/webhook';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ source_id: string }> }
) {
  const { source_id } = await params;

  const source = getSource(source_id);
  if (!source) {
    return NextResponse.json({ error: 'source_not_found' }, { status: 404 });
  }
  if (source.compile_status === 'active') {
    return NextResponse.json({ error: 'source_already_compiled' }, { status: 409 });
  }

  // Reset compile_status so the pipeline picks it up again
  resetSourceForRecompile(source_id);

  insertActivity({
    action_type: 'source_recompile_triggered',
    source_id,
    details: { title: source.title },
  });

  const sessionId = source.onboarding_session_id ?? null;

  if (!sessionId) {
    return NextResponse.json(
      { error: 'no_session: source has no onboarding session and cannot be recompiled' },
      { status: 422 }
    );
  }

  // Reset progress record + trigger the session-compile pipeline via n8n
  createCompileProgress(sessionId, 1);
  await fetch(`${N8N_WEBHOOK_URL}/session-compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(10_000),
  }).catch((err: unknown) => {
    insertActivity({
      action_type: 'compile_trigger_failed',
      source_id,
      details: { event: 'session-compile', error: err instanceof Error ? err.message : 'timeout' },
    });
  });

  return NextResponse.json({ source_id, session_id: sessionId, status: 'queued' });
}
