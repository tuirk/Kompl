/**
 * POST /api/compile/commit
 *
 * Session-only commit. Implements the Pass-5 three-phase commit pattern
 * (CLAUDE.md rule #5) for session-based compilation.
 *
 * Rule #5 — three phases per page plan:
 *   Phase 2 (sync db.transaction()):
 *     - idempotency guard: the plan must still be 'crossreffed'
 *     - insertPage()
 *     - setPendingContent() (outbox — markdown stored for boot reconciler)
 *     - draft_rules marker copied from a from-scratch plan (lib/draft-rules.ts)
 *     - insertProvenance()
 *     - pages_fts upsert
 *     - insertActivity('page_compiled', ...)
 *     - updatePlanStatus('committed')
 *     NO await inside this callback — better-sqlite3 is sync-only.
 *   Phase 3a (awaited):
 *     - POST /storage/write-page → flush pending_content to disk
 *     - clear pending_content on success, only if it still holds the text
 *       written (lib/outbox-flush.ts)
 *   Phase 3b (fire-and-forget):
 *     - alias canonical backfill
 *     - Vector upsert (retried 3× before queuing for backfill)
 *   A provenance-only plan (a triage 'skip') changes no page text: its
 *   Phase 2 links the sources ('mentioned' rows, source_count recounted)
 *   and marks it committed; it has no Phase 3.
 *
 * Request:  { session_id: string }
 * Response: { session_id, committed, failed, thin_drafts_skipped,
 *             pages_created, pages_updated, sources_activated,
 *             wikilink_warnings, flush_failures }
 *
 * flush_failures counts pages whose DB rows committed but whose .md.gz file
 * could not be written even after the post-loop reconcile pass. Non-zero →
 * run/route.ts fails the session (never 'completed' with files missing).
 */

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';

import {
  getDb,
  getAutoApprove,
  logActivity,
  insertPage,
  insertProvenance,
  markSourcesActive,
  getCompileProgress,
  getExtractionsBySession,
  getMinDraftChars,
  getPagePlansByStatus,
  getPageTitleMap,
  updateCompileStep,
  updatePlanStatus,
  updatePlanFailed,
  getCurrentPageHash,
  getPage,
  linkSourcesToPage,
  setPendingContent,
  pruneDeletedPlanSources,
  backfillAliasCanonicalPageId,
} from '../../../../lib/db';
import { copyPlanDraftRules, isDraftedPage, planDraftsFromScratch } from '../../../../lib/draft-rules';
import { flushOutboxPage, reconcileOutbox } from '../../../../lib/outbox-flush';
import { recordNewDisputes } from '../../../../lib/page-disputes';
import { upsertVectorWithRetry } from '../../../../lib/vector-upsert';
import { syncPageWikilinks } from '../../../../lib/wikilinks';
import { extractFrontmatterField } from '../../../../lib/yaml-frontmatter';

// Derive the page_id a plan commits to. Single source of truth for the
// slug algorithm — used by the commit loop, the wikilink pass, and the
// durability scoping below. 'update' plans reuse the existing page;
// 'create' plans get a title slug + plan_id suffix.
function derivePlanPageId(plan: {
  plan_id: string;
  title: string;
  action: string;
  existing_page_id: string | null;
}): string {
  if (plan.action === 'update' && plan.existing_page_id) return plan.existing_page_id;
  const suffix = plan.plan_id.replace(/-/g, '').slice(0, 8);
  const base = plan.title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 56)
    .replace(/^-+|-+$/g, '');
  return `${base || 'page'}-${suffix}`;
}

// Page ids this session's committed content plans wrote (current run AND
// prior runs — plan rows keep draft_status='committed' across retries).
// Provenance-only plans never write files, so they are excluded.
function getSessionCommittedPageIds(session_id: string): Set<string> {
  return new Set(
    getPagePlansByStatus(session_id, 'committed')
      .filter((p) => p.action !== 'provenance-only')
      .map((p) => derivePlanPageId(p))
  );
}

// Durability reconcile pass — re-attempt Phase 3a for every page still
// holding pending_content (this session's flush failures AND any stranded
// rows from other commit paths — flushing them is idempotent, so we sweep
// globally as good citizenship). The returned count is SESSION-SCOPED:
// only pages this session committed gate its success, so a stranded row
// from another session/path can never false-fail this compile. The
// orchestrator fails the session on a non-zero count so 'completed'
// always means "all files durable" (CLAUDE.md rule #5). Runs on the
// empty-plans path too: a retry after a flush failure finds all plans
// already 'committed', so this pass is the only thing that recovers the
// stranded files without a server restart.
function reconcileSessionFlushes(session_id: string): Promise<number> {
  return reconcileOutbox(getSessionCommittedPageIds(session_id));
}

// Idempotency guard (CLAUDE.md rule 5), read inside each commit transaction.
// Two commits of one session can overlap: a run whose commit call timed out
// fails the session while the commit keeps going, and the retry starts a
// second one. Only the first to reach a plan may commit it; committing it
// twice doubled its provenance and activity rows.
function planStillCrossreffed(plan_id: string): boolean {
  const row = getDb()
    .prepare('SELECT draft_status FROM page_plans WHERE plan_id = ?')
    .get(plan_id) as { draft_status: string } | undefined;
  return row?.draft_status === 'crossreffed';
}

// Strip YAML frontmatter (--- ... ---) from the top of a markdown string.
// Used to measure actual content length before the thin-draft gate check.
function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? markdown.slice(match[0].length).trim() : markdown.trim();
}

// ── Session-based commit ──────────────────────────────────────────────────────
//
// Commits all crossreffed page_plans for a session. Each page gets its own
// db.transaction() — one failure does not abort others (failed → 'failed').
// After all pages: session sources → compile_status='active'.

async function commitSession(session_id: string): Promise<Response> {
  const db = getDb();
  const progress = getCompileProgress(session_id);
  if (!progress) {
    return NextResponse.json({ error: 'session_not_found' }, { status: 404 });
  }
  const plans = getPagePlansByStatus(session_id, 'crossreffed');

  if (plans.length === 0) {
    // Retry-after-flush-failure lands here (all plans already 'committed').
    // The reconcile pass is what actually re-flushes the stranded files.
    const flushFailures = await reconcileSessionFlushes(session_id);
    return NextResponse.json(
      { session_id, committed: 0, failed: 0, pages_created: 0, pages_updated: 0, sources_activated: 0, flush_failures: flushFailures },
      { status: 200 }
    );
  }

  // Guard: block commit if any non-provenance-only plan has null draft_content.
  // A page with NULL content would be committed as an empty wiki entry.
  const nullDraftPlans = plans.filter(
    (p) => p.action !== 'provenance-only' && !p.draft_content
  );
  if (nullDraftPlans.length > 0) {
    return NextResponse.json(
      {
        error: 'commit_blocked_null_drafts',
        count: nullDraftPlans.length,
        pages: nullDraftPlans.map((p) => p.plan_id),
      },
      { status: 422 }
    );
  }

  let committed = 0;
  let failed = 0;
  let pagesCreated = 0;
  let pagesUpdated = 0;
  let thinCount = 0;
  let pendingApproval = 0;
  const allSourceIds = new Set<string>();
  // Track page_ids that were actually committed so the wikilink pass below
  // can exclude thin-draft and failed plans (which were never inserted into pages).
  const committedPageIds = new Set<string>();

  const minDraftChars = getMinDraftChars();
  // OFF mode: when auto_approve='0', queue every content plan for manual approval
  // via /drafts. Provenance-only plans still auto-commit (zero content to review).
  // The approve route runs full Phase 2/3a/3b from scratch, so no draft state
  // is ever stranded.
  const autoApprove = getAutoApprove();

  // Build source title map once before the loop — used to enrich page_compiled events.
  const sourceTitleMap = new Map<string, string>(
    (db.prepare('SELECT source_id, title FROM sources').all() as Array<{ source_id: string; title: string }>)
      .map((r) => [r.source_id, r.title])
  );

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    // Live progress for the UI's "Finalizing" tracker — peer step pattern
    // to extract / ingest_* / match / crossref. Updates BEFORE the work
    // so the counter reflects "committing page i of N".
    updateCompileStep(
      session_id,
      'commit',
      'running',
      `${i}/${plans.length} pages committed`,
    );
    // Sources deleted while the session compiled are dropped here (a plan
    // left with none is deleted). No await between this and the plan's
    // transaction, so no delete can slip in between.
    const plannedSourceIds: string[] = JSON.parse(plan.source_ids);
    const sourceIds = pruneDeletedPlanSources(plan.plan_id, plannedSourceIds);
    if (sourceIds.length < plannedSourceIds.length) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'commit_deleted_sources_dropped', session_id, plan_id: plan.plan_id, dropped: plannedSourceIds.length - sourceIds.length, plan_dropped: sourceIds.length === 0 }));
      if (sourceIds.length === 0) continue;
    }
    sourceIds.forEach((s) => allSourceIds.add(s));

    if (plan.action === 'provenance-only') {
      // A triage 'skip' verdict (plan Rule 6) links the source to a page
      // whose text stays as it is. No draft, so no approval even with
      // auto-approve off, and no file to write: this transaction is the
      // whole commit (rule 5 Phase 2; nothing for Phase 3).
      try {
        const existingPageId = plan.existing_page_id;
        // Sync file read of the page's current text, before the transaction.
        const pageHash = existingPageId ? getCurrentPageHash(existingPageId) : '';
        const outcome = db.transaction((): 'linked' | 'taken' | 'page_gone' => {
          if (!planStillCrossreffed(plan.plan_id)) return 'taken';
          if (!existingPageId || !getPage(existingPageId)) {
            // The page was deleted while the session compiled: nothing to link.
            db.prepare('DELETE FROM page_plans WHERE plan_id = ?').run(plan.plan_id);
            return 'page_gone';
          }
          linkSourcesToPage(existingPageId, sourceIds, pageHash);
          updatePlanStatus(plan.plan_id, 'committed');
          return 'linked';
        })();
        if (outcome === 'linked') committed++;
        if (outcome === 'page_gone') {
          console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'commit_deleted_page_dropped', session_id, plan_id: plan.plan_id, page_id: existingPageId }));
        }
      } catch (txErr) {
        const txMsg = txErr instanceof Error ? txErr.message : String(txErr);
        console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'db_transaction_error', context: 'provenance_only_commit', plan_id: plan.plan_id, session_id, error: txMsg }));
        updatePlanFailed(plan.plan_id, `db_transaction_error (provenance_only_commit): ${txMsg}`);
        failed++;
      }
      continue;
    }

    const markdown = plan.draft_content;
    if (!markdown) {
      updatePlanFailed(plan.plan_id, 'missing draft_content (commit ran on a plan with no drafted markdown)');
      failed++;
      continue;
    }

    // Gate 2: thin-draft check. Strip frontmatter before measuring so that
    // a page with only YAML and no body doesn't pass on character count alone.
    // 'original-source' pages are intentional raw passthroughs of sub-min_source_chars
    // content; Gate 2 targets thin LLM drafts, so exempt this type.
    if (minDraftChars > 0 && plan.page_type !== 'original-source') {
      const bodyLength = stripFrontmatter(markdown).length;
      if (bodyLength < minDraftChars) {
        updatePlanStatus(plan.plan_id, 'draft_too_thin');
        logActivity('draft_too_thin', {
          source_id: sourceIds[0] ?? null,
          session_id,
          step_key: 'commit',
          details: {
            plan_id: plan.plan_id,
            title: plan.title,
            page_type: plan.page_type,
            session_id,
            chars: bodyLength,
            threshold: minDraftChars,
          },
        });
        thinCount++;
        continue;
      }
    }

    // OFF mode short-circuit: queue for manual review, skip Phase 2/3a/3b.
    // Approve route will run insertPage / write-page / vector upsert from scratch.
    if (!autoApprove) {
      updatePlanStatus(plan.plan_id, 'pending_approval');
      logActivity('draft_queued_for_approval', {
        source_id: sourceIds[0] ?? null,
        session_id,
        step_key: 'commit',
        details: { plan_id: plan.plan_id, title: plan.title, page_type: plan.page_type, session_id },
      });
      pendingApproval++;
      continue;
    }

    const page_id = derivePlanPageId(plan);

    // Extract frontmatter fields (category, summary) from YAML envelope only.
    // Scoping to the `---\n...\n---` block prevents body content (which can
    // include user-controlled text) from injecting forged metadata via lines
    // that look like `category: forged`. See lib/yaml-frontmatter.ts.
    const category = extractFrontmatterField(markdown, 'category');
    const summary = extractFrontmatterField(markdown, 'summary');

    // Deterministic path — known before the file is written (page_id is fixed).
    const expectedPath = `/data/pages/${page_id}.md.gz`;

    // Compute content hash from the in-memory markdown before the transaction.
    // We cannot call getCurrentPageHash() (disk read) inside the transaction, and
    // Phase 3a (file flush) hasn't happened yet — so we hash the source directly.
    const contentHash = createHash('sha256').update(markdown).digest('hex');

    // Phase 2: sync transaction — insertPage + setPendingContent + insertProvenance + FTS5
    // File is NOT written yet. pending_content stores the markdown so the boot
    // reconciler can re-attempt the flush if Phase 3a crashes.
    // updatePlanStatus('committed') is inside the transaction (Gap 3 fix).
    let done: boolean;
    try {
      done = db.transaction((): boolean => {
        if (!planStillCrossreffed(plan.plan_id)) return false;
        insertPage({
          page_id,
          title: plan.title,
          page_type: plan.page_type,
          category,
          summary,
          content_path: expectedPath,
          previous_content_path: null, // set when Phase 3a clears the outbox
        });

        // Outbox: store markdown for Phase 3a flush + crash recovery.
        setPendingContent(page_id, markdown);

        // Writing-rules marker (lib/draft-rules.ts): a page drafted from
        // scratch takes its draft's marker; an update keeps the page's own.
        if (planDraftsFromScratch(plan) && isDraftedPage({ page_id, page_type: plan.page_type })) {
          copyPlanDraftRules(db, plan.plan_id, page_id);
        }

        const contribType = plan.action === 'update' ? 'updated' : 'created';
        for (const sid of sourceIds) {
          insertProvenance({
            source_id: sid,
            page_id,
            content_hash: contentHash,
            contribution_type: contribType,
          });
        }

        // Derive source_count from provenance — the ground truth. Must run
        // AFTER the insertProvenance loop so the new rows are visible to the
        // subquery. COUNT(DISTINCT source_id) handles provenance's allowed
        // duplicate (source_id, page_id) rows (e.g. 'created' + 'updated'
        // for the same source across sessions).
        db.prepare(
          `UPDATE pages SET source_count = (
             SELECT COUNT(DISTINCT source_id) FROM provenance WHERE page_id = ?
           ) WHERE page_id = ?`
        ).run(page_id, page_id);

        // FTS5 upsert
        db.prepare(`DELETE FROM pages_fts WHERE page_id = ?`).run(page_id);
        db.prepare(
          `INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)`
        ).run(page_id, plan.title, stripFrontmatter(markdown));

        // Log to activity
        logActivity('page_compiled', {
          source_id: sourceIds[0] ?? null,
          session_id,
          step_key: 'commit',
          details: {
            page_id,
            title: plan.title,
            page_type: plan.page_type,
            session_id,
            source_title: sourceTitleMap.get(sourceIds[0] ?? '') ?? null,
            action: plan.action,
          },
        });

        // Plan status inside transaction — crash between txn commit and here
        // previously left plan stuck as 'crossreffed'. Now atomic with the page write.
        updatePlanStatus(plan.plan_id, 'committed');
        return true;
      })();
    } catch (txErr) {
      const txMsg = txErr instanceof Error ? txErr.message : String(txErr);
      console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'db_transaction_error', context: 'session_commit', plan_id: plan.plan_id, page_id, session_id, error: txMsg }));
      updatePlanFailed(plan.plan_id, `db_transaction_error (session_commit): ${txMsg}`);
      failed++;
      continue;
    }
    // Another commit of this session got there first and owns its Phase 3.
    if (!done) continue;

    // Phase 3a (awaited): flush pending_content to disk via nlp-service.
    // pending_content stays populated until this succeeds, so the boot reconciler
    // can re-attempt if Phase 3a crashes before it is cleared. The flush
    // re-reads the outbox and clears it compare-and-set (lib/outbox-flush.ts).
    if (!(await flushOutboxPage(page_id))) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'file_flush_failed', context: 'session_commit', plan_id: plan.plan_id, page_id, session_id }));
      // Plan is already committed in DB. pending_content stays populated —
      // the post-loop reconcileSessionFlushes() pass re-attempts it, and
      // whatever still fails is surfaced as flush_failures so the
      // orchestrator fails the session instead of marking it 'completed'.
    }

    // Phase 3b: backfill alias canonical_page_id for entity + concept pages
    // (fire-and-forget). Concepts now qualify because canonical_concepts flow
    // through the resolver post-Core change 2 and populate aliases rows.
    if (plan.page_type === 'entity' || plan.page_type === 'concept') {
      try {
        backfillAliasCanonicalPageId(plan.title, page_id);
      } catch {
        // non-critical
      }
    }

    // Phase 3b: vector upsert — retried 3× before queuing for backfill.
    void upsertVectorWithRetry(page_id, {
      title: plan.title,
      page_type: plan.page_type,
      category: category ?? '',
      source_count: sourceIds.length,
    });

    // Phase 3b: disputes the page records in its own text, for the activity
    // feed (lib/page-disputes.ts). Never throws.
    if (typeof markdown === 'string') recordNewDisputes({ page_id, title: plan.title }, markdown);

    committedPageIds.add(page_id);
    committed++;
    if (plan.action === 'update') pagesUpdated++; else pagesCreated++;
  }

  // ── Wikilink → page_links pass ───────────────────────────────────────────────
  // Parse [[Page Title]] from every committed page's markdown and insert
  // page_links rows. Done after the loop so all page_ids exist in the DB.
  //
  // Per-plan DELETE+INSERTs run in their own db.transaction() — without this, a
  // crash between the DELETE and the INSERTs leaves the page with zero wikilinks.
  // Per-plan try/catch keeps one bad plan from skipping wikilink sync for the rest.
  let wikilinkWarnings = 0;
  const titleMap = getPageTitleMap(); // title.toLowerCase() → page_id
  // Only process plans whose page_id was actually committed (excludes thin-draft
  // skips and failures — pages that were never inserted into `pages`).
  // Without this guard, a thin-draft plan with [[wikilinks]] causes an FK
  // violation that aborts the entire loop, leaving subsequent pages with no links.
  const committedPlans = plans.filter(
    (p) =>
      p.draft_content !== null &&
      p.action !== 'provenance-only' &&
      committedPageIds.has(derivePlanPageId(p))
  );

  for (const plan of committedPlans) {
    const fromPageId = derivePlanPageId(plan);

    try {
      syncPageWikilinks(db, fromPageId, plan.draft_content!, titleMap);
    } catch (wikiErr) {
      wikilinkWarnings++;
      console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'wikilink_edge_failed', session_id, plan_id: plan.plan_id, page_id: fromPageId, error: wikiErr instanceof Error ? wikiErr.message : String(wikiErr) }));
    }
  }

  // Mark session sources active only if they have an extractions row. A
  // source that drafted from raw markdown (because its extract step failed)
  // appears in plan.source_ids — without this filter it would land in
  // compile_status='active' and become unrecoverable: recompile/route.ts:39
  // returns 409 for 'active' sources, and runCompilePipeline's
  // getSourcesBySession excludes them, so /retry-failed silently no-ops
  // ("skipped (no sources)") despite countUnextractedSourcesBySession
  // correctly detecting the stranded source. Keeping 'active' synonymous
  // with "has extraction" lets both retry paths re-attempt the source.
  const extractedSet = new Set(
    getExtractionsBySession(session_id).map((e) => e.source_id),
  );
  const eligibleSourceIds = [...allSourceIds].filter((id) => extractedSet.has(id));
  const sourcesActivated = eligibleSourceIds.length;
  if (sourcesActivated > 0) {
    markSourcesActive(eligibleSourceIds);
  }

  // ── Durability pass (CLAUDE.md rule #5) ─────────────────────────────────────
  // Re-attempt any Phase 3a flush that failed during the loop above. Session
  // pages still pending after this are reported as flush_failures — the
  // orchestrator (run/route.ts) fails the session on a non-zero count so
  // 'completed' is never signalled while .md.gz files are missing from disk.
  // getSessionCommittedPageIds is read AFTER the loop so it includes plans
  // committed in this run as well as prior runs of the same session.
  const flushFailures = await reconcileSessionFlushes(session_id);

  return NextResponse.json(
    {
      session_id,
      committed,
      failed,
      thin_drafts_skipped: thinCount,
      pending_approval: pendingApproval,
      pages_created: pagesCreated,
      pages_updated: pagesUpdated,
      sources_activated: sourcesActivated,
      wikilink_warnings: wikilinkWarnings,
      auto_approve: autoApprove,
      flush_failures: flushFailures,
    },
    { status: 200 }
  );
}

// ── Main POST handler ─────────────────────────────────────────────────────────

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (typeof rawBody !== 'object' || rawBody === null || !('session_id' in rawBody)) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }

  const { session_id } = rawBody as { session_id: unknown };
  if (typeof session_id !== 'string' || !session_id) {
    return NextResponse.json({ error: 'session_id must be a non-empty string' }, { status: 422 });
  }

  return commitSession(session_id);
}
