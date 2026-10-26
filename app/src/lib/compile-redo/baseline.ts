/**
 * What the last compile wrote, read before a redo: every page its plans
 * saved, whether the compile created it or only updated it (FR-6/FR-7),
 * and whether anything else changed it since (FR-8). Reads only.
 *
 * "Changed since": the page was rewritten after this compile last wrote it
 * (pages.last_updated later than that write), archived, or deleted. The
 * write is this session's page_compiled row for the page (compile commit),
 * or the draft_approved row of one of its plans (a draft approved later);
 * a page with neither falls back to the session's end. Both are whole
 * seconds; a change in the very second of the write counts as unchanged,
 * like pageRewrittenSince.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import type Database from 'better-sqlite3';

import { DATA_ROOT, safePreviousContentPath } from '../db';
import { derivePlanPageId } from '../plan-page-id';

export interface CompilePage {
  page_id: string;
  title: string;
  plan_id: string;
  /** 'create': the compile made the page; 'update': it existed before. */
  action: 'create' | 'update';
  changed: boolean;
}

interface PlanRow {
  plan_id: string;
  title: string;
  action: string;
  existing_page_id: string | null;
}

/** The session's committed content plans, one entry per page they wrote. */
export function compilePages(db: Database.Database, sessionId: string): CompilePage[] {
  const plans = db
    .prepare(
      `SELECT plan_id, title, action, existing_page_id FROM page_plans
        WHERE session_id = ? AND draft_status = 'committed' AND action IN ('create', 'update')
        ORDER BY created_at, plan_id`,
    )
    .all(sessionId) as PlanRow[];
  if (plans.length === 0) return [];

  const progress = db
    .prepare('SELECT COALESCE(completed_at, started_at, created_at) AS ended FROM compile_progress WHERE session_id = ?')
    .get(sessionId) as { ended: string } | undefined;
  const planIds = new Set(plans.map((p) => p.plan_id));
  const writtenAt = new Map<string, string>();
  const rows = db
    .prepare(
      `SELECT action_type, timestamp, json_extract(details, '$.page_id') AS page_id,
              json_extract(details, '$.plan_id') AS plan_id
         FROM activity_log
        WHERE (action_type = 'page_compiled' AND session_id = ?)
           OR action_type = 'draft_approved'`,
    )
    .all(sessionId) as Array<{ action_type: string; timestamp: string; page_id: string | null; plan_id: string | null }>;
  for (const r of rows) {
    if (!r.page_id) continue;
    if (r.action_type === 'draft_approved' && !(r.plan_id && planIds.has(r.plan_id))) continue;
    const prev = writtenAt.get(r.page_id);
    if (!prev || prev < r.timestamp) writtenAt.set(r.page_id, r.timestamp);
  }

  const pageRow = db.prepare(
    `SELECT page_type, julianday(last_updated) > julianday(?) AS after FROM pages WHERE page_id = ?`,
  );
  const out = new Map<string, CompilePage>();
  for (const plan of plans) {
    const page_id = derivePlanPageId(plan);
    const createdHere = plan.action === 'create';
    const seen = out.get(page_id);
    // A page both created and updated by the session counts as created.
    if (seen && !(createdHere && seen.action === 'update')) continue;
    const since = writtenAt.get(page_id) ?? progress?.ended ?? null;
    const page = pageRow.get(since, page_id) as { page_type: string; after: number | null } | undefined;
    const changed = !page || page.page_type === 'archived' || (since !== null && page.after === 1);
    out.set(page_id, { page_id, title: plan.title, plan_id: plan.plan_id, action: createdHere ? 'create' : 'update', changed });
  }
  return [...out.values()];
}

/**
 * The page's text from before this compile first wrote it, or null when no
 * kept version shows it. A redo that writes an update again starts from it:
 * the page now holds the very update being redone, so updating the page as
 * it is could not undo a bad update.
 *
 * nlp-service keeps the last versions of a page (file_store.py
 * MAX_ARCHIVED_VERSIONS) named by the time each was written. The one from
 * before the compile is the newest written before the compile's first save
 * of the page (its first page_compiled or draft_approved row). That version
 * was read by the compile's draft, well before its save, so it is never
 * written in the same second as the save.
 */
export function pageTextBeforeCompile(db: Database.Database, sessionId: string, pageId: string): string | null {
  const first = db
    .prepare(
      `SELECT MIN(a.timestamp) AS at
         FROM activity_log a
        WHERE json_extract(a.details, '$.page_id') = ?
          AND ((a.action_type = 'page_compiled' AND a.session_id = ?)
            OR (a.action_type = 'draft_approved'
                AND json_extract(a.details, '$.plan_id') IN (SELECT plan_id FROM page_plans WHERE session_id = ?)))`,
    )
    .get(pageId, sessionId, sessionId) as { at: string | null } | undefined;
  if (!first?.at) return null;
  // '2026-10-26 12:34:56' → '20261026-123456', the archive names' stamp.
  const savedAt = first.at.replace(/[-:]/g, '').replace(' ', '-').slice(0, 15);

  const pagesDir = path.join(DATA_ROOT, 'pages');
  let names: string[];
  try {
    names = fs.readdirSync(pagesDir);
  } catch {
    return null;
  }
  const before = names
    .filter((n) => n.startsWith(`${pageId}.`) && safePreviousContentPath(pageId, path.join(pagesDir, n)))
    .map((n) => ({ n, stamp: n.slice(pageId.length + 1, pageId.length + 16) }))
    .filter((a) => a.stamp < savedAt)
    .sort((a, b) => (a.n < b.n ? 1 : -1));
  if (before.length === 0) return null;
  try {
    return zlib.gunzipSync(fs.readFileSync(path.join(pagesDir, before[0].n))).toString('utf-8');
  } catch {
    return null;
  }
}
