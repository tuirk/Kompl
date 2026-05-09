/**
 * GET /api/compile/progress/events?session_id=X&step=Y&limit=N
 *
 * Activity-log tail filtered by (session_id, step_key) for the progress-page
 * expand-to-reveal UI. Most-recent-first; `limit` capped to [1, 200] in the
 * helper.
 *
 * Both filter columns added in migration v23. Pre-v23 rows have NULL
 * session_id/step_key and are deliberately not returned by getEventsForStep.
 */

import { NextResponse } from 'next/server';
import { getEventsForStep } from '../../../../../lib/db';

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const session_id = url.searchParams.get('session_id');
  const step = url.searchParams.get('step');
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? parseInt(limitRaw, 10) : 50;

  if (!session_id) {
    return NextResponse.json({ error: 'session_id_required' }, { status: 400 });
  }
  if (!step) {
    return NextResponse.json({ error: 'step_required' }, { status: 400 });
  }

  const events = getEventsForStep(session_id, step, isFinite(limit) ? limit : 50);

  // `details` is stored as JSON TEXT in activity_log; parse it on read so
  // clients get a proper object. Defensive on malformed JSON: skip parse,
  // pass the raw string through.
  const parsed = events.map((e) => ({
    ...e,
    details: typeof e.details === 'string'
      ? (() => { try { return JSON.parse(e.details as string); } catch { return e.details; } })()
      : e.details,
  }));

  return NextResponse.json({ session_id, step, events: parsed });
}
