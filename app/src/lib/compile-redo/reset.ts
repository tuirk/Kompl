/**
 * The database side of a redo of the last compile: the reset before the
 * pipeline runs again, and the re-plan's adjustment after its plan step.
 * Synchronous statements only; the reset is one transaction with the saved
 * record, so the run (app/api/compile/run) never sees half of it.
 *
 * The run decides from table state and the record (n8n forwards only the
 * session id), so each point resets exactly what its steps read:
 *   - save:  the held drafts go back to 'crossreffed'; commit saves them.
 *   - write: the plans go back to 'planned' without their drafts; a page the
 *            compile created is rewritten in place (action 'create' with its
 *            existing_page_id, lib/plan-page-id.ts), so it keeps its id.
 *   - plan:  the session's plans go (rejected ones stay as the audit trail)
 *            and its extracted sources reopen ('extracted'), so resolve,
 *            match and plan run again from the stored extractions.
 * Steps before the point keep their result; steps from it go back to
 * pending. The claim check keeps a finished result (it checks the sources,
 * which a redo does not change).
 */

import type Database from 'better-sqlite3';

import { COMPILE_STEP_KEYS, type CompileStepKey } from '../compile-steps';
import { derivePlanPageId } from '../plan-page-id';
import type { RedoPlan } from './plan';
import { saveRedo, type RedoPoint, type RedoRecord } from './state';

/** The first step each point runs again. */
export const REDO_FIRST_STEP: Record<RedoPoint, CompileStepKey> = {
  plan: 'resolve',
  write: 'draft',
  save: 'commit',
};

export const KEPT_DETAIL = 'kept from the last run';

type Steps = Record<string, { status: string; detail?: string }>;

export function redoSteps(current: Steps, point: RedoPoint): Steps {
  const from = COMPILE_STEP_KEYS.indexOf(REDO_FIRST_STEP[point]);
  const steps: Steps = {};
  COMPILE_STEP_KEYS.forEach((key, i) => {
    const was = current[key];
    if (i < from) steps[key] = was?.status === 'done' ? was : { status: 'done', detail: KEPT_DETAIL };
    else if (key === 'claims' && was?.status === 'done') steps[key] = was;
    else steps[key] = { status: 'pending' };
  });
  return steps;
}

/** One transaction: the plans and sources the point reads, the session row, and the record. */
export function applyRedoReset(db: Database.Database, plan: RedoPlan, record: RedoRecord): void {
  const sessionId = plan.session_id;
  db.transaction(() => {
    const row = db.prepare('SELECT steps FROM compile_progress WHERE session_id = ?').get(sessionId) as
      | { steps: string }
      | undefined;
    if (!row) throw new Error('no_progress_record');
    let current: Steps = {};
    try {
      current = JSON.parse(row.steps) as Steps;
    } catch {
      current = {};
    }

    if (plan.point === 'save') {
      const back = db.prepare(`UPDATE page_plans SET draft_status = 'crossreffed', draft_error = NULL WHERE plan_id = ?`);
      for (const id of plan.plan_ids) back.run(id);
    } else if (plan.point === 'write') {
      const get = db.prepare('SELECT plan_id, title, action, existing_page_id, draft_status FROM page_plans WHERE plan_id = ?');
      const reset = db.prepare(
        `UPDATE page_plans
            SET draft_status = 'planned', draft_content = NULL, draft_error = NULL,
                base_version = NULL, used_source_ids = NULL, existing_page_id = ?
          WHERE plan_id = ?`,
      );
      for (const id of plan.plan_ids) {
        const p = get.get(id) as
          | { plan_id: string; title: string; action: string; existing_page_id: string | null; draft_status: string }
          | undefined;
        if (!p) continue;
        // A page this compile created: written again in place, never as a second page.
        const target = p.action === 'create' && p.draft_status === 'committed' ? derivePlanPageId(p) : p.existing_page_id;
        reset.run(target, id);
      }
    } else {
      db.prepare(`DELETE FROM page_plans WHERE session_id = ? AND draft_status != 'rejected'`).run(sessionId);
      db.prepare(
        `UPDATE sources SET compile_status = 'extracted'
          WHERE onboarding_session_id = ? AND compile_status IN ('active', 'compiled')
            AND EXISTS (SELECT 1 FROM extractions e WHERE e.source_id = sources.source_id)`,
      ).run(sessionId);
    }

    db.prepare(
      `UPDATE compile_progress
          SET status = 'queued', current_step = NULL, error = NULL, completed_at = NULL,
              steps = ?, compile_model = ?
        WHERE session_id = ?`,
    ).run(JSON.stringify(redoSteps(current, plan.point)), record.model, sessionId);
    saveRedo(record);
  })();
}

export class RedoPlanTooLargeError extends Error {
  constructor(
    readonly planned: number,
    readonly confirmed: number,
  ) {
    super(
      `The new plan has ${planned} pages, more than the ${confirmed} you confirmed, so nothing was written. ` +
        'Start the redo again to see the new numbers.',
    );
    this.name = 'RedoPlanTooLargeError';
  }
}

/**
 * After a re-plan's plan step (one transaction). A page this compile
 * created is written again in place from scratch, not updated over its own
 * text; a page changed since by something else is left alone (plan
 * 'page_changed', no draft). Throws RedoPlanTooLargeError when the new plan
 * writes more pages than the owner confirmed. Returns the pages planned.
 */
export function applyReplanResult(db: Database.Database, record: RedoRecord): number {
  const own = new Set(record.own_pages.map((p) => p.page_id));
  const skipped = new Set(record.skipped.map((p) => p.page_id));
  return db.transaction(() => {
    const plans = db
      .prepare(
        `SELECT plan_id, action, existing_page_id FROM page_plans
          WHERE session_id = ? AND action IN ('create', 'update', 'provenance-only') AND draft_status = 'planned'`,
      )
      .all(record.session_id) as Array<{ plan_id: string; action: string; existing_page_id: string | null }>;
    const leave = db.prepare(`UPDATE page_plans SET draft_status = 'page_changed' WHERE plan_id = ?`);
    const fresh = db.prepare(`UPDATE page_plans SET action = 'create' WHERE plan_id = ?`);
    let planned = 0;
    for (const p of plans) {
      if (p.existing_page_id && skipped.has(p.existing_page_id)) {
        leave.run(p.plan_id);
        continue;
      }
      if (p.action === 'provenance-only') continue;
      if (p.action === 'update' && p.existing_page_id && own.has(p.existing_page_id)) fresh.run(p.plan_id);
      planned++;
    }
    const crossreffed = (db
      .prepare(
        `SELECT COUNT(*) AS n FROM page_plans
          WHERE session_id = ? AND action IN ('create', 'update') AND draft_status = 'crossreffed'`,
      )
      .get(record.session_id) as { n: number }).n;
    planned += crossreffed;
    if (planned > record.confirmed.max_pages) throw new RedoPlanTooLargeError(planned, record.confirmed.max_pages);
    return planned;
  })();
}
