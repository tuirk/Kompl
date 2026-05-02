/**
 * deleteOneSourceWithCascade — single source-delete unit of work, shared by
 * the per-id DELETE route and the bulk-delete route.
 *
 * Two-tier cascade for each affected page:
 *   - 0 or 1 remaining sources → permanently delete the page
 *   - 2+ remaining, deleted source < min_source_chars → keep, append provenance note
 *   - 2+ remaining, deleted source ≥ min_source_chars → keep, recompile from remaining
 *
 *   The "short source" threshold is the same `min_source_chars` Setting the
 *   compile pipeline reads at plan time (plan/route.ts), so the UI is the
 *   single source of truth. min_source_chars=0 disables the short-source
 *   short-circuit — every multi-source page recompiles on delete.
 *
 *   KNOWN: this reads the *current* setting at delete time, not the value in
 *   force when the source was ingested. A source ingested under setting=500
 *   that is later deleted under setting=800 takes the short branch even if
 *   compile originally treated it as substantial. Acceptable: the UI gesture
 *   is "this is what 'short' means now", and consistent live-setting reads
 *   beat snapshot semantics for a low-stakes cost decision (one Gemini call
 *   per page on the wrong branch).
 *
 * INVARIANTS (do not break):
 *   1. getPagesBySourceId MUST be called BEFORE removeProvenanceForSource —
 *      the underlying SQL joins through provenance (db.ts:2150) and returns
 *      [] post-prune.
 *   2. entity_mentions and relationship_mentions reference source_id and are
 *      cleaned up by deleteSource. aliases reference page_id only — untouched
 *      here.
 *   3. logActivity writes are sync DB ops on the same connection but NOT
 *      wrapped in any transaction — matches the original handler semantics.
 *   4. In bulk context, batchSiblingIds names other sources being deleted in
 *      the same batch. Their provenance rows are subtracted from remainingCount
 *      so a page shared by N batch siblings gets deletePage'd once (by whichever
 *      sibling lands first), instead of N-1 wasted recompiles.
 *   5. In bulk context, bulkState.handledPages records the terminal outcome of
 *      each affected page on first encounter. Subsequent siblings that touch
 *      the same surviving page mirror the recorded outcome into their per-source
 *      counts and skip the work — so a partial-survivor page (≥2 non-batch
 *      sources remain) is recompiled exactly once per bulk, not once per
 *      deleted sibling. First-sibling-wins: if siblings would land in different
 *      branches (one short, one long), the order in dedupedIds decides; revisit
 *      if mixed-length bulks surface user-visible surprises.
 */

import path from 'node:path';
import { promises as fsPromises } from 'fs';
import zlib from 'node:zlib';

import {
  DATA_ROOT,
  cleanupPendingPlansForDeletedSource,
  deletePage,
  deleteSource,
  getMinSourceChars,
  getPage,
  getPagesBySourceId,
  getProvenanceForPage,
  getSource,
  logActivity,
  readRawMarkdown,
  removeProvenanceForSource,
  setPageSourceCount,
} from './db';
import { recompilePage } from './recompile';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';
const PAGES_DIR = path.join(DATA_ROOT, 'pages');

export interface SourceDeleteCounts {
  pages_deleted: number;
  pages_rewritten: number;
  pages_archived: number;
  pages_noted: number;
}

export type SourceDeleteResult =
  | ({ status: 'ok'; source_id: string } & SourceDeleteCounts)
  | { status: 'not_found'; source_id: string }
  | { status: 'error'; source_id: string; error: string };

type PageOutcome = 'deleted' | 'recompiled' | 'archived' | 'note_fallback';

export interface BulkDeleteState {
  handledPages: Map<string, PageOutcome>;
}

export async function deleteOneSourceWithCascade(
  sourceId: string,
  batchSiblingIds: ReadonlySet<string> = new Set(),
  bulkId: string | null = null,
  bulkState?: BulkDeleteState,
): Promise<SourceDeleteResult> {
  const source = getSource(sourceId);
  if (!source) return { status: 'not_found', source_id: sourceId };

  try {
    const sourceContent = readRawMarkdown(sourceId);
    const sourceChars = sourceContent?.length ?? 0;
    const minSourceChars = getMinSourceChars();
    const isShortSource = minSourceChars > 0 && sourceChars < minSourceChars;

    // Invariant 1: enumerate BEFORE pruning provenance.
    const affectedPages = getPagesBySourceId(sourceId);

    removeProvenanceForSource(sourceId);

    const planCleanup = cleanupPendingPlansForDeletedSource(sourceId);
    if (planCleanup.rewritten > 0 || planCleanup.deleted > 0) {
      logActivity('pending_drafts_cleaned', {
        source_id: sourceId,
        details: {
          title: source.title,
          rewritten: planCleanup.rewritten,
          deleted: planCleanup.deleted,
          reason: 'source_deleted',
          ...(bulkId ? { bulk_id: bulkId } : {}),
        },
      });
    }

    const counts: SourceDeleteCounts = {
      pages_deleted: 0,
      pages_rewritten: 0,
      pages_archived: 0,
      pages_noted: 0,
    };
    const today = new Date().toISOString().split('T')[0];

    for (const page of affectedPages) {
      // Bulk dedup (invariant 5): if a sibling already handled this page in
      // this batch, mirror the recorded outcome into this source's counts and
      // skip the work — preserves the per-source `source_deleted` event shape
      // while ensuring page-level work and activity events fire exactly once.
      const recordedOutcome = bulkState?.handledPages.get(page.page_id);
      if (recordedOutcome) {
        switch (recordedOutcome) {
          case 'deleted':
            counts.pages_deleted++;
            break;
          case 'recompiled':
            counts.pages_rewritten++;
            break;
          case 'archived':
            counts.pages_archived++;
            break;
          case 'note_fallback':
            counts.pages_noted++;
            break;
        }
        continue;
      }

      const remainingProvenance = getProvenanceForPage(page.page_id);
      const remainingExcludingBatch = remainingProvenance.filter(
        (p) => !batchSiblingIds.has(p.source_id),
      );
      const remainingCount = remainingExcludingBatch.length;
      const siblingsInBatch = remainingProvenance.length - remainingCount;
      const baseDetails = {
        page_id: page.page_id,
        title: page.title,
        remaining_sources: remainingProvenance.length,
        remaining_after_batch: remainingCount,
        siblings_in_batch: siblingsInBatch,
        ...(bulkId ? { bulk_id: bulkId } : {}),
      };

      if (remainingCount <= 1) {
        const reason =
          remainingCount === 0
            ? remainingProvenance.length === 0
              ? 'no_remaining_sources'
              : 'all_remaining_in_batch'
            : 'sole_remaining_source';

        const chatCleanup = deletePage(page.page_id);
        void deleteFromVectorStore(page.page_id).catch(() => {});
        void deletePageFile(page.page_id).catch(() => {});
        logActivity('page_deleted', {
          source_id: sourceId,
          details: { ...baseDetails, reason },
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
              ...(bulkId ? { bulk_id: bulkId } : {}),
            },
          });
        }
        counts.pages_deleted++;
        bulkState?.handledPages.set(page.page_id, 'deleted');
      } else if (isShortSource) {
        const fullPage = getPage(page.page_id);
        void addProvenanceNote(
          fullPage?.content_path ?? null,
          `Source "${source.title}" deleted on ${today}.`,
        ).catch(() => {});
        setPageSourceCount(page.page_id, remainingCount);
        logActivity('page_provenance_updated', {
          source_id: sourceId,
          details: {
            ...baseDetails,
            reason: 'short_source_deleted',
            source_chars: sourceChars,
          },
        });
        counts.pages_noted++;
        bulkState?.handledPages.set(page.page_id, 'note_fallback');
      } else {
        try {
          const { outcome } = await recompilePage(page.page_id, sourceId);
          setPageSourceCount(page.page_id, remainingCount);
          if (outcome === 'archived') {
            logActivity('page_archived', {
              source_id: sourceId,
              details: { ...baseDetails, reason: 'source_deleted', source_chars: sourceChars },
            });
            counts.pages_archived++;
            bulkState?.handledPages.set(page.page_id, 'archived');
          } else {
            logActivity('page_recompiled', {
              source_id: sourceId,
              details: { ...baseDetails, reason: 'source_deleted', source_chars: sourceChars },
            });
            counts.pages_rewritten++;
            bulkState?.handledPages.set(page.page_id, 'recompiled');
          }
        } catch (err) {
          const fullPage = getPage(page.page_id);
          void addProvenanceNote(
            fullPage?.content_path ?? null,
            `Source "${source.title}" deleted on ${today}. Rewrite failed.`,
          ).catch(() => {});
          setPageSourceCount(page.page_id, remainingCount);
          logActivity('page_recompile_failed', {
            source_id: sourceId,
            details: { ...baseDetails, error: String(err) },
          });
          counts.pages_noted++;
          bulkState?.handledPages.set(page.page_id, 'note_fallback');
        }
      }
    }

    const rawFilePath = deleteSource(sourceId);
    if (rawFilePath) void fsPromises.unlink(rawFilePath).catch(() => {});

    logActivity('source_deleted', {
      source_id: sourceId,
      details: {
        title: source.title,
        source_chars: sourceChars,
        pages_affected: affectedPages.length,
        ...counts,
        ...(bulkId ? { bulk_id: bulkId } : {}),
      },
    });

    return { status: 'ok', source_id: sourceId, ...counts };
  } catch (err) {
    return { status: 'error', source_id: sourceId, error: String(err) };
  }
}

async function deletePageFile(pageId: string): Promise<void> {
  const files = await fsPromises.readdir(PAGES_DIR).catch(() => [] as string[]);
  await Promise.all(
    files
      .filter((f) => f.startsWith(pageId))
      .map((f) => fsPromises.unlink(path.join(PAGES_DIR, f)).catch(() => {})),
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

async function addProvenanceNote(contentPath: string | null, note: string): Promise<void> {
  if (!contentPath) return;
  const filePath = path.join(PAGES_DIR, path.basename(contentPath));
  try {
    const compressed = await fsPromises.readFile(filePath);
    const md = zlib.gunzipSync(compressed).toString('utf-8');
    const updated = md + `\n\n> _${note}_\n`;
    await fsPromises.writeFile(filePath, zlib.gzipSync(updated));
  } catch {
    // Non-fatal: page still intact, note just won't appear.
  }
}
