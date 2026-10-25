/**
 * POST /api/wiki/claim-check/stop — stop the running whole-wiki check before
 * its next batch (calls in flight finish and are saved) and disarm the
 * wiki_check_enabled flag (lib/claim-check/wiki-check.ts).
 *
 * Response: 200 { run } | 409 { error: 'not_running', message }
 */

import { NextResponse } from 'next/server';

import { requestWikiCheckStop } from '@/lib/claim-check/wiki-check';

export const dynamic = 'force-dynamic';

export function POST() {
  const run = requestWikiCheckStop();
  if (!run) {
    return NextResponse.json({ error: 'not_running', message: 'The wiki check is not running.' }, { status: 409 });
  }
  return NextResponse.json({ run }, { status: 200 });
}
