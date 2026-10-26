/**
 * POST /api/wiki/repair/start — the owner's confirmation: repair the wiki
 * (lib/wiki-repair/run.ts). Saves the backup first and refuses to start
 * when it can't; then arms the wiki_repair_enabled flag for this one run and
 * runs the other steps in the background. Poll GET /api/wiki/repair.
 *
 * Request:  { expected_aliases: number, expected_pages: number, model: string }
 *           — the name matches, the most pages and the model the plan
 *           showed; the run refuses if the plan grew or the model changed,
 *           so it never does more than the owner agreed to.
 * Response: 202 { run }
 * Errors:   { error, message, ... } — 400 invalid_body, 403 cross_site,
 *           409 already_running | session_in_progress |
 *           page_upgrade_in_progress | wiki_check_in_progress |
 *           model_changed | nothing_to_repair | plan_changed,
 *           500 backup_failed, 503 estimate_unavailable | usage_unavailable
 */

import { NextResponse } from 'next/server';

import { CROSS_SITE_MESSAGE, isCrossSiteRequest } from '@/lib/same-origin';
import { WikiRepairError, startWikiRepair } from '@/lib/wiki-repair/run';

export const dynamic = 'force-dynamic';

const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

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
  const { expected_aliases, expected_pages, model } = (body ?? {}) as Record<string, unknown>;
  if (!count(expected_aliases) || !count(expected_pages)) {
    return NextResponse.json(
      { error: 'invalid_body', message: 'expected_aliases and expected_pages must be the numbers you confirmed.' },
      { status: 400 },
    );
  }
  if (typeof model !== 'string' || model.length === 0) {
    return NextResponse.json({ error: 'invalid_body', message: 'model must be the model you confirmed.' }, { status: 400 });
  }

  try {
    const { run } = await startWikiRepair({ expectedAliases: expected_aliases, expectedPages: expected_pages, model });
    return NextResponse.json({ run }, { status: 202 });
  } catch (err) {
    if (err instanceof WikiRepairError) {
      return NextResponse.json({ error: err.code, message: err.message, ...err.extra }, { status: err.status });
    }
    console.error('[wiki-repair] start failed', err);
    return NextResponse.json({ error: 'wiki_repair_start_failed', message: 'The repair could not start.' }, { status: 500 });
  }
}
