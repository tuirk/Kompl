import { NextResponse, type NextRequest } from 'next/server';

import {
  deleteIngestFailure,
  getUnresolvedLinks,
  logActivity,
} from '../../../lib/db';
import { regenerateSavedLinksPage } from '../../../lib/saved-links';

/**
 * GET /api/saved-links
 *
 * Returns unresolved ingest_failures rows (the Saved Links page data).
 * Response: { items: SavedLinkRow[], count: number }
 */
export async function GET() {
  const items = getUnresolvedLinks();
  return NextResponse.json({ items, count: items.length });
}

/**
 * DELETE /api/saved-links
 *
 * Bulk dismiss. Body: { failure_ids: string[] }.
 * One regenerate + one activity log for the whole batch.
 */
export async function DELETE(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { failure_ids?: unknown }
    | null;

  const ids = Array.isArray(body?.failure_ids)
    ? (body!.failure_ids as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];

  if (ids.length === 0) {
    return NextResponse.json(
      { error: 'failure_ids must be a non-empty string[]' },
      { status: 400 },
    );
  }

  let deleted = 0;
  for (const id of ids) {
    if (deleteIngestFailure(id)) deleted++;
  }

  if (deleted > 0) {
    void regenerateSavedLinksPage().catch(() => {});
    logActivity('saved_link_dismissed', {
      source_id: null,
      details: { count: deleted, failure_ids: ids },
    });
  }

  return NextResponse.json({ deleted });
}
