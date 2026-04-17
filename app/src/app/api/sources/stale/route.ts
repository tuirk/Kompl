import { NextResponse } from 'next/server';
import { getStaleSources, getStaleThresholdDays } from '../../../../lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // Fall back to the user-configured setting when the caller omits ?days=.
  // getStaleThresholdDays() returns 90 when unset so existing behavior is preserved.
  const daysParam = searchParams.get('days');
  const days = daysParam !== null ? parseInt(daysParam, 10) : getStaleThresholdDays();
  if (isNaN(days) || days <= 0) {
    return NextResponse.json({ sources: [], count: 0 });
  }
  const sources = getStaleSources(days);
  return NextResponse.json({ sources, count: sources.length });
}
