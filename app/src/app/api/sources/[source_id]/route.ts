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
 * Two-tier cascade delete:
 *   - Pages with 0 or 1 remaining source → permanently deleted
 *   - Pages with 2+ remaining sources, deleted source < 500 chars → kept, provenance note
 *   - Pages with 2+ remaining sources, deleted source ≥ 500 chars → kept, rewritten
 *
 * PATCH /api/sources/[source_id]
 *
 * Archive or unarchive a source (status: 'active' | 'archived').
 */

import path from 'node:path';
import { promises as fsPromises } from 'fs';
import zlib from 'node:zlib';
import { NextResponse } from 'next/server';

import {
  DATA_ROOT,
  deleteSource,
  deletePage,
  getSource,
  getPage,
  getPagesBySourceId,
  removeProvenanceForSource,
  getProvenanceForPage,
  setPageSourceCount,
  readRawMarkdown,
  setSourceStatus,
  logActivity,
  cleanupPendingPlansForDeletedSource,
} from '../../../../lib/db';
import { recompilePage } from '../../../../lib/recompile';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';
const PAGES_DIR = path.join(DATA_ROOT, 'pages');

interface RouteContext {
  params: Promise<{ source_id: string }>;
}

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

async function deletePageFile(pageId: string): Promise<void> {
  const files = await fsPromises.readdir(PAGES_DIR).catch(() => [] as string[]);
  await Promise.all(
    files
      .filter((f) => f.startsWith(pageId))
      .map((f) => fsPromises.unlink(path.join(PAGES_DIR, f)).catch(() => {}))
  );
}

async function deleteFromVectorStore(pageId: string): Promise<void> {
  await fetch(`${NLP_SERVICE_URL}/vectors/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page_id: pageId }),
    signal: AbortSignal.timeout(10_000),
  });
}

/**
 * Append a provenance note to a page's gzipped markdown file.
 * Non-fatal: silently skips if the file is missing or unreadable.
 * The note is cleaned up on the next recompile (recompilePage generates fresh content).
 */
async function addProvenanceNote(contentPath: string | null, note: string): Promise<void> {
  if (!contentPath) return;
  const filePath = path.join(PAGES_DIR, path.basename(contentPath));
  try {
    const compressed = await fsPromises.readFile(filePath);
    const md = zlib.gunzipSync(compressed).toString('utf-8');
    const updated = md + `\n\n> _${note}_\n`;
    await fsPromises.writeFile(filePath, zlib.gzipSync(updated));
  } catch {
    // Non-fatal: page still intact, note just won't appear
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

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

  const source = getSource(source_id);
  if (!source) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Determine size tier BEFORE removing anything from the DB.
  const sourceContent = readRawMarkdown(source_id);
  const sourceChars = sourceContent?.length ?? 0;
  const isShortSource = sourceChars < 500;

  const affectedPages = getPagesBySourceId(source_id);

  // Remove provenance FIRST so recompilePage sees only remaining sources.
  removeProvenanceForSource(source_id);

  // Clean up orphaned pending_approval drafts that reference this source.
  // Multi-source plans get their source_ids array shrunk; single-source plans
  // are dropped. Without this, a stale draft can later be approved and UPSERT
  // a page back to life (zombie resurrection via commitSinglePlan).
  const planCleanup = cleanupPendingPlansForDeletedSource(source_id);
  if (planCleanup.rewritten > 0 || planCleanup.deleted > 0) {
    logActivity('pending_drafts_cleaned', {
      source_id,
      details: {
        title: source.title,
        rewritten: planCleanup.rewritten,
        deleted: planCleanup.deleted,
        reason: 'source_deleted',
      },
    });
  }

  const results = { pages_deleted: 0, pages_rewritten: 0, pages_archived: 0, pages_noted: 0 };
  const today = new Date().toISOString().split('T')[0];

  for (const page of affectedPages) {
    // Count remaining sources AFTER provenance removal.
    const remainingCount = getProvenanceForPage(page.page_id).length;

    if (remainingCount <= 1) {
      // 0 or 1 remaining — permanently delete the page.
      const chatCleanup = deletePage(page.page_id);
      void deleteFromVectorStore(page.page_id).catch(() => {});
      void deletePageFile(page.page_id).catch(() => {});
      logActivity('page_deleted', {
        source_id,
        details: {
          page_id: page.page_id,
          title: page.title,
          reason: remainingCount === 0 ? 'no_remaining_sources' : 'sole_remaining_source',
          remaining_sources: remainingCount,
        },
      });
      if (chatCleanup.chatDraftsRewritten > 0 || chatCleanup.chatDraftsDeleted > 0) {
        logActivity('chat_drafts_cleaned', {
          source_id: null,
          details: {
            page_id: page.page_id,
            page_title: page.title,
            rewritten: chatCleanup.chatDraftsRewritten,
            deleted: chatCleanup.chatDraftsDeleted,
            reason: 'page_deleted',
          },
        });
      }
      results.pages_deleted++;

    } else if (isShortSource) {
      // 2+ remaining, short source — no rewrite, just a provenance note.
      const fullPage = getPage(page.page_id);
      void addProvenanceNote(
        fullPage?.content_path ?? null,
        `Source "${source.title}" deleted on ${today}.`
      ).catch(() => {});
      setPageSourceCount(page.page_id, remainingCount);
      logActivity('page_provenance_updated', {
        source_id,
        details: {
          page_id: page.page_id,
          title: page.title,
          reason: 'short_source_deleted',
          source_chars: sourceChars,
          remaining_sources: remainingCount,
        },
      });
      results.pages_noted++;

    } else {
      // 2+ remaining, substantial source — rewrite from remaining sources.
      try {
        const { outcome } = await recompilePage(page.page_id, source_id);
        // recompilePage does not touch pages.source_count. Sync it here so the
        // wiki/graph stats reflect reality immediately, not on next session commit.
        setPageSourceCount(page.page_id, remainingCount);
        if (outcome === 'archived') {
          logActivity('page_archived', {
            source_id,
            details: {
              page_id: page.page_id,
              title: page.title,
              reason: 'source_deleted',
              source_chars: sourceChars,
              remaining_sources: remainingCount,
            },
          });
          results.pages_archived++;
        } else {
          logActivity('page_recompiled', {
            source_id,
            details: {
              page_id: page.page_id,
              title: page.title,
              reason: 'source_deleted',
              source_chars: sourceChars,
              remaining_sources: remainingCount,
            },
          });
          results.pages_rewritten++;
        }
      } catch (err) {
        // Rewrite failed — fall back to provenance note so delete still completes.
        const fullPage = getPage(page.page_id);
        void addProvenanceNote(
          fullPage?.content_path ?? null,
          `Source "${source.title}" deleted on ${today}. Rewrite failed.`
        ).catch(() => {});
        setPageSourceCount(page.page_id, remainingCount);
        logActivity('page_recompile_failed', {
          source_id,
          details: {
            page_id: page.page_id,
            title: page.title,
            error: String(err),
          },
        });
        results.pages_noted++;
      }
    }
  }

  // Delete source record (also deletes extractions via deleteSource).
  const rawFilePath = deleteSource(source_id);
  if (rawFilePath) void fsPromises.unlink(rawFilePath).catch(() => {});

  logActivity('source_deleted', {
    source_id,
    details: {
      title: source.title,
      source_chars: sourceChars,
      pages_affected: affectedPages.length,
      ...results,
    },
  });

  return NextResponse.json({ deleted: true, source_id, ...results });
}
