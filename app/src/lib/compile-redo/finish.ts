/**
 * The end of a redo of the last compile, run by the pipeline after commit
 * reported every page saved and on disk, and before the session completes
 * (CLAUDE.md rule 5): archive what the re-plan dropped, then record the
 * outcome in the activity feed and the saved record.
 *
 * Archiving (FR-6/FR-7): only pages this compile created, that no plan of
 * the new plan writes, and that are still as they were when the owner
 * confirmed (same version token). They are archived the way a page whose
 * rewrite failed is (lib/page-hold.ts holdPage): out of the wiki list,
 * search, graph and MCP tools, readable under "Show archived" with the
 * reason, and offered back by Update pages. Never a page that existed
 * before this compile; never deleted.
 */

import { getDb, logActivity } from '../db';
import { fetchLlmUsage, spendDelta, type LlmUsage } from '../page-upgrade';
import { holdPage } from '../page-hold';
import { pageTextVersionToken } from '../page-rewrite';
import { derivePlanPageId } from '../plan-page-id';
import { saveRedo, type RedoPage, type RedoRecord } from './state';

export function replanArchiveReason(date: string): string {
  return `Kompl archived this page when the compile it came from was planned again on ${date}: the new plan no longer includes it.`;
}

/** Pages the re-plan dropped, archived now. Synchronous DB writes, one transaction per page. */
export function archiveDroppedPages(record: RedoRecord): { archived: RedoPage[]; changed: RedoPage[] } {
  const db = getDb();
  const plans = db
    .prepare(
      `SELECT plan_id, title, action, existing_page_id FROM page_plans
        WHERE session_id = ? AND action IN ('create', 'update') AND draft_status != 'rejected'`,
    )
    .all(record.session_id) as Array<{ plan_id: string; title: string; action: string; existing_page_id: string | null }>;
  const kept = new Set(plans.map((p) => derivePlanPageId(p)));
  const reason = replanArchiveReason(new Date().toISOString().slice(0, 10));
  const archived: RedoPage[] = [];
  const changed: RedoPage[] = [];
  for (const page of record.own_pages) {
    if (kept.has(page.page_id)) continue;
    if (pageTextVersionToken(page.page_id) !== page.version) {
      changed.push({ page_id: page.page_id, title: page.title });
      continue;
    }
    if (holdPage(page.page_id, reason)) archived.push({ page_id: page.page_id, title: page.title });
  }
  return { archived, changed };
}

export interface RedoCommitCounts {
  committed: number;
  changed_pages_skipped?: number;
}

/** Archive (re-plan), log and close the record. Called once per completed redo pipeline. */
export async function finishRedo(record: RedoRecord, commit: RedoCommitCounts): Promise<RedoRecord> {
  const { archived, changed } = record.point === 'plan' ? archiveDroppedPages(record) : { archived: [], changed: [] };
  const planned = (getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM page_plans
        WHERE session_id = ? AND action IN ('create', 'update') AND draft_status NOT IN ('rejected', 'page_changed')`,
    )
    .get(record.session_id) as { n: number }).n;

  let spent: number | null = null;
  if (record.usage_at_start) {
    try {
      spent = spendDelta(record.usage_at_start as LlmUsage, await fetchLlmUsage());
    } catch {
      spent = null;
    }
  }

  const skipped = [...record.skipped, ...changed];
  const skippedOnSave = commit.changed_pages_skipped ?? 0;
  const done: RedoRecord = {
    ...record,
    status: 'finished',
    skipped,
    outcome: { planned, saved: commit.committed, archived, skipped_on_save: skippedOnSave, spent_usd: spent },
    finished_at: new Date().toISOString(),
  };
  logActivity('compile_redo', {
    source_id: null,
    session_id: record.session_id,
    step_key: 'commit',
    details: {
      session_id: record.session_id,
      point: record.point,
      model: record.model,
      planned,
      saved: commit.committed,
      archived: archived.length,
      archived_pages: archived.map((p) => p.title).slice(0, 50),
      skipped: skipped.length + skippedOnSave,
      ...(spent !== null ? { spent_usd: Math.round(spent * 10_000) / 10_000 } : {}),
    },
  });
  saveRedo(done);
  return done;
}
