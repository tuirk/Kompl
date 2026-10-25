/**
 * Shared single-plan commit logic used by:
 *   - POST /api/drafts/[plan_id]/approve     (single approval)
 *   - POST /api/drafts/approve-all           (bulk approval)
 *   - (future) auto_approve='1' compile path could share this — currently
 *     compile/commit/route.ts has its own loop optimised for batched FTS5 + wikilinks.
 *
 * Implements the same outbox commit pattern (CLAUDE.md rule #5):
 *   Phase 2 (sync db.transaction): status + page check, then insertPage +
 *     setPendingContent + draft_rules marker + provenance + FTS5 +
 *     insertActivity + updatePlanStatus('committed').
 *   Phase 3a (awaited): flush pending_content to disk via /storage/write-page,
 *     then clear it compare-and-set (flushOutboxPage, as compile commit does).
 *   Phase 3b (fire-and-forget): syncPageWikilinks for [[Title]] resolution +
 *     vector upsert (3× retry → vector_backfill_queue fallback).
 *
 * Never throws — caller-side bulk loops rely on a Result return shape.
 *
 * A draft can wait for approval for days. Inside the transaction, approval
 * first checks that the page is still the one the draft was written
 * against (plan 1.8): an update draft's page has not been rewritten since
 * the draft read it, and a new page has not appeared meanwhile. Otherwise
 * it refuses with 409 and changes nothing; the draft stays pending.
 */

import { createHash } from 'node:crypto';
import {
  getDb,
  getPageByTitle,
  getSourcePage,
  getTopicPageByTitle,
  insertPage,
  logActivity,
  pageRewrittenSince,
  updatePlanStatus,
  setPendingContent,
  getPageTitleMap,
  backfillAliasCanonicalPageId,
  type PageRow,
} from './db';
import { copyPlanDraftRules, isDraftedPage, planDraftsFromScratch } from './draft-rules';
import { flushOutboxPage } from './outbox-flush';
import { recordNewDisputes } from './page-disputes';
import { pageTextVersionToken } from './page-rewrite';
import { contributingSourceIds, recordPageContributions } from './plan-provenance';
import { upsertVectorWithRetry } from './vector-upsert';
import { syncPageWikilinks } from './wikilinks';
import { extractFrontmatterField } from './yaml-frontmatter';

/** Why a draft no longer fits its page. */
export type StaleDraft = 'page_changed' | 'page_exists';

export const STALE_DRAFT_MESSAGES: Record<StaleDraft, string> = {
  page_changed:
    'This page changed after the draft was written, so approving the draft would overwrite those changes. ' +
    'Nothing was applied and the draft is kept. Reject it if it is no longer needed.',
  page_exists:
    'A page for this was added after the draft was written, so approving the draft would make a duplicate page. ' +
    'Nothing was applied and the draft is kept. Reject it if it is no longer needed.',
};

export type CommitPlanResult =
  | { ok: true; plan_id: string; page_id: string; title: string }
  | { ok: false; plan_id: string; error: string; status?: number; message?: string };

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
  created_at: string;
  base_version: string | null;
  used_source_ids: string | null;
}

/** The page types plan/route.ts finds by title with getTopicPageByTitle. */
const TOPIC_PAGE_TYPES = new Set(['entity', 'concept', 'comparison', 'overview']);

/**
 * Does the page still match the draft? Synchronous DB reads only: runs
 * inside the commit transaction (CLAUDE.md rule 5).
 *  - An update draft records the page's version when it read the page
 *    (page_plans.base_version, v30). A draft made before v30 counts the
 *    page as changed if it was rewritten after the plan was made.
 *  - A new page looks for its target the way plan/route.ts does: the
 *    source's own page for a source page, the entity, concept, comparison
 *    or overview page with its title for those (a source page with that
 *    title is not it).
 */
function staleDraft(plan: PlanRow, sourceIds: string[]): StaleDraft | null {
  if (plan.action === 'update' && plan.existing_page_id) {
    const changed =
      plan.base_version !== null
        ? pageTextVersionToken(plan.existing_page_id) !== plan.base_version
        : pageRewrittenSince(plan.existing_page_id, plan.created_at);
    return changed ? 'page_changed' : null;
  }
  if (plan.action !== 'create') return null;
  let target: PageRow | null;
  if (plan.page_type === 'source-summary' || plan.page_type === 'original-source') {
    target = sourceIds.length > 0 ? getSourcePage(sourceIds[0], plan.title) : null;
  } else if (TOPIC_PAGE_TYPES.has(plan.page_type)) {
    target = getTopicPageByTitle(plan.title);
  } else {
    // Any other type (a pending draft from the retired chat): any page with the title.
    target = getPageByTitle(plan.title);
  }
  return target ? 'page_exists' : null;
}

export async function commitSinglePlan(plan_id: string): Promise<CommitPlanResult> {
  const db = getDb();

  const plan = db
    .prepare(
      `SELECT plan_id, session_id, title, page_type, action,
              source_ids, existing_page_id, draft_content, draft_status, created_at,
              base_version, used_source_ids
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

  // Frontmatter extraction — scoped to the YAML envelope only so body
  // content (e.g. user-supplied chat questions in FAQ drafts) cannot inject
  // forged `category:` / `summary:` lines. See lib/yaml-frontmatter.ts.
  const category = extractFrontmatterField(markdown, 'category');
  const summary = extractFrontmatterField(markdown, 'summary');

  const expectedPath = `/data/pages/${page_id}.md.gz`;
  const contentHash = createHash('sha256').update(markdown).digest('hex');

  // Phase 2: sync transaction. Idempotency guard handles re-approval after a
  // prior crash that committed Phase 2 but died before Phase 3a flush, and
  // a second approval racing this one. The page check runs here too, so
  // nothing can change the page between the check and the write.
  let outcome: 'committed' | 'already_committed' | 'not_pending' | StaleDraft;
  try {
    outcome = db.transaction((): typeof outcome => {
      const current = db
        .prepare(`SELECT draft_status FROM page_plans WHERE plan_id = ?`)
        .get(plan_id) as { draft_status: string } | undefined;
      if (current?.draft_status === 'committed') return 'already_committed';
      if (current?.draft_status !== 'pending_approval') return 'not_pending';
      const stale = staleDraft(plan, sourceIds);
      if (stale) return stale;

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

      // Writing-rules marker (lib/draft-rules.ts): a page drafted from
      // scratch takes its draft's marker (NULL for a draft made before v0.4);
      // an update keeps the page's own.
      if (planDraftsFromScratch(plan) && isDraftedPage({ page_id, page_type: plan.page_type })) {
        copyPlanDraftRules(db, plan_id, page_id);
      }

      if (sourceIds.length > 0) {
        // The sources the draft's prompt carried, once per page, and
        // source_count from provenance — mirrors compile/commit
        // (lib/plan-provenance.ts).
        recordPageContributions(db, {
          page_id,
          source_ids: contributingSourceIds(sourceIds, plan.used_source_ids),
          content_hash: contentHash,
          contribution_type: plan.action === 'update' ? 'updated' : 'created',
        });
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
      return 'committed';
    })();
  } catch (txErr) {
    const msg = txErr instanceof Error ? txErr.message : String(txErr);
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'db_transaction_error', context: 'approve_plan', plan_id, page_id, error: msg }));
    return { ok: false, plan_id, error: `commit_failed: ${msg}`, status: 500 };
  }
  if (outcome === 'not_pending') {
    return { ok: false, plan_id, error: 'not_pending_approval', status: 409 };
  }
  if (outcome === 'page_changed' || outcome === 'page_exists') {
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'draft_approval_refused', plan_id, page_id, reason: outcome }));
    return { ok: false, plan_id, error: outcome, status: 409, message: STALE_DRAFT_MESSAGES[outcome] };
  }

  // Phase 3a: flush pending_content to disk, then clear it only while it
  // still holds the text written: another writer may have queued newer text
  // for this page during the write, and that must stay in the outbox.
  if (!(await flushOutboxPage(page_id))) {
    // DB commit succeeded — pending_content stays for the boot reconciler.
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'file_flush_failed', context: 'approve_plan', plan_id, page_id }));
  }

  // Phase 3b: wikilink injection (per-page; missing targets silently skipped).
  // Bulk approval flows resolve cross-draft links progressively as more pages land.
  try {
    syncPageWikilinks(db, page_id, markdown, getPageTitleMap());
  } catch (wikiErr) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'wikilink_sync_failed', context: 'approve_plan', plan_id, page_id, error: wikiErr instanceof Error ? wikiErr.message : String(wikiErr) }));
  }

  // Phase 3b: backfill alias canonical_page_id for entity + concept pages.
  // Parity with compile/commit so draft-approved pages also pin aliases,
  // which makes Layer 1 fuzzy in future sessions hit the fast path.
  if (plan.page_type === 'entity' || plan.page_type === 'concept') {
    try {
      backfillAliasCanonicalPageId(plan.title, page_id);
    } catch {
      // non-critical
    }
  }

  // Phase 3b: vector upsert (fire-and-forget, retried internally).
  void upsertVectorWithRetry(page_id, {
    title: plan.title,
    page_type: plan.page_type,
    category: category ?? '',
    source_count: sourceIds.length,
  });

  // Phase 3b: disputes the page records in its own text, for the activity
  // feed (lib/page-disputes.ts). Never throws.
  if (typeof markdown === 'string') recordNewDisputes({ page_id, title: plan.title }, markdown);

  return { ok: true, plan_id, page_id, title: plan.title };
}
