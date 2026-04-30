/**
 * POST /api/sources/bulk-delete
 *
 * Delete multiple sources in one request. The bulk path exists primarily to
 * eliminate the wasted-recompile race documented in issue #46: with parallel
 * single-source DELETEs, every handler reads `remainingCount` after only its
 * own provenance prune, so N-1 of them recompile pages that are about to be
 * deleted by the next handler.
 *
 * The fix lives in lib/source-delete.ts: the per-source helper accepts a
 * `batchSiblingIds` set and excludes those sources from `remainingCount`,
 * so a page shared by N batch siblings is deletePage'd once instead of
 * recompiled N-1 times.
 *
 * Request body: { ids: string[] }
 *   - ids: array of source_ids. 1..MAX_IDS entries. Duplicates silently deduped.
 *   - any other top-level field → 400.
 *
 * Response (always 200): {
 *   bulk_id: string,
 *   count: number,
 *   summary: { ok: number, not_found: number, error: number },
 *   results: SourceDeleteResult[],
 * }
 *
 * Partial failure is communicated via per-result status, not via HTTP code.
 * The frontend reads `results` and rolls back only the entries with status='error'.
 */

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import {
  deleteOneSourceWithCascade,
  type SourceDeleteResult,
} from '../../../../lib/source-delete';

const MAX_IDS = 100;

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!rawBody || typeof rawBody !== 'object') {
    return NextResponse.json({ error: 'body must be a JSON object' }, { status: 400 });
  }

  const body = rawBody as Record<string, unknown>;
  const { ids } = body;
  if (!Array.isArray(ids)) {
    return NextResponse.json({ error: 'ids must be an array of strings' }, { status: 400 });
  }
  const cleanIds = ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (cleanIds.length === 0) {
    return NextResponse.json({ error: 'ids array cannot be empty' }, { status: 400 });
  }
  if (cleanIds.length > MAX_IDS) {
    return NextResponse.json(
      { error: `ids exceeds cap of ${MAX_IDS}`, cap: MAX_IDS },
      { status: 400 },
    );
  }

  const dedupedIds = Array.from(new Set(cleanIds));
  const batchSiblingIds: ReadonlySet<string> = new Set(dedupedIds);
  const bulkId = randomUUID();

  const results: SourceDeleteResult[] = [];
  for (const id of dedupedIds) {
    results.push(await deleteOneSourceWithCascade(id, batchSiblingIds, bulkId));
  }

  const summary = results.reduce(
    (acc, r) => {
      if (r.status === 'ok') acc.ok++;
      else if (r.status === 'not_found') acc.not_found++;
      else acc.error++;
      return acc;
    },
    { ok: 0, not_found: 0, error: 0 },
  );

  return NextResponse.json({
    bulk_id: bulkId,
    count: dedupedIds.length,
    summary,
    results,
  });
}
