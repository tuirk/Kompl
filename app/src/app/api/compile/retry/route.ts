/**
 * POST /api/compile/retry
 *
 * Resets compile_progress for a session back to 'queued' and re-triggers
 * the n8n session-compile webhook. Called by the "Retry" button on the
 * progress UI when status = 'failed'.
 */
import { NextResponse } from 'next/server';
import { getCompileProgress, resetForRetry } from '@/lib/db';

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL ?? 'http://n8n:5678/webhook';

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

  // Re-trigger n8n — best-effort, don't fail if n8n is down
  await fetch(`${N8N_WEBHOOK_URL}/session-compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});

  return NextResponse.json({ session_id, status: 'retrying' });
}
