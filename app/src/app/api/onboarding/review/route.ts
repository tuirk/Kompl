/**
 * GET /api/onboarding/review?session_id=<uuid>
 *
 * Returns all 'collected' sources for the given onboarding session,
 * grouped by source_type, with duplicate detection.
 *
 * A source is flagged as a duplicate if another source (with
 * compile_status != 'collected') has the same content_hash — meaning
 * this content was already compiled in a previous session.
 *
 * Response:
 *   {
 *     session_id: string;
 *     sources: Record<string, SourceRow[]>;  // keyed by source_type
 *     duplicate_source_ids: string[];
 *     total: number;
 *   }
 */

import { NextResponse } from 'next/server';

import { getCollectedSources, getDb } from '../../../../lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const session_id = searchParams.get('session_id');

  if (!session_id) {
    return NextResponse.json({ error: 'missing query param: session_id' }, { status: 400 });
  }

  const sources = getCollectedSources(session_id);

  // Group by source_type
  const grouped: Record<string, object[]> = {};
  for (const src of sources) {
    const key = src.source_type ?? 'unknown';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push({
      source_id: src.source_id,
      title: src.title,
      source_type: src.source_type,
      source_url: src.source_url,
      content_hash: src.content_hash,
      file_path: src.file_path,
      date_ingested: src.date_ingested,
      onboarding_session_id: src.onboarding_session_id,
    });
  }

  // Duplicate detection: find collected sources whose content_hash exists
  // in a non-collected source (already compiled content).
  const duplicateSourceIds: string[] = [];
  if (sources.length > 0) {
    const db = getDb();
    for (const src of sources) {
      const existing = db
        .prepare(
          `SELECT 1 FROM sources
            WHERE content_hash = ?
              AND compile_status != 'collected'
            LIMIT 1`
        )
        .get(src.content_hash) as { 1: number } | null;
      if (existing) duplicateSourceIds.push(src.source_id);
    }
  }

  return NextResponse.json({
    session_id,
    sources: grouped,
    duplicate_source_ids: duplicateSourceIds,
    total: sources.length,
  });
}
