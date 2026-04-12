/**
 * POST /api/sources/[source_id]/recompile
 *
 * Manual re-trigger for a stuck or failed source. Resets the source's
 * compile_status back to 'pending' and fires the appropriate compile workflow:
 *
 *   - Session source (has onboarding_session_id): resets compile_progress and
 *     triggers the full 8-step session-compile pipeline via n8n.
 *   - Standalone source (no session): triggers the single-source compile-source
 *     workflow via n8n (same path as the drain for non-onboarding sources).
 *
 * Guards:
 *   404 — source not found
 *   409 — source is already active (nothing to do)
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
  if (source.compile_status === 'active' || source.compile_status === 'compiled') {
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

  if (sessionId) {
    // Full session pipeline: reset progress record + trigger session-compile
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

  // Standalone source — trigger single-source compile workflow
  await fetch(`${N8N_WEBHOOK_URL}/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id }),
    signal: AbortSignal.timeout(10_000),
  }).catch((err: unknown) => {
    insertActivity({
      action_type: 'compile_trigger_failed',
      source_id,
      details: { event: 'compile', error: err instanceof Error ? err.message : 'timeout' },
    });
  });

  return NextResponse.json({ source_id, session_id: null, status: 'queued' });
}
