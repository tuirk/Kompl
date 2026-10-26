/**
 * Phase 3a of the outbox commit (CLAUDE.md rule 5) for the compile commit
 * route and draft approval (lib/approve-plan.ts): write a page's
 * pending_content to disk, then clear it.
 *
 * Another writer on the same page (approve, restore, recompile) can replace
 * pending_content while a flush is in flight, so both halves guard against
 * acting on stale text:
 *   - the text is re-read right before each write, never taken from a
 *     snapshot made before earlier awaits;
 *   - the outbox is cleared only if it still holds the text that was written
 *     (clearPendingContentIfUnchanged); newer text stays queued for its own
 *     writer, the next reconcile pass or the boot reconciler.
 * Rewriting identical text is harmless: write_page skips a page whose file
 * already holds it, so at-least-once flushing never churns the archives.
 */

import { clearPendingContentIfUnchanged, getPendingContent, getPendingFlushPages } from './db';
import { flushPendingPage } from './flush-pending';

/**
 * Flush one page's outbox. False only when a write was attempted and
 * failed; true when the text reached disk or nothing was pending (another
 * writer already flushed it).
 */
export async function flushOutboxPage(pageId: string): Promise<boolean> {
  const content = getPendingContent(pageId);
  if (content === null) return true;
  const result = await flushPendingPage(pageId, content);
  if (!result.ok) return false;
  clearPendingContentIfUnchanged(pageId, result.previousPath, content);
  return true;
}

/**
 * Re-attempt every pending flush in the wiki. Only failures on pages in
 * `scopePageIds` are counted, so a stranded row from another session or
 * commit path never fails the caller.
 */
export async function reconcileOutbox(scopePageIds: ReadonlySet<string>): Promise<number> {
  let remaining = 0;
  for (const { page_id } of getPendingFlushPages()) {
    const ok = await flushOutboxPage(page_id);
    if (!ok && scopePageIds.has(page_id)) remaining++;
  }
  return remaining;
}
