/**
 * Pages archived until a failed rewrite succeeds (issue #8).
 *
 * Deleting a source rewrites each page it shared with other sources from
 * what is left (lib/recompile.ts, called by lib/source-delete.ts). When that
 * rewrite fails, the page still holds the deleted source's material, so it
 * must not stay live: "can't rewrite it right now, hide it until we can".
 *
 *   - One more try first, only for failures that look temporary (rate
 *     limit, a model error, nlp-service unreachable) and only once per
 *     delete: after one failed retry, later pages skip theirs. A timeout
 *     (the draft call already waited ten minutes), the daily spending limit
 *     or sources that can't be read are not retried.
 *   - Then the page is archived the way every archived page is (page_type
 *     'archived', its search row removed), so it leaves the wiki list,
 *     search, related pages, the graph and the MCP tools, which all leave
 *     out archived pages. It stays readable under "Show archived", where
 *     the page says why (archive_reason).
 *   - pages.restore_page_type keeps the type it returns as. The next
 *     rewrite from its sources that succeeds restores it in the same
 *     transaction as the new text: the recompile of a later source delete,
 *     or the page update in Settings > Wiki health, which offers held pages
 *     whatever writing rules their text follows. Nothing runs on its own:
 *     rewriting costs an LLM call, so it is the owner's wiki-level choice.
 *
 * A page is held only while page_type is 'archived' and restore_page_type
 * is set; the columns are read only then. archivePage (no sources left)
 * clears them, so such a page is never offered back.
 *
 * Writes are synchronous DB statements. releaseHeldPage runs inside the
 * caller's Phase 2 transaction (CLAUDE.md rule 5).
 */

import type Database from 'better-sqlite3';

import { getDb } from './db';

/** How long to wait before the one retry of a temporary failure. */
export const REWRITE_RETRY_DELAY_MS = 15_000;

/** SQL: this pages row (alias p) is held. */
export const HELD_PAGE_SQL = "(p.page_type = 'archived' AND p.restore_page_type IS NOT NULL)";

/** SQL: the type the page is drafted as: its own, or the one a held page returns as. */
export const DRAFT_TYPE_SQL = "(CASE WHEN p.page_type = 'archived' THEN p.restore_page_type ELSE p.page_type END)";

/**
 * Worth one more try? recompilePage throws 'llm_rate_limited' (429),
 * 'draft_page_failed: <status> ...' and fetch's TypeError when nlp-service
 * can't be reached. A timeout, the spending limit (503 daily_cost_ceiling)
 * and anything about the sources themselves would fail the same way again.
 */
export function isRetryableRewriteError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return false;
  if (err instanceof TypeError) return true;
  return err.message === 'llm_rate_limited' || /^draft_page_failed: 5\d\d\b/.test(err.message);
}

/** The reason the page shows while it is held. */
export function rewriteFailedReason(sourceTitle: string, date: string): string {
  return `Kompl could not rewrite this page after the source "${sourceTitle}" was deleted on ${date}, so it may still contain material from that source.`;
}

/**
 * Archive a live page until it is rewritten. Returns false when the page
 * is missing or already archived (its type to restore, if any, is kept).
 */
export function holdPage(pageId: string, reason: string): boolean {
  const db = getDb();
  let held = false;
  db.transaction(() => {
    const info = db
      .prepare(
        `UPDATE pages
            SET restore_page_type = page_type,
                archive_reason    = ?,
                page_type         = 'archived'
          WHERE page_id = ? AND page_type != 'archived'`,
      )
      .run(reason, pageId);
    if (info.changes === 0) return;
    db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(pageId);
    held = true;
  })();
  return held;
}

/**
 * Phase 2 (inside the rewrite's transaction): a held page returns as its
 * own type. Returns that type, or null when the page was not held.
 */
export function releaseHeldPage(db: Database.Database, pageId: string): string | null {
  const row = db
    .prepare(`SELECT p.restore_page_type FROM pages p WHERE p.page_id = ? AND ${HELD_PAGE_SQL}`)
    .get(pageId) as { restore_page_type: string } | undefined;
  if (!row) return null;
  db.prepare(
    `UPDATE pages SET page_type = ?, restore_page_type = NULL, archive_reason = NULL WHERE page_id = ?`,
  ).run(row.restore_page_type, pageId);
  return row.restore_page_type;
}

export interface PageHold {
  restore_page_type: string;
  reason: string | null;
}

/** Why a page is held, or null when it is not. */
export function getPageHold(pageId: string): PageHold | null {
  const row = getDb()
    .prepare(`SELECT p.restore_page_type, p.archive_reason AS reason FROM pages p WHERE p.page_id = ? AND ${HELD_PAGE_SQL}`)
    .get(pageId) as PageHold | undefined;
  return row ?? null;
}

/**
 * restore_page_type and archive_reason of every page that has them, for the
 * .kompl backup (older releases' imports ignore the fields).
 */
export function getPageHoldColumns(): Map<string, { restore_page_type: string | null; archive_reason: string | null }> {
  const rows = getDb()
    .prepare(
      `SELECT page_id, restore_page_type, archive_reason FROM pages
        WHERE restore_page_type IS NOT NULL OR archive_reason IS NOT NULL`,
    )
    .all() as Array<{ page_id: string; restore_page_type: string | null; archive_reason: string | null }>;
  return new Map(rows.map(({ page_id, ...cols }) => [page_id, cols]));
}

/** Every held page, for the page update card's count. */
export function listHeldPageIds(): Set<string> {
  const rows = getDb().prepare(`SELECT p.page_id FROM pages p WHERE ${HELD_PAGE_SQL}`).all() as Array<{ page_id: string }>;
  return new Set(rows.map((r) => r.page_id));
}

/** The type a rewrite drafts the page as: a held page's own type, else its type. */
export function draftPageType(page: { page_id: string; page_type: string }): string {
  if (page.page_type !== 'archived') return page.page_type;
  return getPageHold(page.page_id)?.restore_page_type ?? page.page_type;
}
