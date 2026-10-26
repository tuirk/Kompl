/**
 * A match triage's 'contradiction' verdict (plan 3.5): a source contradicts
 * a claim on an existing page. Plan Rule 6 plans an update of the page with
 * the source, so its draft can write the disagreement into the page; this
 * module records the verdict as a possible disagreement for the owner.
 *
 * It goes into the disagreements record (lib/disagreements.ts) and the
 * page_contradiction_detected activity row (the feed, and db.ts
 * getPageContradictions, read its fields by name, so keep them). This is the
 * one place a triage contradiction is recorded.
 */

import { getDb, logActivity } from '../db';
import { recordDisagreement } from '../disagreements';

export interface TriageContradiction {
  session_id: string;
  source_id: string;
  page_id: string;
  page_title: string;
  /** The triage's reason: the page's claim and the source's claim. */
  reason: string;
  /** The source's metadata; undefined when its row is gone. */
  source?: {
    title: string;
    source_url: string | null;
    source_type: string;
    date_ingested: string;
  };
}

export function recordTriageContradiction(c: TriageContradiction): void {
  // Keyed on the new source, like the backfill of logged verdicts, so the two never double one.
  try {
    recordDisagreement(getDb(), {
      page_id: c.page_id,
      found_by: 'triage',
      kind: 'contradiction',
      source_b: c.source_id,
      reason: c.reason,
      session_id: c.session_id,
    });
  } catch (err) {
    console.error('[triage] disagreement record failed', c.page_id, err);
  }
  logActivity('page_contradiction_detected', {
    source_id: c.source_id,
    session_id: c.session_id,
    step_key: 'match',
    details: {
      page_id: c.page_id,
      page_title: c.page_title,
      source_title: c.source?.title ?? null,
      source_url: c.source?.source_url ?? null,
      source_type: c.source?.source_type ?? null,
      date_ingested: c.source?.date_ingested ?? null,
      reason: c.reason,
      session_id: c.session_id,
      detected_at: new Date().toISOString(),
    },
  });
}
