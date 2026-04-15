/**
 * POST /api/drafts/[plan_id]/approve
 *
 * Commits a pending_approval draft to the wiki.
 * Implements the outbox commit pattern (CLAUDE.md rule #5):
 *   Phase 2 (sync db.transaction): insertPage + setPendingContent + FTS + provenance +
 *     insertActivity + updatePlanStatus('committed') — all atomic.
 *   Phase 3a (awaited): flush pending_content to disk via /storage/write-page →
 *     clearPendingContent. Idempotent: re-approval after a prior crash re-runs Phase 3a.
 *   Phase 3b (fire-and-forget): vector upsert.
 * Only operates on plans with draft_status = 'pending_approval'.
 */

import { NextResponse } from 'next/server';
import {
  getDb,
  insertPage,
  insertProvenance,
  insertActivity,
  updatePlanStatus,
  setPendingContent,
  clearPendingContent,
} from '@/lib/db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

interface RouteContext {
  params: Promise<{ plan_id: string }>;
}

export async function POST(_request: Request, { params }: RouteContext) {
  const { plan_id } = await params;
  const db = getDb();

  const plan = db
    .prepare(
      `SELECT plan_id, session_id, title, page_type, action,
              source_ids, existing_page_id, draft_content, draft_status, created_at
         FROM page_plans WHERE plan_id = ?`
    )
    .get(plan_id) as {
    plan_id: string;
    session_id: string;
    title: string;
    page_type: string;
    action: string;
    source_ids: string;
    existing_page_id: string | null;
    draft_content: string | null;
    draft_status: string;
  } | undefined;

  if (!plan) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (plan.draft_status !== 'pending_approval') {
    return NextResponse.json({ error: 'not_pending_approval', current_status: plan.draft_status }, { status: 409 });
  }
  if (!plan.draft_content) {
    return NextResponse.json({ error: 'no_draft_content' }, { status: 422 });
  }

  const markdown = plan.draft_content;
  const sourceIds: string[] = JSON.parse(plan.source_ids);

  // Determine page_id
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

  // Extract frontmatter fields
  const categoryMatch = markdown.match(/^category:\s*["']?(.+?)["']?\s*$/m);
  const summaryMatch = markdown.match(/^summary:\s*["']?(.+?)["']?\s*$/m);
  const category = categoryMatch?.[1]?.trim() ?? null;
  const summary = summaryMatch?.[1]?.trim() ?? null;

  // Deterministic path — known before the file is written (page_id is fixed).
  const expectedPath = `/data/pages/${page_id}.md.gz`;

  // Phase 2: sync transaction — all writes atomic, including plan status.
  // Idempotency guard at the top handles re-approval after a prior crash
  // that committed the transaction but died before returning the response.
  // File is NOT written yet — pending_content stores markdown for Phase 3a.
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
        previous_content_path: null, // set by clearPendingContent after Phase 3a
      });

      // Outbox: store markdown for Phase 3a flush + crash recovery.
      setPendingContent(page_id, markdown);

      if (sourceIds.length > 0) {
        db.prepare('UPDATE pages SET source_count = ? WHERE page_id = ?').run(sourceIds.length, page_id);
        const contribType = plan.action === 'update' ? 'updated' : 'created';
        for (const sid of sourceIds) {
          insertProvenance({ source_id: sid, page_id, content_hash: '', contribution_type: contribType });
        }
      }

      // FTS5 upsert
      db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(page_id);
      db.prepare('INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)').run(
        page_id,
        plan.title,
        markdown.replace(/^---[\s\S]*?---\n*/m, '')
      );

      insertActivity({
        action_type: 'draft_approved',
        source_id: sourceIds[0] ?? null,
        details: { page_id, title: plan.title, plan_id },
      });

      // updatePlanStatus inside transaction — crash between commit and response
      // can never leave the plan stuck as pending_approval.
      updatePlanStatus(plan_id, 'committed');
    })();
  } catch (txErr) {
    const msg = txErr instanceof Error ? txErr.message : String(txErr);
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'db_transaction_error', context: 'draft_approve', plan_id, page_id, error: msg }));
    return NextResponse.json({ error: `commit_failed: ${msg}` }, { status: 500 });
  }

  // Phase 3a (awaited): flush pending_content to disk via nlp-service.
  // Handles both the normal path and the idempotency-guard path (re-approval
  // after a prior crash where Phase 2 committed but Phase 3a did not).
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
      console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'file_flush_failed', context: 'draft_approve', plan_id, page_id, error: msg }));
      // DB commit succeeded. pending_content stays for boot reconciler.
    }
  }

  // Phase 3b: fire-and-forget vector upsert
  void fetch(`${NLP_SERVICE_URL}/vectors/upsert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page_id,
      metadata: { title: plan.title, page_type: plan.page_type, category: category ?? '', source_count: sourceIds.length },
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {});

  return NextResponse.json({ page_id, title: plan.title, committed: true });
}
