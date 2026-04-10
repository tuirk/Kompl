/**
 * GET /api/sources
 *
 * List sources with optional filtering and sorting.
 * Query params: status, source_type, sort_by, sort_order, limit, offset
 */

import { NextResponse } from 'next/server';
import { getAllSources, getDb } from '../../../lib/db';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status') ?? undefined;
  const source_type = url.searchParams.get('source_type') ?? undefined;
  const sort_by = (url.searchParams.get('sort_by') ?? 'date_ingested') as 'date_ingested' | 'title' | 'source_type';
  const sort_order = (url.searchParams.get('sort_order') ?? 'desc') as 'asc' | 'desc';
  const limit = parseInt(url.searchParams.get('limit') ?? '200', 10);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  const sources = getAllSources({ status, source_type, sort_by, sort_order, limit, offset });

  // Enrich each source with page_count from provenance
  const db = getDb();
  const withCounts = sources.map((s) => {
    const row = db
      .prepare('SELECT COUNT(DISTINCT page_id) AS n FROM provenance WHERE source_id = ?')
      .get(s.source_id) as { n: number };
    return { ...s, page_count: row.n };
  });

  const total = (db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n;

  return NextResponse.json({ sources: withCounts, total });
}
