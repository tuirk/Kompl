import { NextResponse } from 'next/server';
import { getWikiGraph } from '@/lib/db';

/** GET /api/wiki/graph — nodes + links for the force-directed graph view. */
export async function GET() {
  const data = getWikiGraph();
  return NextResponse.json(data);
}
