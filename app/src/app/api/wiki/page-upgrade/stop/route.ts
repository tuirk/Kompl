/**
 * POST /api/wiki/page-upgrade/stop — stop the running page update before
 * its next page (the page being updated finishes first) and disarm the
 * page_upgrade_enabled flag (lib/page-upgrade.ts).
 *
 * Response: 200 { run } | 409 { error: 'not_running', message }
 */

import { NextResponse } from 'next/server';

import { requestPageUpgradeStop } from '@/lib/page-upgrade';

export const dynamic = 'force-dynamic';

export function POST() {
  const run = requestPageUpgradeStop();
  if (!run) {
    return NextResponse.json({ error: 'not_running', message: 'No page update is running.' }, { status: 409 });
  }
  return NextResponse.json({ run }, { status: 200 });
}
