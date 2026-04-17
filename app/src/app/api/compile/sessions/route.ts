/**
 * GET /api/compile/sessions?limit=50&offset=0
 *
 * List compile sessions newest-first for the /sessions page.
 * Thin wrapper over listCompileSessions(); no mutation.
 *
 * Response: { items: CompileSessionSummary[], count: number, total: number }
 */
import { NextResponse } from 'next/server';
import { listCompileSessions } from '@/lib/db';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const rawLimit = parseInt(searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, MAX_LIMIT)
    : DEFAULT_LIMIT;

  const rawOffset = parseInt(searchParams.get('offset') ?? '', 10);
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

  const { items, total } = listCompileSessions(limit, offset);
  return NextResponse.json({ items, count: items.length, total });
}
