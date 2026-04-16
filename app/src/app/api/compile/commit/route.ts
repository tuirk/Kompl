/**
 * POST /api/compile/commit
 *
 * Session-only commit. Implements the Pass-5 three-phase commit pattern
 * (CLAUDE.md rule #5) for session-based compilation.
 *
 * Rule #5 — three phases per page plan:
 *   Phase 2 (sync db.transaction()):
 *     - insertPage()
 *     - setPendingContent() (outbox — markdown stored for boot reconciler)
 *     - insertProvenance()
 *     - pages_fts upsert
 *     - insertActivity('page_compiled', ...)
 *     - updatePlanStatus('committed')
 *     NO await inside this callback — better-sqlite3 is sync-only.
 *   Phase 3a (awaited):
 *     - POST /storage/write-page → flush pending_content to disk
 *     - clearPendingContent() on success
 *   Phase 3b (fire-and-forget):
 *     - alias canonical backfill
 *     - Vector upsert (retried 3× before queuing for backfill)
 *
 * Request:  { session_id: string }
 * Response: { session_id, committed, failed, thin_drafts_skipped,
 *             pages_created, pages_updated, sources_activated, wikilink_warnings }
 */

import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';

import {
  getDb,
  insertActivity,
  insertPage,
  insertPageLink,
  insertProvenance,
  markSourcesActive,
  getCompileProgress,
  getMinDraftChars,
  getPagePlansByStatus,
  getPageTitleMap,
  updatePlanStatus,
  getCurrentPageHash,
  incrementPageSourceCount,
  setPendingContent,
  clearPendingContent,
} from '../../../../lib/db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

/**
 * Upsert a page into the vector store with up to 3 attempts and 500ms backoff.
 * On final failure the page_id is written to vector_backfill_queue so it can
 * be recovered via POST /api/compile/backfill-vectors without re-compiling.
 * Never throws — vector failures must not fail the compile response.
 */
async function upsertVectorWithRetry(
  page_id: string,
  metadata: Record<string, unknown>,
  retries = 3
): Promise<void> {
  const db = getDb();
  const payload = JSON.stringify({ page_id, metadata });
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(`${NLP_SERVICE_URL}/vectors/upsert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return;
      throw new Error(`status ${res.status}`);
    } catch (err) {
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, 500));
      } else {
        console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'vector_upsert_failed', page_id, error: err instanceof Error ? err.message : String(err) }));
        try {
          db.prepare('INSERT OR IGNORE INTO vector_backfill_queue (page_id) VALUES (?)').run(page_id);
        } catch { /* non-fatal */ }
      }
    }
  }
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
    return NextResponse.json(
      { session_id, committed: 0, failed: 0, pages_created: 0, pages_updated: 0, sources_activated: 0 },
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
  const allSourceIds = new Set<string>();
  // Track page_ids that were actually committed so the wikilink pass below
  // can exclude thin-draft and failed plans (which were never inserted into pages).
  const committedPageIds = new Set<string>();

  const minDraftChars = getMinDraftChars();

  // Build source title map once before the loop — used to enrich page_compiled events.
  const sourceTitleMap = new Map<string, string>(
    (db.prepare('SELECT source_id, title FROM sources').all() as Array<{ source_id: string; title: string }>)
      .map((r) => [r.source_id, r.title])
  );

  for (const plan of plans) {
    const sourceIds: string[] = JSON.parse(plan.source_ids);
    sourceIds.forEach((s) => allSourceIds.add(s));

    if (plan.action === 'provenance-only') {
      // provenance-only: insert provenance rows only, no page write
      try {
        const existingPageId = plan.existing_page_id!;
        const pageHash = getCurrentPageHash(existingPageId); // sync filesystem read before transaction
        db.transaction(() => {
          for (const sid of sourceIds) {
            insertProvenance({
              source_id: sid,
              page_id: existingPageId,
              content_hash: pageHash,
              contribution_type: 'mentioned',
            });
          }
          incrementPageSourceCount(existingPageId, sourceIds.length);
          // Inside transaction — crash between commit and this call previously
          // left plan stuck as 'crossreffed'. Now atomic with the provenance write.
          updatePlanStatus(plan.plan_id, 'committed');
        })();
        committed++;
      } catch (txErr) {
        const txMsg = txErr instanceof Error ? txErr.message : String(txErr);
        console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'db_transaction_error', context: 'provenance_only_commit', plan_id: plan.plan_id, session_id, error: txMsg }));
        updatePlanStatus(plan.plan_id, 'failed');
        failed++;
      }
      continue;
    }

    const markdown = plan.draft_content;
    if (!markdown) {
      updatePlanStatus(plan.plan_id, 'failed');
      failed++;
      continue;
    }

    // Gate 2: thin-draft check. Strip frontmatter before measuring so that
    // a page with only YAML and no body doesn't pass on character count alone.
    if (minDraftChars > 0) {
      const bodyLength = stripFrontmatter(markdown).length;
      if (bodyLength < minDraftChars) {
        updatePlanStatus(plan.plan_id, 'draft_too_thin');
        insertActivity({
          action_type: 'draft_too_thin',
          source_id: sourceIds[0] ?? null,
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

    let page_id: string;

    if (plan.action === 'update' && plan.existing_page_id) {
      page_id = plan.existing_page_id;
    } else {
      // Generate slug-based page_id from title + plan_id suffix
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

    // Extract frontmatter fields (category, summary) from YAML.
    // Use [ \t]* (not \s*) so the regex cannot cross a newline and accidentally
    // capture the next YAML key when category:/summary: has no inline value.
    const categoryMatch = markdown.match(/^category:[ \t]*["']?(.+?)["']?[ \t]*$/m);
    const summaryMatch = markdown.match(/^summary:[ \t]*["']?(.+?)["']?[ \t]*$/m);
    const category = categoryMatch?.[1]?.trim() ?? null;
    const summary = summaryMatch?.[1]?.trim() ?? null;

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
    try {
      db.transaction(() => {
        insertPage({
          page_id,
          title: plan.title,
          page_type: plan.page_type,
          category,
          summary,
          content_path: expectedPath,
          previous_content_path: null, // set by clearPendingContent after Phase 3a
        });

        // Fix source_count to actual number of contributing sources
        db.prepare(`UPDATE pages SET source_count = ? WHERE page_id = ?`)
          .run(sourceIds.length, page_id);

        // Outbox: store markdown for Phase 3a flush + crash recovery.
        setPendingContent(page_id, markdown);

        const contribType = plan.action === 'update' ? 'updated' : 'created';
        for (const sid of sourceIds) {
          insertProvenance({
            source_id: sid,
            page_id,
            content_hash: contentHash,
            contribution_type: contribType,
          });
        }

        // FTS5 upsert
        db.prepare(`DELETE FROM pages_fts WHERE page_id = ?`).run(page_id);
        db.prepare(
          `INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)`
        ).run(page_id, plan.title, stripFrontmatter(markdown));

        // Log to activity
        insertActivity({
          action_type: 'page_compiled',
          source_id: sourceIds[0] ?? null,
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
      })();
    } catch (txErr) {
      const txMsg = txErr instanceof Error ? txErr.message : String(txErr);
      console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'db_transaction_error', context: 'session_commit', plan_id: plan.plan_id, page_id, session_id, error: txMsg }));
      updatePlanStatus(plan.plan_id, 'failed');
      failed++;
      continue;
    }

    // Phase 3a (awaited): flush pending_content to disk via nlp-service.
    // pending_content stays populated until this succeeds, so the boot reconciler
    // can re-attempt if Phase 3a crashes before clearPendingContent runs.
    try {
      const res = await fetch(`${NLP_SERVICE_URL}/storage/write-page`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page_id, markdown }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`write_page_failed: ${res.status}`);
      const wr = await res.json() as { current_path: string; previous_path: string | null };
      clearPendingContent(page_id, wr.previous_path);
    } catch (flushErr) {
      const flushMsg = flushErr instanceof Error ? flushErr.message : String(flushErr);
      console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'file_flush_failed', context: 'session_commit', plan_id: plan.plan_id, page_id, session_id, error: flushMsg }));
      // Plan is already committed in DB. pending_content stays for reconciler.
      // Do not mark as failed — the page row is durable; only the file is missing.
    }

    // Phase 3b: backfill alias canonical_page_id for entity pages (fire-and-forget)
    if (plan.page_type === 'entity') {
      try {
        db.prepare(
          `UPDATE aliases SET canonical_page_id = ? WHERE canonical_name = ? COLLATE NOCASE`
        ).run(page_id, plan.title);
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

    committedPageIds.add(page_id);
    committed++;
    if (plan.action === 'update') pagesUpdated++; else pagesCreated++;
  }

  // ── Wikilink → page_links pass ───────────────────────────────────────────────
  // Parse [[Page Title]] from every committed page's markdown and insert
  // page_links rows. Done after the loop so all page_ids exist in the DB.
  let wikilinkWarnings = 0;
  try {
    const titleMap = getPageTitleMap(); // title.toLowerCase() → page_id
    // Only process plans whose page_id was actually committed (excludes thin-draft
    // skips and failures — pages that were never inserted into `pages`).
    // Without this guard, a thin-draft plan with [[wikilinks]] causes an FK
    // violation that aborts the entire loop, leaving subsequent pages with no links.
    const committedPlans = plans.filter((p) => {
      if (!p.draft_content || p.action === 'provenance-only') return false;
      const pid = p.action === 'update' && p.existing_page_id
        ? p.existing_page_id
        : (() => {
            const suffix = p.plan_id.replace(/-/g, '').slice(0, 8);
            const base = p.title.toLowerCase().replace(/[^a-z0-9\s-]/g, '')
              .replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 56).replace(/^-+|-+$/g, '');
            return `${base || 'page'}-${suffix}`;
          })();
      return committedPageIds.has(pid);
    });

    for (const plan of committedPlans) {
      const fromPageId = plan.action === 'update' && plan.existing_page_id
        ? plan.existing_page_id
        : (() => {
            const suffix = plan.plan_id.replace(/-/g, '').slice(0, 8);
            const base = plan.title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 56).replace(/^-+|-+$/g, '');
            return `${base || 'page'}-${suffix}`;
          })();

      // Delete stale wikilinks for this page before re-inserting current ones.
      // Prevents phantom backlinks when [[links]] are removed on recompile.
      db.prepare(`DELETE FROM page_links WHERE source_page_id = ? AND link_type = 'wikilink'`).run(fromPageId);

      const rawLinks = plan.draft_content!.match(/\[\[([^\]]+)\]\]/g) ?? [];
      const seenTargets = new Set<string>();
      for (const link of rawLinks) {
        const title = link.slice(2, -2).trim();
        const toPageId = titleMap.get(title.toLowerCase());
        if (toPageId && toPageId !== fromPageId && !seenTargets.has(toPageId)) {
          seenTargets.add(toPageId);
          insertPageLink(fromPageId, toPageId, 'wikilink');
        }
      }
    }
  } catch (wikiErr) {
    wikilinkWarnings++;
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'wikilink_edge_failed', session_id, error: wikiErr instanceof Error ? wikiErr.message : String(wikiErr) }));
  }

  // Mark all session sources as active
  const sourcesActivated = allSourceIds.size;
  if (sourcesActivated > 0) {
    markSourcesActive([...allSourceIds]);
  }

  return NextResponse.json(
    { session_id, committed, failed, thin_drafts_skipped: thinCount, pages_created: pagesCreated, pages_updated: pagesUpdated, sources_activated: sourcesActivated, wikilink_warnings: wikilinkWarnings },
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
