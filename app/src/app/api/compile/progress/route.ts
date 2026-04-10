/**
 * GET /api/compile/progress?session_id=xxx
 *
 * Part 2c-ii — Progress polling endpoint.
 *
 * Returns the compile_progress row for a session with the steps JSON
 * parsed into an object. The onboarding progress page polls this every
 * 2 seconds while status is 'queued' or 'running'.
 *
 * Response shape:
 *   { session_id, status, current_step, steps, error, started_at, completed_at }
 *   where steps is an object: { extract: { status, detail? }, resolve: {...}, ... }
 *
 * Returns 404 { status: 'not_found' } if session_id not found.
 */
import { NextResponse } from 'next/server';
import { getCompileProgress } from '@/lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('session_id');
  if (!sessionId?.trim()) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }
  const row = getCompileProgress(sessionId);
  if (!row) {
    return NextResponse.json({ status: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({
    session_id: row.session_id,
    status: row.status,
    current_step: row.current_step,
    steps: JSON.parse(row.steps) as Record<string, { status: string; detail?: string }>,
    error: row.error,
    started_at: row.started_at,
    completed_at: row.completed_at,
  });
}
