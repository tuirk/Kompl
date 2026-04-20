import { NextResponse } from 'next/server';

import { deleteIngestFailure, logActivity } from '../../../../lib/db';
import { regenerateSavedLinksPage } from '../../../../lib/saved-links';

interface RouteContext {
  params: Promise<{ failure_id: string }>;
}

/**
 * DELETE /api/saved-links/[failure_id]
 *
 * Dismiss a single saved-link failure. Regenerates the saved-links page
 * (fire-and-forget) and logs a saved_link_dismissed activity row.
 */
export async function DELETE(_req: Request, context: RouteContext) {
  const { failure_id } = await context.params;
  const deleted = deleteIngestFailure(failure_id);
  if (!deleted) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  void regenerateSavedLinksPage().catch(() => {});
  logActivity('saved_link_dismissed', {
    source_id: null,
    details: { failure_id },
  });

  return NextResponse.json({ deleted: true });
}
