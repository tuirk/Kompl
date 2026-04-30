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
 * Single-source cascade delete. Logic lives in lib/source-delete.ts and is
 * shared with the bulk endpoint. See that file for the cascade rules.
 *
 * PATCH /api/sources/[source_id]
 *
 * Archive or unarchive a source (status: 'active' | 'archived').
 */

import { NextResponse } from 'next/server';

import { getSource, logActivity, setSourceStatus } from '../../../../lib/db';
import { deleteOneSourceWithCascade } from '../../../../lib/source-delete';

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
    compile_status: row.compile_status,
    date_ingested: row.date_ingested,
    metadata,
  });
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const { source_id } = await params;
  if (!source_id) {
    return NextResponse.json({ error: 'source_id required' }, { status: 400 });
  }

  const body = (await request.json()) as { status?: string };
  const { status } = body;

  if (!status || !['active', 'archived'].includes(status)) {
    return NextResponse.json({ error: 'status must be active or archived' }, { status: 422 });
  }

  const existing = getSource(source_id);
  if (!existing) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  setSourceStatus(source_id, status as 'active' | 'archived');
  logActivity(status === 'archived' ? 'source_archived' : 'source_unarchived', {
    source_id,
    details: { title: existing.title },
  });

  return NextResponse.json({ source_id, status });
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { source_id } = await params;
  if (!source_id) {
    return NextResponse.json({ error: 'source_id required' }, { status: 400 });
  }

  const result = await deleteOneSourceWithCascade(source_id);
  if (result.status === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (result.status === 'error') {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({
    deleted: true,
    source_id: result.source_id,
    pages_deleted: result.pages_deleted,
    pages_rewritten: result.pages_rewritten,
    pages_archived: result.pages_archived,
    pages_noted: result.pages_noted,
  });
}
