/**
 * Shared single-plan commit logic used by:
 *   - POST /api/drafts/[plan_id]/approve     (single approval)
 *   - POST /api/drafts/approve-all           (bulk approval)
 *   - (future) auto_approve='1' compile path could share this — currently
 *     compile/commit/route.ts has its own loop optimised for batched FTS5 + wikilinks.
 *
 * Implements the same outbox commit pattern (CLAUDE.md rule #5):
 *   Phase 2 (sync db.transaction): insertPage + setPendingContent + insertProvenance
 *     + FTS5 + insertActivity + updatePlanStatus('committed').
 *   Phase 3a (awaited): flush pending_content to disk via /storage/write-page →
 *     clearPendingContent.
 *   Phase 3b (fire-and-forget): syncPageWikilinks for [[Title]] resolution +
 *     vector upsert (3× retry → vector_backfill_queue fallback).
 *
 * Never throws — caller-side bulk loops rely on a Result return shape.
 */

import { createHash } from 'node:crypto';
import {
  getDb,
  insertPage,
  insertProvenance,
  logActivity,
  updatePlanStatus,
  setPendingContent,
  clearPendingContent,
  getPageTitleMap,
} from './db';
import { upsertVectorWithRetry } from './vector-upsert';
import { syncPageWikilinks } from './wikilinks';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

export type CommitPlanResult =
  | { ok: true; plan_id: string; page_id: string; title: string }
  | { ok: false; plan_id: string; error: string; status?: number };

interface PlanRow {
  plan_id: string;
  session_id: string;
  title: string;
  page_type: string;
  action: string;
  source_ids: string;
  existing_page_id: string | null;
  draft_content: string | null;
  draft_status: string;
}

export async function commitSinglePlan(plan_id: string): Promise<CommitPlanResult> {
  const db = getDb();

  const plan = db
    .prepare(
      `SELECT plan_id, session_id, title, page_type, action,
              source_ids, existing_page_id, draft_content, draft_status, created_at
         FROM page_plans WHERE plan_id = ?`
    )
    .get(plan_id) as PlanRow | undefined;

  if (!plan) return { ok: false, plan_id, error: 'not_found', status: 404 };
  if (plan.draft_status !== 'pending_approval') {
    return { ok: false, plan_id, error: `not_pending_approval (current: ${plan.draft_status})`, status: 409 };
  }
  if (!plan.draft_content) return { ok: false, plan_id, error: 'no_draft_content', status: 422 };

  const markdown = plan.draft_content;
  const sourceIds: string[] = JSON.parse(plan.source_ids);

  // Determine page_id (mirrors compile/commit/route.ts page_id generation).
  let page_id: string;
  if (plan.action === 'update' && plan.existing_page_id) {
    page_id = plan.existing_page_id;
  } else {
    const suffix = plan.plan_id.replace(/-/g, '').slice(0, 8);
    const base = plan.title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 56)
      .replace(/^-+|-+$/g, '');
    page_id = `${base || 'page'}-${suffix}`;
  }

  // Frontmatter extraction — narrow regex (matches commit/route.ts).
  const categoryMatch = markdown.match(/^category:[ \t]*["']?(.+?)["']?[ \t]*$/m);
  const summaryMatch = markdown.match(/^summary:[ \t]*["']?(.+?)["']?[ \t]*$/m);
  const category = categoryMatch?.[1]?.trim() ?? null;
  const summary = summaryMatch?.[1]?.trim() ?? null;

  const expectedPath = `/data/pages/${page_id}.md.gz`;
  const contentHash = createHash('sha256').update(markdown).digest('hex');

  // Phase 2: sync transaction. Idempotency guard handles re-approval after a
  // prior crash that committed Phase 2 but died before Phase 3a flush.
  try {
    db.transaction(() => {
      const current = db
        .prepare(`SELECT draft_status FROM page_plans WHERE plan_id = ?`)
        .get(plan_id) as { draft_status: string } | undefined;
      if (current?.draft_status === 'committed') return;

      insertPage({
        page_id,
        title: plan.title,
        page_type: plan.page_type,
        category,
        summary,
        content_path: expectedPath,
        previous_content_path: null,
      });

      setPendingContent(page_id, markdown);

      if (sourceIds.length > 0) {
        db.prepare('UPDATE pages SET source_count = ? WHERE page_id = ?').run(sourceIds.length, page_id);
        const contribType = plan.action === 'update' ? 'updated' : 'created';
        for (const sid of sourceIds) {
          insertProvenance({ source_id: sid, page_id, content_hash: contentHash, contribution_type: contribType });
        }
      }

      // FTS5 upsert — strip frontmatter so YAML keys don't pollute the index.
      const fmMatch = markdown.match(/^---\n[\s\S]*?\n---\n?/);
      const ftsBody = fmMatch ? markdown.slice(fmMatch[0].length).trim() : markdown.trim();
      db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(page_id);
      db.prepare('INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)').run(
        page_id,
        plan.title,
        ftsBody
      );

      logActivity('draft_approved', {
        source_id: sourceIds[0] ?? null,
        details: { page_id, title: plan.title, plan_id },
      });

      updatePlanStatus(plan_id, 'committed');
    })();
  } catch (txErr) {
    const msg = txErr instanceof Error ? txErr.message : String(txErr);
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'db_transaction_error', context: 'approve_plan', plan_id, page_id, error: msg }));
    return { ok: false, plan_id, error: `commit_failed: ${msg}`, status: 500 };
  }

  // Phase 3a: flush pending_content to disk.
  const pageRow = db
    .prepare('SELECT pending_content FROM pages WHERE page_id = ?')
    .get(page_id) as { pending_content: string | null } | undefined;

  if (pageRow?.pending_content) {
    try {
      const res = await fetch(`${NLP_SERVICE_URL}/storage/write-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_id, markdown: pageRow.pending_content }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`write_page_failed: ${res.status}`);
      const wr = (await res.json()) as { current_path: string; previous_path: string | null };
      clearPendingContent(page_id, wr.previous_path);
    } catch (flushErr) {
      const msg = flushErr instanceof Error ? flushErr.message : String(flushErr);
      console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'file_flush_failed', context: 'approve_plan', plan_id, page_id, error: msg }));
      // DB commit succeeded — pending_content stays for boot reconciler.
    }
  }

  // Phase 3b: wikilink injection (per-page; missing targets silently skipped).
  // Bulk approval flows resolve cross-draft links progressively as more pages land.
  try {
    syncPageWikilinks(db, page_id, markdown, getPageTitleMap());
  } catch (wikiErr) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'wikilink_sync_failed', context: 'approve_plan', plan_id, page_id, error: wikiErr instanceof Error ? wikiErr.message : String(wikiErr) }));
  }

  // Phase 3b: vector upsert (fire-and-forget, retried internally).
  void upsertVectorWithRetry(page_id, {
    title: plan.title,
    page_type: plan.page_type,
    category: category ?? '',
    source_count: sourceIds.length,
  });

  return { ok: true, plan_id, page_id, title: plan.title };
}
