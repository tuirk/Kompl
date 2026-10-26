/**
 * deleteOneSourceWithCascade — single source-delete unit of work, shared by
 * the per-id DELETE route and the bulk-delete route.
 *
 * Two-tier cascade for each affected page:
 *   - 0 or 1 remaining sources → permanently delete the page
 *   - 2+ remaining, deleted source < min_source_chars → keep, append provenance note
 *   - 2+ remaining, deleted source ≥ min_source_chars → keep, recompile from remaining;
 *     if that rewrite fails (after one retry of a temporary failure), archive
 *     the page until a rewrite succeeds (lib/page-hold.ts, issue #8)
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
 *   1. The source's provenance leaves each page only once that page is
 *      handled (removeSourceFromPage; a rewrite removes it in its own
 *      commit), and the source row goes last. getPagesBySourceId joins
 *      through provenance, so if the delete stops halfway (an app restart
 *      during its rewrites), deleting the source again finds the pages it
 *      had not reached. A delete that pruned first and stopped left them
 *      holding the material for good.
 *   2. entity_mentions and relationship_mentions reference source_id and are
 *      cleaned up by deleteSource. aliases reference page_id only — untouched
 *      here.
 *   3. logActivity writes are sync DB ops on the same connection but NOT
 *      wrapped in any transaction — matches the original handler semantics.
 *   4. In bulk context, batchSiblingIds names other sources being deleted in
 *      the same batch. Their provenance rows are subtracted from remainingCount
 *      so a page shared by N batch siblings gets deletePage'd once (by whichever
 *      sibling lands first), instead of N-1 wasted recompiles. A page that
 *      survives is rewritten without any batch sibling's text (invariant 5
 *      means no sibling rewrites it again).
 *   5. In bulk context, bulkState.handledPages records the terminal outcome of
 *      each affected page on first encounter. Subsequent siblings that touch
 *      the same surviving page mirror the recorded outcome into their per-source
 *      counts and skip the work — so a partial-survivor page (≥2 non-batch
 *      sources remain) is recompiled exactly once per bulk, not once per
 *      deleted sibling. First-sibling-wins: if siblings would land in different
 *      branches (one short, one long), the order in dedupedIds decides; revisit
 *      if mixed-length bulks surface user-visible surprises.
 *   6. No delete starts while a compile, the wiki repair or the page update
 *      runs (sourceDeleteBlock): they write the same pages. A compile that
 *      starts during a delete is guarded per page by the page lock and the
 *      version token in recompilePage.
 *   7. Deletes run one at a time (inSourceDeleteTurn; a bulk delete is one
 *      turn): each decides from the sources a page has left, and a delete
 *      running alongside would change them under it, e.g. rewrite a page
 *      from a source another delete has not yet removed from it.
 */

import path from 'node:path';
import { promises as fsPromises } from 'fs';

import {
  DATA_ROOT,
  cleanupPendingPlansForDeletedSource,
  deletePage,
  deleteSource,
  getDb,
  getMinSourceChars,
  getPagesBySourceId,
  getProvenanceForPage,
  getRunningCompileSession,
  getSource,
  logActivity,
  readPageMarkdown,
  readRawMarkdown,
  removeProvenanceForSource,
  removeSourceFromPage,
  setPageSourceCount,
} from './db';
import { recompilePage } from './recompile';
import { withPageLock } from './redraft';
import { commitPageRewrite, pageVersionToken } from './page-rewrite';
import { REWRITE_RETRY_DELAY_MS, holdPage, isRetryableRewriteError, rewriteFailedReason } from './page-hold';
import { isPageUpgradeRunning } from './page-upgrade-state';
import { isWikiRepairRunning } from './wiki-repair/state';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';
const PAGES_DIR = path.join(DATA_ROOT, 'pages');

export interface SourceDeleteCounts {
  pages_deleted: number;
  pages_rewritten: number;
  pages_archived: number;
  pages_noted: number;
  /** Archived until a rewrite succeeds: the rewrite from the remaining sources failed. */
  pages_hidden: number;
}

export type SourceDeleteResult =
  | ({ status: 'ok'; source_id: string } & SourceDeleteCounts)
  | { status: 'not_found'; source_id: string }
  | { status: 'error'; source_id: string; error: string };

type PageOutcome = 'deleted' | 'recompiled' | 'archived' | 'note_fallback' | 'hidden';

export interface BulkDeleteState {
  handledPages: Map<string, PageOutcome>;
  /** A retry failed during this bulk: later pages are not retried (lib/page-hold.ts). */
  retryFailed?: boolean;
}

export interface SourceDeleteBlock {
  error_code: 'session_in_progress' | 'wiki_repair_in_progress' | 'page_upgrade_in_progress';
  error: string;
}

/**
 * 409 body for the delete routes while a compile, the wiki repair or the
 * page update runs, or null. They rewrite the same pages as a delete does.
 */
export function sourceDeleteBlock(): SourceDeleteBlock | null {
  if (getRunningCompileSession()) {
    return {
      error_code: 'session_in_progress',
      error: 'A compile is running. Delete sources once it has finished, so the two don\'t rewrite the same pages.',
    };
  }
  if (isWikiRepairRunning()) {
    return {
      error_code: 'wiki_repair_in_progress',
      error: 'Kompl is repairing the wiki. Delete sources once the repair finishes, or stop it in Settings → Wiki health.',
    };
  }
  if (isPageUpgradeRunning()) {
    return {
      error_code: 'page_upgrade_in_progress',
      error: 'Kompl is updating pages. Delete sources once the update finishes, or stop it in Settings → Wiki health.',
    };
  }
  return null;
}

// On globalThis so dev-server reloads share one queue.
const deleteTurns: { tail: Promise<void> } = ((globalThis as { __komplSourceDeleteTurns?: { tail: Promise<void> } })
  .__komplSourceDeleteTurns ??= { tail: Promise.resolve() });

/**
 * Run `fn` once no other source delete is running (invariant 7), in the
 * order the deletes arrived. If a compile, the wiki repair or the page
 * update has started by then, `fn` does not run and the 409 body is
 * returned instead.
 */
export async function inSourceDeleteTurn<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; blocked: SourceDeleteBlock }> {
  const turn = deleteTurns.tail.then(async () => {
    const blocked = sourceDeleteBlock();
    if (blocked) return { ok: false as const, blocked };
    return { ok: true as const, value: await fn() };
  });
  deleteTurns.tail = turn.then(
    () => undefined,
    () => undefined,
  );
  return turn;
}

/** A rewrite that failed, and how many times it was tried. */
class RewriteFailure extends Error {
  constructor(readonly error: unknown, readonly attempts: number) {
    super(String(error));
  }
}

/**
 * recompilePage, tried once more after a temporary failure. Once a retry
 * has failed during this delete, later pages are not retried: the outage is
 * evident, and each retry would add its wait to the delete.
 */
async function recompileWithOneRetry(
  pageId: string,
  sourceId: string,
  batchSiblingIds: ReadonlySet<string>,
  retry: { retryFailed?: boolean },
): Promise<{ outcome: 'rewritten' | 'archived' }> {
  try {
    return await recompilePage(pageId, sourceId, batchSiblingIds);
  } catch (err) {
    if (retry.retryFailed || !isRetryableRewriteError(err)) throw new RewriteFailure(err, 1);
  }
  await new Promise((resolve) => setTimeout(resolve, REWRITE_RETRY_DELAY_MS));
  try {
    return await recompilePage(pageId, sourceId, batchSiblingIds);
  } catch (err) {
    retry.retryFailed = true;
    throw new RewriteFailure(err, 2);
  }
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

    // Invariant 1: the source's provenance leaves each page as it is handled.
    const affectedPages = getPagesBySourceId(sourceId);

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
      pages_hidden: 0,
    };
    const retry: { retryFailed?: boolean } = bulkState ?? {};
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
          case 'hidden':
            counts.pages_hidden++;
            break;
        }
        removeSourceFromPage(page.page_id, sourceId);
        continue;
      }

      // A source can hold several rows on a page; each remaining source counts once.
      const remainingSourceIds = [
        ...new Set(getProvenanceForPage(page.page_id).map((p) => p.source_id).filter((id) => id !== sourceId)),
      ];
      const remainingCount = remainingSourceIds.filter((id) => !batchSiblingIds.has(id)).length;
      const siblingsInBatch = remainingSourceIds.length - remainingCount;
      const baseDetails = {
        page_id: page.page_id,
        title: page.title,
        remaining_sources: remainingSourceIds.length,
        remaining_after_batch: remainingCount,
        siblings_in_batch: siblingsInBatch,
        ...(bulkId ? { bulk_id: bulkId } : {}),
      };

      if (remainingCount <= 1) {
        const reason =
          remainingCount === 0
            ? remainingSourceIds.length === 0
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
        await addProvenanceNote(page.page_id, `Source "${source.title}" deleted on ${today}.`);
        getDb().transaction(() => {
          removeSourceFromPage(page.page_id, sourceId);
          setPageSourceCount(page.page_id, remainingCount);
        })();
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
        let outcome: 'rewritten' | 'archived';
        try {
          ({ outcome } = await recompileWithOneRetry(page.page_id, sourceId, batchSiblingIds, retry));
        } catch (err) {
          // The page still holds the deleted source's material: archive it
          // until a rewrite succeeds, with the reason it shows under
          // "Show archived" (lib/page-hold.ts).
          const failure = err instanceof RewriteFailure ? err : new RewriteFailure(err, 1);
          getDb().transaction(() => {
            holdPage(page.page_id, rewriteFailedReason(source.title, today));
            removeSourceFromPage(page.page_id, sourceId);
            setPageSourceCount(page.page_id, remainingCount);
          })();
          logActivity('page_recompile_failed', {
            source_id: sourceId,
            details: { ...baseDetails, error: String(failure.error), attempts: failure.attempts, hidden: true },
          });
          counts.pages_hidden++;
          bulkState?.handledPages.set(page.page_id, 'hidden');
          continue;
        }
        // A rewrite removed the rows in its own commit; a page found with
        // no sources left (outcome 'archived') still has them.
        getDb().transaction(() => {
          removeSourceFromPage(page.page_id, sourceId);
          setPageSourceCount(page.page_id, remainingCount);
        })();
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
      }
    }

    // Rows that reached a page after it was listed (none, normally), so the
    // source row can go.
    removeProvenanceForSource(sourceId);
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

/**
 * Append the note through the normal page write (lib/page-rewrite.ts): the
 * outbox, the version token and nlp-service's atomic file write, which
 * archives the text it replaces. Rewriting the live .md.gz in place could
 * leave a half-written file that made the page fail to open.
 */
async function addProvenanceNote(pageId: string, note: string): Promise<void> {
  try {
    await withPageLock(pageId, async () => {
      const md = readPageMarkdown(pageId);
      if (md === null) return;
      await commitPageRewrite({
        pageId,
        markdown: md + `\n\n> _${note}_\n`,
        expectedToken: pageVersionToken(pageId),
        draftRules: null,
        activity: null,
      });
    });
  } catch {
    // Non-fatal: page still intact, note just won't appear.
  }
}
