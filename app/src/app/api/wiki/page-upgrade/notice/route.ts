/**
 * The one-time notice after an upgrade that changed the writing rules
 * (components/PageUpgradeNotice, lib/writing-rules.ts).
 *
 * GET  → { show, count }: show is true while pages written under other rules
 *        wait for an update and the notice was not yet closed for the
 *        current rules. A fresh install starts with none, so it doesn't see
 *        the notice.
 * POST → { dismissed: true }: closing it (or following its link, or starting
 *        an update) records the current rules in
 *        page_upgrade_notice_dismissed, so it shows again only when a later
 *        release changes the rules.
 */

import { NextResponse } from 'next/server';

import { getSetting, setSetting } from '@/lib/db';
import { countUpgradeCandidates } from '@/lib/draft-rules';
import { PAGE_UPGRADE_NOTICE_DISMISSED } from '@/lib/page-upgrade-state';
import { CURRENT_DRAFT_RULES } from '@/lib/writing-rules';

export const dynamic = 'force-dynamic';

export function GET() {
  if (getSetting(PAGE_UPGRADE_NOTICE_DISMISSED) === CURRENT_DRAFT_RULES) {
    return NextResponse.json({ show: false, count: 0 });
  }
  const count = countUpgradeCandidates();
  return NextResponse.json({ show: count > 0, count });
}

export function POST() {
  setSetting(PAGE_UPGRADE_NOTICE_DISMISSED, CURRENT_DRAFT_RULES);
  return NextResponse.json({ dismissed: true });
}
