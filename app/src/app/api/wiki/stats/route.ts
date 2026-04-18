/**
 * GET /api/wiki/stats
 *
 * Returns the same WikiStats shape used internally by detectMetaQuery.
 * Exposed for the chat header stat bar and any lightweight client UI
 * that wants a single-shot snapshot of the knowledge base.
 */

import { NextResponse } from 'next/server';
import { getWikiStats } from '@/lib/db';

export function GET() {
  return NextResponse.json(getWikiStats());
}
