/**
 * GET /api/onboarding/staging?session_id=X
 *
 * Powers the pre-ingestion review page. Returns all staging rows for a
 * session grouped by connector, with totals for the UI's counters.
 *
 * Response:
 *   {
 *     session_id: string;
 *     groups: {
 *       url:         StagingRow[];
 *       'file-upload': StagingRow[];
 *       text:        StagingRow[];
 *       'saved-link':  StagingRow[];
 *     };
 *     totals: {
 *       total: number;
 *       included: number;
 *       by_connector: Record<connector, number>;
 *     };
 *   }
 *
 * StagingRow's payload is parsed JSON — the review page renders from
 * payload.display (hostname, filename, size, excerpt) without needing
 * to re-parse URLs or restat files.
 */

import { NextResponse } from 'next/server';

import { getStagingBySession, type StagingConnector, type StagingRow } from '../../../../lib/db';

const CONNECTORS: readonly StagingConnector[] = [
  'url',
  'file-upload',
  'text',
  'saved-link',
] as const;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const session_id = url.searchParams.get('session_id');

  if (!session_id) {
    return NextResponse.json({ error: 'missing query param: session_id' }, { status: 422 });
  }

  const rows = getStagingBySession(session_id);

  const groups: Record<StagingConnector, StagingRow[]> = {
    url: [],
    'file-upload': [],
    text: [],
    'saved-link': [],
  };
  const by_connector: Record<StagingConnector, number> = {
    url: 0,
    'file-upload': 0,
    text: 0,
    'saved-link': 0,
  };
  let included = 0;

  for (const row of rows) {
    groups[row.connector].push(row);
    by_connector[row.connector]++;
    if (row.included) included++;
  }

  return NextResponse.json(
    {
      session_id,
      groups,
      totals: {
        total: rows.length,
        included,
        by_connector,
      },
    },
    { status: 200 }
  );
}
