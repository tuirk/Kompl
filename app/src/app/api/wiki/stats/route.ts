/**
 * GET /api/wiki/stats
 *
 * Single-shot snapshot of the knowledge base (WikiStats: source/page/entity/
 * concept counts, last ingest and compile times) for scripts and lightweight
 * client UI. Kept as a stable read-only endpoint after the in-app chat (its
 * original consumer) was retired.
 */

import { NextResponse } from 'next/server';
import { getWikiStats } from '@/lib/db';

export function GET() {
  return NextResponse.json(getWikiStats());
}
