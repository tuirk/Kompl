/**
 * GET /api/sources
 *
 * List sources with optional filtering and sorting.
 * Query params: status, source_type, date_from, date_to, search, sort_by, sort_order, limit, offset
 */

import { NextResponse } from 'next/server';
import { countSourcesWithPageCounts, getAllSourcesWithPageCounts } from '../../../lib/db';

const VALID_SORT_BY = ['date_ingested', 'title', 'source_type'] as const;
const VALID_SORT_ORDER = ['asc', 'desc'] as const;
type SortBy = typeof VALID_SORT_BY[number];
type SortOrder = typeof VALID_SORT_ORDER[number];

export async function GET(request: Request) {
  const url = new URL(request.url);
  const status = url.searchParams.get('status') ?? undefined;
  const source_type = url.searchParams.get('source_type') ?? undefined;
  const dateFrom = url.searchParams.get('date_from') ?? undefined;
  const dateTo = url.searchParams.get('date_to') ?? undefined;
  const search = url.searchParams.get('search') ?? undefined;

  // Validate enum params against a whitelist — TS-only casts let
  // `?sort_by=garbage` through, which the DB layer then silently falls back.
  // Explicit check here makes the contract clear at the route boundary.
  const rawSortBy = url.searchParams.get('sort_by');
  const sort_by: SortBy = (VALID_SORT_BY as readonly string[]).includes(rawSortBy ?? '')
    ? (rawSortBy as SortBy)
    : 'date_ingested';
  const rawSortOrder = url.searchParams.get('sort_order');
  const sort_order: SortOrder = (VALID_SORT_ORDER as readonly string[]).includes(rawSortOrder ?? '')
    ? (rawSortOrder as SortOrder)
    : 'desc';

  // parseInt('abc') returns NaN, and NaN bound to SQLite throws. Coerce to
  // the default (via `|| N`) and clamp to a sane range so a caller asking for
  // limit=100000 doesn't pull the whole table.
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '200', 10) || 200, 1), 500);
  const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);

  const filterOptions = { status, source_type, dateFrom, dateTo, search, sort_by, sort_order, limit, offset };
  const sources = getAllSourcesWithPageCounts(filterOptions);
  // `total` is the pre-limit match count so the UI "X filtered" banner reflects
  // the real filter size. `returned` is the rows in this payload — for future
  // pagination UI that needs to distinguish shown vs matched.
  const total = countSourcesWithPageCounts(filterOptions);

  return NextResponse.json({ sources, total, returned: sources.length });
}
