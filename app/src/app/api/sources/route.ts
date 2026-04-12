/**
 * GET /api/sources
 *
 * List sources with optional filtering and sorting.
 * Query params: status, source_type, sort_by, sort_order, limit, offset
 */

import { NextResponse } from 'next/server';
import { getAllSourcesWithPageCounts, getDb } from '../../../lib/db';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status') ?? undefined;
  const source_type = url.searchParams.get('source_type') ?? undefined;
  const sort_by = (url.searchParams.get('sort_by') ?? 'date_ingested') as 'date_ingested' | 'title' | 'source_type';
  const sort_order = (url.searchParams.get('sort_order') ?? 'desc') as 'asc' | 'desc';
  const limit = parseInt(url.searchParams.get('limit') ?? '200', 10);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  const withCounts = getAllSourcesWithPageCounts({ status, source_type, sort_by, sort_order, limit, offset });

  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n;

  return NextResponse.json({ sources: withCounts, total });
}
