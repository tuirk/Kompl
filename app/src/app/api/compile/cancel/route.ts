/**
 * POST /api/compile/cancel
 *
 * Flips compile_progress.status to 'cancelled' so runCompilePipeline exits
 * at the next step boundary. Rejects with 409 if the pipeline is mid-commit
 * (Pass 5 is a synchronous better-sqlite3 transaction — mid-transaction abort
 * corrupts the DB).
 */
import { NextResponse } from 'next/server';
import { cancelCompileProgress, getCompileProgress, logActivity } from '@/lib/db';

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

  if (progress.status !== 'queued' && progress.status !== 'running') {
    return NextResponse.json(
      { error: 'not_cancellable', status: progress.status },
      { status: 409 }
    );
  }

  const steps = JSON.parse(progress.steps) as Record<string, { status: string }>;
  const commitStatus = steps.commit?.status;
  if (commitStatus === 'running' || commitStatus === 'done') {
    // Once the Pass 5 transaction has started, pages are persisted and a
    // follow-up completeCompileProgress() would race with our status flip.
    // Treat as "too late to cancel" — the session will land in 'completed'
    // within ~1s once schema finishes.
    return NextResponse.json(
      { error: 'commit_in_progress', message: 'Finalizing — cancel is no longer possible.' },
      { status: 409 }
    );
  }

  cancelCompileProgress(session_id, 'Cancelled by user');
  logActivity('compile_cancelled', {
    source_id: null,
    details: { session_id, current_step: progress.current_step },
  });

  return NextResponse.json({ session_id, status: 'cancelled' });
}
