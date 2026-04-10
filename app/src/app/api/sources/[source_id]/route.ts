/**
 * GET /api/sources/[source_id]
 *
 * Returns a single source row as JSON. Used by clients that want the
 * metadata without rendering the full page. The /source/[source_id]
 * server component reads directly from db.ts and does not call this
 * route, but it's here for completeness and for the integration test.
 *
 * DELETE /api/sources/[source_id]
 *
 * Removes the source row and best-effort unlinks the raw gzip file.
 * Used by the onboarding review screen to remove unchecked sources
 * individually (the bulk path goes through /api/onboarding/confirm).
 */

import { promises as fsPromises } from 'fs';
import { NextResponse } from 'next/server';

import { deleteSource, getSource, insertActivity } from '../../../../lib/db';

interface RouteContext {
  params: Promise<{ source_id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { source_id } = await params;
  if (!source_id) {
    return NextResponse.json({ error: 'source_id required' }, { status: 400 });
  }

  const row = getSource(source_id);
  if (!row) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Parse metadata JSON for the JSON response (db.ts keeps it as TEXT).
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }

  return NextResponse.json({
    source_id: row.source_id,
    title: row.title,
    source_type: row.source_type,
    source_url: row.source_url,
    content_hash: row.content_hash,
    file_path: row.file_path,
    status: row.status,
    date_ingested: row.date_ingested,
    metadata,
  });
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { source_id } = await params;
  if (!source_id) {
    return NextResponse.json({ error: 'source_id required' }, { status: 400 });
  }

  const filePath = deleteSource(source_id);
  if (filePath === null) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Best-effort file cleanup — orphaned gzip is harmless.
  void fsPromises.unlink(filePath).catch(() => undefined);

  insertActivity({ action_type: 'source_deleted', source_id, details: {} });

  return new NextResponse(null, { status: 204 });
}
