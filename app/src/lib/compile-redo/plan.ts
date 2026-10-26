/**
 * What a redo of the last compile would do, computed without changing
 * anything: the preview the owner confirms (FR-4) and the input of the
 * reset (./reset.ts), which works on exactly the plans listed here.
 *
 *   - save:  drafts the compile wrote but did not save: too short for the
 *            minimum page length, or waiting for approval when auto-approve
 *            is now on. No AI writing (FR-14).
 *   - write: every page the compile planned is written again, except pages
 *            changed since by something else (FR-8).
 *   - plan:  the compile's sources are planned again; how many pages the new
 *            plan holds is known only after planning, so the preview gives
 *            the current count and a bound (REPLAN_HIGH_FACTOR).
 */

import type Database from 'better-sqlite3';

import { getAutoApprove, readPageMarkdown, readRawMarkdown } from '../db';
import type { PageEstimateInput } from '../page-upgrade-estimate';
import { pageTextVersionToken } from '../page-rewrite';
import { compilePages } from './baseline';
import type { RedoEstimateInput } from './estimate';
import { MAX_REDO_PAGES, REPLAN_HIGH_FACTOR, REPLAN_SLACK_PAGES, type RedoPage, type RedoPoint } from './state';

/** A page of unknown length counts as this long in the estimate. */
const DEFAULT_PAGE_CHARS = 4_000;

interface PlanRow {
  plan_id: string;
  title: string;
  page_type: string;
  action: string;
  source_ids: string;
  existing_page_id: string | null;
  draft_content: string | null;
  draft_status: string;
  base_version: string | null;
}

export interface RedoPlan {
  session_id: string;
  point: RedoPoint;
  /** Plans the reset puts back to work (write, save); empty for plan. */
  plan_ids: string[];
  /** Pages the redo plans, writes or saves (re-plan: the current pages). */
  pages: RedoPage[];
  /** The most pages the redo may write or save: the bound the owner confirms. */
  max_pages: number;
  /** Re-plan: pages this compile created that are archived if the new plan leaves them out. */
  may_archive: RedoPage[];
  /** Pages changed since the compile by something else: left alone. */
  skipped: RedoPage[];
  /** Drafts waiting for approval that the redo replaces (plan, write). */
  waiting_drafts: number;
  /** Re-plan: sources planned again (read from their stored extractions). */
  sources: number;
  estimate_input: RedoEstimateInput;
}

function sourceIdsOf(plan: PlanRow): string[] {
  try {
    const ids = JSON.parse(plan.source_ids) as unknown;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function sizer() {
  const raw = new Map<string, number>();
  const chars = (id: string) => {
    if (!raw.has(id)) {
      let n = 0;
      try {
        n = readRawMarkdown(id)?.length ?? 0;
      } catch {
        n = 0;
      }
      raw.set(id, n);
    }
    return raw.get(id)!;
  };
  return (plan: PlanRow, pageId: string | null): PageEstimateInput => {
    const ids = sourceIdsOf(plan);
    let pageChars = plan.draft_content?.length ?? 0;
    if (!pageChars && pageId) {
      try {
        pageChars = readPageMarkdown(pageId)?.length ?? 0;
      } catch {
        pageChars = 0;
      }
    }
    return {
      source_chars: ids.reduce((sum, id) => sum + chars(id), 0),
      source_count: ids.length,
      page_chars: pageChars || DEFAULT_PAGE_CHARS,
    };
  };
}

export function computeRedoPlan(db: Database.Database, sessionId: string, point: RedoPoint): RedoPlan {
  const plans = db
    .prepare(
      `SELECT plan_id, title, page_type, action, source_ids, existing_page_id, draft_content, draft_status, base_version
         FROM page_plans WHERE session_id = ? AND action IN ('create', 'update')
        ORDER BY created_at, plan_id`,
    )
    .all(sessionId) as PlanRow[];
  const written = compilePages(db, sessionId);
  const changedIds = new Set(written.filter((p) => p.changed).map((p) => p.page_id));
  const changedByPlan = new Map(written.filter((p) => p.changed).map((p) => [p.plan_id, p]));
  const size = sizer();
  const skipped = new Map<string, RedoPage>();
  const work: PlanRow[] = [];
  const sizes: PageEstimateInput[] = [];
  // Re-plan low end: every source always gets its own summary page again.
  const sourcePageSizes: PageEstimateInput[] = [];
  const pageOf = new Map(written.map((p) => [p.plan_id, p.page_id]));

  const waiting = plans.filter((p) => p.draft_status === 'pending_approval').length;
  if (point === 'save') {
    const autoApprove = getAutoApprove();
    for (const p of plans) {
      const held = p.draft_status === 'draft_too_thin' || (autoApprove && p.draft_status === 'pending_approval');
      if (!held || !p.draft_content) continue;
      if (p.existing_page_id && p.base_version !== null && pageTextVersionToken(p.existing_page_id) !== p.base_version) {
        skipped.set(p.existing_page_id, { page_id: p.existing_page_id, title: p.title });
        continue;
      }
      work.push(p);
    }
  } else if (point === 'write') {
    for (const p of plans) {
      if (p.draft_status === 'rejected' || p.draft_status === 'page_changed') continue;
      const changed = changedByPlan.get(p.plan_id);
      if (changed || (p.existing_page_id && changedIds.has(p.existing_page_id))) {
        const id = changed?.page_id ?? p.existing_page_id!;
        skipped.set(id, { page_id: id, title: p.title });
        continue;
      }
      work.push(p);
      // An original-source page is the source text itself: no AI call.
      if (p.page_type !== 'original-source') sizes.push(size(p, pageOf.get(p.plan_id) ?? p.existing_page_id));
    }
  } else {
    for (const w of written) if (w.changed) skipped.set(w.page_id, { page_id: w.page_id, title: w.title });
    for (const p of plans) {
      if (p.draft_status === 'rejected' || p.draft_status === 'page_changed') continue;
      const s = size(p, pageOf.get(p.plan_id) ?? p.existing_page_id);
      if (p.page_type !== 'original-source') sizes.push(s);
      if (p.page_type === 'source-summary') sourcePageSizes.push(s);
    }
  }

  const sources =
    point === 'plan'
      ? (db
          .prepare(
            `SELECT COUNT(*) AS n FROM sources s
              WHERE s.onboarding_session_id = ? AND EXISTS (SELECT 1 FROM extractions e WHERE e.source_id = s.source_id)`,
          )
          .get(sessionId) as { n: number }).n
      : 0;
  const current = point === 'plan'
    ? plans.filter((p) => p.draft_status !== 'rejected' && p.draft_status !== 'page_changed').length
    : work.length;
  const maxPages = point === 'plan'
    ? Math.max(current, Math.min(MAX_REDO_PAGES, Math.ceil(current * REPLAN_HIGH_FACTOR) + REPLAN_SLACK_PAGES))
    : work.length;
  // The high end of a re-plan: the current pages plus the extra it may plan, sized like an average one.
  const avg = sizes.length > 0 ? sizes[Math.floor(sizes.length / 2)] : { source_chars: 0, source_count: 1, page_chars: DEFAULT_PAGE_CHARS };
  const high = point === 'plan' ? [...sizes, ...Array.from({ length: Math.max(0, maxPages - current) }, () => avg)] : sizes;
  return {
    session_id: sessionId,
    point,
    plan_ids: point === 'plan' ? [] : work.map((p) => p.plan_id),
    pages:
      point === 'plan'
        ? plans.filter((p) => p.draft_status !== 'rejected').map((p) => ({ page_id: pageOf.get(p.plan_id) ?? p.existing_page_id ?? '', title: p.title }))
        : work.map((p) => ({ page_id: pageOf.get(p.plan_id) ?? p.existing_page_id ?? '', title: p.title })),
    max_pages: maxPages,
    may_archive: point === 'plan' ? written.filter((p) => p.action === 'create' && !p.changed).map(({ page_id, title }) => ({ page_id, title })) : [],
    skipped: [...skipped.values()],
    waiting_drafts: point === 'save' ? 0 : waiting,
    sources,
    estimate_input: {
      draftsLow: point === 'plan' ? sourcePageSizes : sizes,
      draftsHigh: high,
      checkSources: sources,
    },
  };
}
