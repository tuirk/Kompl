/**
 * POST /api/wiki/repair/stop — stop the running wiki repair before its next
 * AI call (one in flight finishes and is kept) and disarm the
 * wiki_repair_enabled flag (lib/wiki-repair/run.ts).
 *
 * Response: 200 { run } | 409 { error: 'not_running', message }
 */

import { NextResponse } from 'next/server';

import { requestWikiRepairStop } from '@/lib/wiki-repair/run';

export const dynamic = 'force-dynamic';

export function POST() {
  const run = requestWikiRepairStop();
  if (!run) {
    return NextResponse.json({ error: 'not_running', message: 'No repair is running.' }, { status: 409 });
  }
  return NextResponse.json({ run }, { status: 200 });
}
