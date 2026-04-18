/**
 * POST /api/compile/retry
 *
 * Resets compile_progress for a session back to 'queued' and re-triggers
 * the n8n session-compile webhook. Called by the "Retry" button on the
 * progress UI when status = 'failed'.
 */
import { NextResponse } from 'next/server';
import { getCompileProgress, resetForRetry } from '@/lib/db';
import { triggerSessionCompile } from '@/lib/trigger-n8n';

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const { session_id } = rawBody as { session_id?: string };
  if (!session_id?.trim()) return NextResponse.json({ error: 'session_id required' }, { status: 400 });

  const progress = getCompileProgress(session_id);
  if (!progress) return NextResponse.json({ error: 'no_progress_record' }, { status: 404 });

  // Reset only failed/pending steps — preserve completed work so runCompilePipeline
  // can skip expensive steps (extract, draft) that already succeeded.
  resetForRetry(session_id);

  const trigger = await triggerSessionCompile(session_id);
  if (!trigger.ok) {
    const httpStatus = trigger.reason === 'n8n_timeout' ? 504 : 502;
    return NextResponse.json(
      { error: trigger.reason, upstream_status: trigger.upstreamStatus },
      { status: httpStatus }
    );
  }

  return NextResponse.json({ session_id, status: 'retrying' });
}
