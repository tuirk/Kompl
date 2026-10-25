/**
 * POST /api/wiki/claim-check/start — the owner's confirmation: run the
 * whole-wiki check on the next claim pairs (lib/claim-check/wiki-check.ts).
 * Arms the wiki_check_enabled flag for this one run and starts it in the
 * background; poll GET /api/wiki/claim-check.
 *
 * Request:  { expected_pairs: number, model: string } — the pair count and
 *           model the confirmation showed. The run refuses if it would check
 *           more pairs now, or the compile model changed, so it never does
 *           more than the owner agreed to.
 * Response: 202 { run }
 * Errors:   { error, message, ... } — 400 invalid_body, 403 cross_site,
 *           409 already_running | session_in_progress |
 *           page_upgrade_in_progress | model_changed | no_pairs | pairs_changed
 */

import { NextResponse } from 'next/server';

import { startWikiCheck, WikiCheckError } from '@/lib/claim-check/wiki-check';
import { CROSS_SITE_MESSAGE, isCrossSiteRequest } from '@/lib/same-origin';

export const dynamic = 'force-dynamic';

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
  const { expected_pairs, model } = (body ?? {}) as { expected_pairs?: unknown; model?: unknown };
  if (typeof expected_pairs !== 'number' || !Number.isInteger(expected_pairs) || expected_pairs < 1) {
    return NextResponse.json(
      { error: 'invalid_body', message: 'expected_pairs must be the number of claim pairs you confirmed.' },
      { status: 400 },
    );
  }
  if (typeof model !== 'string' || model.length === 0) {
    return NextResponse.json({ error: 'invalid_body', message: 'model must be the model you confirmed.' }, { status: 400 });
  }

  try {
    const { run } = await startWikiCheck({ expectedPairs: expected_pairs, model });
    return NextResponse.json({ run }, { status: 202 });
  } catch (err) {
    if (err instanceof WikiCheckError) {
      return NextResponse.json({ error: err.code, message: err.message, ...err.extra }, { status: err.status });
    }
    console.error('[wiki-check] start failed', err);
    return NextResponse.json({ error: 'wiki_check_start_failed', message: 'The wiki check could not start.' }, { status: 500 });
  }
}
