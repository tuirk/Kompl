import { NextResponse } from 'next/server';
import { getIngestFailures } from '../../../../lib/db';

/**
 * GET /api/sources/failures
 *
 * Returns all rows from ingest_failures, unresolved first.
 * Used by the integration test and the Saved Links wiki page generator.
 *
 * Response: { items: IngestFailureRow[], count: number }
 */
export async function GET() {
  const items = getIngestFailures();
  return NextResponse.json({ items, count: items.length });
}
