/**
 * GET /api/sources
 *
 * List sources with optional filtering and sorting.
 * Query params: status, source_type, date_from, date_to, search, sort_by, sort_order, limit, offset
 */

import { NextResponse } from 'next/server';
import { getAllSourcesWithPageCounts } from '../../../lib/db';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status') ?? undefined;
  const source_type = url.searchParams.get('source_type') ?? undefined;
  const dateFrom = url.searchParams.get('date_from') ?? undefined;
  const dateTo = url.searchParams.get('date_to') ?? undefined;
  const search = url.searchParams.get('search') ?? undefined;
  const sort_by = (url.searchParams.get('sort_by') ?? 'date_ingested') as 'date_ingested' | 'title' | 'source_type';
  const sort_order = (url.searchParams.get('sort_order') ?? 'desc') as 'asc' | 'desc';
  const limit = parseInt(url.searchParams.get('limit') ?? '200', 10);
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  const sources = getAllSourcesWithPageCounts({ status, source_type, dateFrom, dateTo, search, sort_by, sort_order, limit, offset });

  return NextResponse.json({ sources, total: sources.length });
}
