/**
 * POST /api/onboarding/confirm
 *
 * Called when the user clicks "Build your wiki." Deletes unchecked sources
 * and transitions selected sources from 'collected' → 'pending' so the
 * compile drain picks them up.
 *
 * All DB mutations (deletes + pending update + activity log) are wrapped in
 * a single db.transaction() so a mid-operation crash cannot leave sources
 * in a broken state. File cleanup happens after the transaction (best-effort
 * — orphaned gzip files are harmless and will be overwritten on retry).
 *
 * No n8n trigger needed: the existing compile-drain.json polls for 'pending'
 * sources every 10s and will pick these up automatically.
 *
 * Request:
 *   {
 *     session_id: string;
 *     selected_source_ids: string[];
 *     deleted_source_ids: string[];
 *   }
 *
 * Response:
 *   { session_id: string; queued: number }
 */

import { promises as fsPromises } from 'fs';
import { NextResponse } from 'next/server';

import {
  deleteSource,
  getCollectedSources,
  getDb,
  getSetting,
  insertActivity,
  markSourcesPending,
  setSetting,
} from '../../../../lib/db';

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (typeof rawBody !== 'object' || rawBody === null) {
    return NextResponse.json({ error: 'body must be an object' }, { status: 422 });
  }

  const body = rawBody as Record<string, unknown>;

  if (typeof body.session_id !== 'string' || !body.session_id) {
    return NextResponse.json({ error: 'missing field: session_id' }, { status: 422 });
  }
  if (!Array.isArray(body.selected_source_ids)) {
    return NextResponse.json({ error: 'selected_source_ids must be an array' }, { status: 422 });
  }
  if (!Array.isArray(body.deleted_source_ids)) {
    return NextResponse.json({ error: 'deleted_source_ids must be an array' }, { status: 422 });
  }

  const { session_id } = body as { session_id: string };
  const selectedIds = body.selected_source_ids as string[];
  const deletedIds = body.deleted_source_ids as string[];

  // Validate that all provided IDs belong to this session.
  // Fetch collected sources once and build a set for O(1) lookup.
  const collectedSources = getCollectedSources(session_id);
  if (collectedSources.length === 0 && (selectedIds.length > 0 || deletedIds.length > 0)) {
    return NextResponse.json({ error: 'session_not_found_or_empty' }, { status: 404 });
  }

  const sessionSourceIds = new Set(collectedSources.map((s) => s.source_id));
  const allProvided = [...selectedIds, ...deletedIds];
  for (const id of allProvided) {
    if (!sessionSourceIds.has(id)) {
      return NextResponse.json(
        { error: `source_id ${id} does not belong to session ${session_id}` },
        { status: 422 }
      );
    }
  }

  const db = getDb();

  // All DB mutations in one transaction.
  // Returns file_paths of deleted sources for cleanup after commit.
  const txn = db.transaction((): string[] => {
    const filePaths: string[] = [];
    for (const id of deletedIds) {
      const fp = deleteSource(id);
      if (fp) filePaths.push(fp);
    }
    markSourcesPending(selectedIds);
    // Mark first-time onboarding complete so / redirects to /feed on next visit.
    if (!getSetting('onboarding_completed')) {
      setSetting('onboarding_completed', '1');
    }
    insertActivity({
      action_type: 'onboarding_confirmed',
      source_id: null,
      details: { session_id, queued: selectedIds.length, deleted: deletedIds.length },
    });
    return filePaths;
  });

  let filePaths: string[];
  try {
    filePaths = txn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    return NextResponse.json({ error: `commit_failed: ${msg}` }, { status: 500 });
  }

  // Best-effort file cleanup — orphaned gzip is harmless.
  void Promise.allSettled(filePaths.map((fp) => fsPromises.unlink(fp)));

  return NextResponse.json({ session_id, queued: selectedIds.length });
}
