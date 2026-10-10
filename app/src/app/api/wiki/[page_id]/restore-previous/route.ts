/**
 * POST /api/wiki/[page_id]/restore-previous
 *
 * Put the page's previous version back (lib/redraft.ts). No LLM call. The
 * current version becomes the previous one, so a restore can be undone the
 * same way.
 *
 * Response 200: { page_id, status: 'restored', flushed }
 * Errors:       { error, message } — 400 invalid_page_id, 404 page_not_found |
 *               no_previous_version, 409 session_in_progress |
 *               page_action_in_progress | page_changed, 422 page_not_restorable
 */

import { NextResponse } from 'next/server';

import { RedraftError, restorePreviousVersion } from '../../../../../lib/redraft';
import { isSafeId } from '../../../../../lib/safe-paths';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ page_id: string }>;
}

export async function POST(_request: Request, { params }: RouteContext) {
  const { page_id } = await params;
  if (!isSafeId(page_id)) {
    return NextResponse.json({ error: 'invalid_page_id', message: 'Invalid page id.' }, { status: 400 });
  }
  try {
    return NextResponse.json(await restorePreviousVersion(page_id), { status: 200 });
  } catch (err) {
    if (err instanceof RedraftError) {
      return NextResponse.json({ error: err.code, message: err.message, ...err.extra }, { status: err.status });
    }
    console.error('[restore-previous]', page_id, err);
    return NextResponse.json({ error: 'restore_failed', message: 'The restore failed unexpectedly.' }, { status: 500 });
  }
}
