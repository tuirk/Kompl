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

import {
  deleteSource,
  getSource,
  getPagesBySourceId,
  removeProvenanceForSource,
  archivePage,
  decrementPageSourceCount,
  setSourceStatus,
  insertActivity,
} from '../../../../lib/db';

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
  insertActivity({
    action_type: status === 'archived' ? 'source_archived' : 'source_unarchived',
    source_id,
    details: null,
  });

  return NextResponse.json({ source_id, status });
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const { source_id } = await params;
  if (!source_id) {
    return NextResponse.json({ error: 'source_id required' }, { status: 400 });
  }

  const source = getSource(source_id);
  if (!source) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Cascade: find affected pages, remove provenance, archive orphans or decrement count.
  const affectedPages = getPagesBySourceId(source_id);
  removeProvenanceForSource(source_id);

  for (const page of affectedPages) {
    if (page.source_count <= 1) {
      archivePage(page.page_id);
      insertActivity({
        action_type: 'page_archived',
        source_id: null,
        details: { page_id: page.page_id, reason: 'source_deleted' },
      });
    } else {
      decrementPageSourceCount(page.page_id);
    }
  }

  const filePath = deleteSource(source_id);
  if (filePath) {
    void fsPromises.unlink(filePath).catch(() => undefined);
  }

  // Fire-and-forget: delete from vector store (non-fatal).
  const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';
  for (const page of affectedPages) {
    if (page.source_count <= 1) {
      void fetch(`${NLP_SERVICE_URL}/vectors/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_id: page.page_id }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    }
  }

  insertActivity({
    action_type: 'source_deleted',
    source_id,
    details: { pages_affected: affectedPages.length },
  });

  return new NextResponse(null, { status: 204 });
}
