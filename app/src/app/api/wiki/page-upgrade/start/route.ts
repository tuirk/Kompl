/**
 * POST /api/wiki/page-upgrade/start — the user's confirmation: update the
 * pages written by an earlier version to the current writing rules
 * (lib/page-upgrade.ts). Arms the page_upgrade_enabled flag for this one run
 * and starts it in the background; poll GET /api/wiki/page-upgrade.
 *
 * Request:  { expected_pages: number, model: string } — the page count and
 *           model the confirmation showed. The run refuses if more pages
 *           need updating now, or the compile model changed, so it never
 *           does more than the user agreed to.
 * Response: 202 { run }
 * Errors:   { error, message, ... } — 400 invalid_body, 409 already_running |
 *           session_in_progress | model_changed | no_candidates |
 *           candidates_changed | upgrade_not_enabled, 503
 *           estimate_unavailable | usage_unavailable
 */

import { NextResponse } from 'next/server';

import { PageUpgradeError, startPageUpgrade } from '@/lib/page-upgrade';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body', message: 'Send JSON.' }, { status: 400 });
  }
  const { expected_pages, model } = (body ?? {}) as { expected_pages?: unknown; model?: unknown };
  if (typeof expected_pages !== 'number' || !Number.isInteger(expected_pages) || expected_pages < 1) {
    return NextResponse.json(
      { error: 'invalid_body', message: 'expected_pages must be the number of pages you confirmed.' },
      { status: 400 },
    );
  }
  if (typeof model !== 'string' || model.length === 0) {
    return NextResponse.json(
      { error: 'invalid_body', message: 'model must be the model you confirmed.' },
      { status: 400 },
    );
  }

  try {
    const { run } = await startPageUpgrade({ expectedPages: expected_pages, model });
    return NextResponse.json({ run }, { status: 202 });
  } catch (err) {
    if (err instanceof PageUpgradeError) {
      return NextResponse.json({ error: err.code, message: err.message, ...err.extra }, { status: err.status });
    }
    console.error('[page-upgrade] start failed', err);
    return NextResponse.json(
      { error: 'page_upgrade_start_failed', message: 'The update could not start.' },
      { status: 500 },
    );
  }
}
