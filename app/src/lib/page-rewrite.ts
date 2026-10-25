/**
 * Replace a page's content outside a compile session — a page update
 * (lib/redraft.ts, run from Settings > Wiki health) and "Restore previous
 * version".
 *
 * Follows the outbox rule (CLAUDE.md rule 5):
 *   Phase 2  (sync db.transaction, no await, no file I/O): version check,
 *            page row (with its draft_rules marker), pending_content, FTS,
 *            activity row
 *   Phase 3a (awaited): /storage/write-page — archives the current file as
 *            {page_id}.{timestamp}.md.gz — then clearPendingContent
 *   Phase 3c: page_links resync
 *   Phase 3b (fire-and-forget): vector refresh, retried like a compile's
 * If Phase 3a fails, pending_content stays set and the boot reconciler
 * (instrumentation.ts) flushes it on the next start; nothing is lost.
 */

import {
  clearPendingContent,
  getDb,
  getPage,
  getPageTitleMap,
  logActivity,
  setPendingContent,
} from './db';
import type { ActivityEventType } from './activity-events';
import { stripFrontmatter } from './markdown';
import { syncPageWikilinks } from './wikilinks';
import { extractFrontmatterField } from './yaml-frontmatter';
import { recordPageDisagreements } from './disagreements';
import { upsertVectorWithRetry } from './vector-upsert';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

/**
 * Changes whenever the page is rewritten or gains a source. Taken before a
 * slow step (an LLM call) and checked inside the commit transaction, so a
 * compile that touched the page meanwhile is never silently overwritten.
 */
export function pageVersionToken(pageId: string): string {
  const db = getDb();
  const page = db
    .prepare('SELECT last_updated, pending_content IS NOT NULL AS pending FROM pages WHERE page_id = ?')
    .get(pageId) as { last_updated: string | null; pending: number } | undefined;
  const prov = db
    .prepare('SELECT COUNT(*) AS n, MAX(id) AS max_id FROM provenance WHERE page_id = ?')
    .get(pageId) as { n: number; max_id: number | null };
  return JSON.stringify([page?.last_updated ?? null, page?.pending ?? null, prov.n, prov.max_id]);
}

/**
 * pageVersionToken for a draft waiting for approval (auto-approve off,
 * lib/approve-plan.ts), which can wait for days. It changes whenever the
 * page's text is rewritten: every rewrite bumps last_updated, and every
 * compile or approval that writes the page adds a 'created' or 'updated'
 * provenance row. It leaves out what does not touch the text the draft
 * updates: the outbox flag (the boot reconciler writing the file out) and
 * 'mentioned' rows (a source linked to the page without rewriting it).
 */
export function pageTextVersionToken(pageId: string): string {
  const db = getDb();
  const page = db
    .prepare('SELECT last_updated FROM pages WHERE page_id = ?')
    .get(pageId) as { last_updated: string | null } | undefined;
  const prov = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(id) AS max_id FROM provenance
        WHERE page_id = ? AND contribution_type != 'mentioned'`,
    )
    .get(pageId) as { n: number; max_id: number | null };
  return JSON.stringify([page?.last_updated ?? null, prov.n, prov.max_id]);
}

export type RewriteResult = { ok: true; flushed: boolean } | { ok: false; reason: 'page_changed' | 'page_not_found' };

async function writePageFile(pageId: string, markdown: string): Promise<{ previous_path: string | null }> {
  const res = await fetch(`${NLP_SERVICE_URL}/storage/write-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page_id: pageId, markdown }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`write_page_failed: ${res.status} ${await res.text().catch(() => '')}`);
  return (await res.json()) as { previous_path: string | null };
}

export async function commitPageRewrite(args: {
  pageId: string;
  markdown: string;
  expectedToken: string;
  /**
   * Writing rules the new text follows (pages.draft_rules, lib/draft-rules.ts):
   * the current rules for a page drafted from scratch; null keeps the page's
   * marker (a restore: the user chose that text, so a bulk update never
   * rewrites it on its own).
   */
  draftRules: string | null;
  activity: { type: ActivityEventType; details: Record<string, unknown> };
}): Promise<RewriteResult> {
  const { pageId, markdown, expectedToken, draftRules, activity } = args;
  const page = getPage(pageId);
  if (!page) return { ok: false, reason: 'page_not_found' };

  // A new summary replaces the old one; the category is only filled in when
  // the page has none, so an update never moves a page between categories.
  const summary = extractFrontmatterField(markdown, 'summary');
  const category = extractFrontmatterField(markdown, 'category');

  const db = getDb();
  // ── Phase 2: sync transaction ──
  const committed = db.transaction((): boolean => {
    if (pageVersionToken(pageId) !== expectedToken) return false;
    db.prepare(
      `UPDATE pages
          SET summary = COALESCE(?, summary),
              category = COALESCE(category, ?),
              draft_rules = COALESCE(?, draft_rules),
              last_updated = datetime('now')
        WHERE page_id = ?`,
    ).run(summary || null, category || null, draftRules, pageId);
    setPendingContent(pageId, markdown);
    db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(pageId);
    db.prepare('INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)').run(
      pageId,
      page.title,
      stripFrontmatter(markdown),
    );
    // Disagreements the committed text records (lib/disagreements.ts).
    recordPageDisagreements(db, { page_id: pageId, title: page.title }, markdown);
    logActivity(activity.type, { source_id: null, details: activity.details });
    return true;
  })();
  if (!committed) return { ok: false, reason: 'page_changed' };

  // ── Phase 3a: flush to disk (archives the previous version) ──
  let flushed = false;
  try {
    const written = await writePageFile(pageId, markdown);
    clearPendingContent(pageId, written.previous_path);
    flushed = true;
  } catch (err) {
    console.error('[page-rewrite] flush failed; the boot reconciler will retry', pageId, err);
  }

  // ── Phase 3c: links ──
  try {
    syncPageWikilinks(getDb(), pageId, markdown, getPageTitleMap());
  } catch (err) {
    console.error('[page-rewrite] page_links sync failed', pageId, err);
  }

  // ── Phase 3b: vectors (fire-and-forget; reads the flushed file) ──
  // Same retries as a compile, never throws. If the flush failed, the boot
  // reconciler refreshes the vector once it writes the file.
  if (flushed) {
    void upsertVectorWithRetry(pageId, {
      title: page.title,
      page_type: page.page_type,
      category: page.category ?? category ?? '',
      source_count: page.source_count,
    });
  }

  return { ok: true, flushed };
}
