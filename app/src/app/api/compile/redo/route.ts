/**
 * Redo part of the last compile (GitHub #140, lib/compile-redo/).
 *
 * GET  /api/compile/redo?session_id=X
 *        → { available, reason, message, redo } — whether this compile can be
 *          redone now, and its current or last redo (redo is null when the
 *          saved redo belongs to another compile). Reads only.
 * GET  /api/compile/redo?session_id=X&point=plan|write|save
 *        → RedoPreview: what the redo would do and cost (FR-4). Reads only.
 * POST /api/compile/redo  { session_id, point, expected_pages, model }
 *        — the owner's confirmation of the numbers shown; refuses when the
 *          plan grew or the model changed (FR-5). 202 { redo }.
 * Errors: { error, message } — 400 invalid_body, 403 cross_site, 404
 *         no_progress_record, 409 not_latest | compile_running |
 *         still_stopping | wiki_repair_in_progress | page_upgrade_in_progress |
 *         wiki_check_in_progress | model_changed | plan_changed |
 *         nothing_to_redo | too_large | already_starting, 502/504 n8n,
 *         503 estimate_unavailable.
 */

import { NextResponse } from 'next/server';

import { CROSS_SITE_MESSAGE, isCrossSiteRequest } from '@/lib/same-origin';
import { RedoError, previewRedo, redoRefusal, startRedo } from '@/lib/compile-redo/start';
import { REDO_POINTS, readRedo, type RedoPoint } from '@/lib/compile-redo/state';

export const dynamic = 'force-dynamic';

const REFUSAL_TEXT: Record<string, string> = {
  no_progress_record: 'This compile was not found.',
  not_latest: 'Only the most recent compile can be redone.',
  compile_running: 'Available once the compile finishes.',
  still_stopping: 'This compile is still stopping. Try again in a minute.',
  wiki_repair_in_progress: 'Available once the wiki repair finishes.',
  page_upgrade_in_progress: 'Available once the page update finishes.',
  wiki_check_in_progress: 'Available once the whole-wiki check finishes.',
};

const isPoint = (v: unknown): v is RedoPoint => typeof v === 'string' && (REDO_POINTS as readonly string[]).includes(v);

function errorResponse(err: unknown): NextResponse {
  if (err instanceof RedoError) {
    return NextResponse.json({ error: err.code, message: err.message, ...err.extra }, { status: err.status });
  }
  console.error('[compile-redo] failed', err);
  return NextResponse.json({ error: 'redo_failed', message: 'Something went wrong. Nothing was changed.' }, { status: 500 });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const sessionId = params.get('session_id')?.trim();
  if (!sessionId) return NextResponse.json({ error: 'invalid_body', message: 'session_id required' }, { status: 400 });
  const point = params.get('point');
  if (point !== null) {
    if (!isPoint(point)) return NextResponse.json({ error: 'invalid_body', message: 'point must be plan, write or save' }, { status: 400 });
    try {
      return NextResponse.json(await previewRedo(sessionId, point));
    } catch (err) {
      return errorResponse(err);
    }
  }
  const reason = redoRefusal(sessionId);
  const saved = readRedo();
  return NextResponse.json({
    available: reason === null,
    reason,
    message: reason ? REFUSAL_TEXT[reason] ?? null : null,
    redo: saved?.session_id === sessionId ? saved : null,
  });
}

export async function POST(request: Request) {
  // Starts paid work: never from another site.
  if (isCrossSiteRequest(request)) {
    return NextResponse.json({ error: 'cross_site', message: CROSS_SITE_MESSAGE }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body', message: 'Send JSON.' }, { status: 400 });
  }
  const { session_id, point, expected_pages, model } = (body ?? {}) as Record<string, unknown>;
  if (typeof session_id !== 'string' || !session_id.trim() || !isPoint(point)) {
    return NextResponse.json({ error: 'invalid_body', message: 'session_id and point (plan, write or save) are required.' }, { status: 400 });
  }
  if (typeof expected_pages !== 'number' || !Number.isInteger(expected_pages) || expected_pages < 0) {
    return NextResponse.json({ error: 'invalid_body', message: 'expected_pages must be the number you confirmed.' }, { status: 400 });
  }
  if (typeof model !== 'string' || !model) {
    return NextResponse.json({ error: 'invalid_body', message: 'model must be the model you confirmed.' }, { status: 400 });
  }
  try {
    const redo = await startRedo({ sessionId: session_id, point, expectedPages: expected_pages, model });
    return NextResponse.json({ redo }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
