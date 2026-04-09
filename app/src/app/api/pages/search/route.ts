import { NextResponse } from 'next/server';
import { searchPages } from '@/lib/db';

/** GET /api/pages/search?q=<query>[&limit=N] */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get('q') ?? '').trim();
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 100);

  if (!q) {
    return NextResponse.json({ items: [], count: 0 });
  }

  try {
    const items = searchPages(q, limit);
    return NextResponse.json({ items, count: items.length });
  } catch {
    // FTS5 syntax error (malformed query) — return empty rather than 500
    return NextResponse.json({ items: [], count: 0 });
  }
}
