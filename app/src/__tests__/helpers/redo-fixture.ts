/**
 * A finished compile to redo (lib/compile-redo/): session S with two
 * extracted, active sources; it created "Alpha", "Beta" and a summary page,
 * updated the older page "Old Topic", and held back a draft too short to
 * save ("Gamma").
 */

import type Database from 'better-sqlite3';

import { COMPILE_STEP_KEYS } from '../../lib/compile-steps';
import { derivePlanPageId } from '../../lib/plan-page-id';
import { seedExtraction, seedPage, seedPagePlan, seedProvenance, seedSource } from './test-db';

export const SESSION = 'sess-redo';
export const BODY = `---\ntitle: "Page"\ncategory: Topic\n---\n${'Body text about the subject. '.repeat(40)}`;

export interface RedoFixture {
  sources: [string, string];
  oldPage: string;
  alpha: string;
  beta: string;
  summary: string;
  plans: { alpha: string; beta: string; summary: string; old: string; gamma: string };
}

function doneSteps(): string {
  return JSON.stringify(Object.fromEntries(COMPILE_STEP_KEYS.map((k) => [k, { status: 'done', detail: `${k} result` }])));
}

export function seedProgress(db: Database.Database, sessionId: string, status: string, createdOffsetMin = 0): void {
  db.prepare(
    `INSERT INTO compile_progress (session_id, status, steps, source_count, started_at, completed_at, created_at)
     VALUES (?, ?, ?, 2, datetime('now', '-30 minutes'), datetime('now', '-1 minutes'), datetime('now', ? || ' minutes'))`,
  ).run(sessionId, status, doneSteps(), String(createdOffsetMin - 20));
}

function committedCreate(db: Database.Database, title: string, pageType: string, sources: string[]): { plan: string; page: string } {
  const plan = seedPagePlan(db, {
    session_id: SESSION,
    title,
    page_type: pageType,
    action: 'create',
    source_ids: sources,
    draft_content: BODY,
    draft_status: 'committed',
  });
  const page = derivePlanPageId({ plan_id: plan, title, action: 'create', existing_page_id: null });
  seedPage(db, { page_id: page, title, page_type: pageType });
  for (const s of sources) seedProvenance(db, page, s, 'created');
  db.prepare(
    `INSERT INTO activity_log (action_type, source_id, details, session_id, step_key)
     VALUES ('page_compiled', ?, ?, ?, 'commit')`,
  ).run(sources[0], JSON.stringify({ page_id: page, title, action: 'create' }), SESSION);
  return { plan, page };
}

export function seedFinishedCompile(db: Database.Database, status = 'completed'): RedoFixture {
  const a = seedSource(db, { title: 'Source A', onboarding_session_id: SESSION, compile_status: 'active' });
  const b = seedSource(db, { title: 'Source B', onboarding_session_id: SESSION, compile_status: 'active' });
  seedExtraction(db, { source_id: a });
  seedExtraction(db, { source_id: b });
  seedProgress(db, SESSION, status);

  const oldPage = seedPage(db, { title: 'Old Topic', page_type: 'entity' });
  db.prepare(`UPDATE pages SET created_at = datetime('now', '-10 days') WHERE page_id = ?`).run(oldPage);
  const old = seedPagePlan(db, {
    session_id: SESSION,
    title: 'Old Topic',
    action: 'update',
    source_ids: [a],
    existing_page_id: oldPage,
    draft_content: BODY,
    draft_status: 'committed',
  });
  seedProvenance(db, oldPage, a, 'updated');
  db.prepare(
    `INSERT INTO activity_log (action_type, source_id, details, session_id, step_key)
     VALUES ('page_compiled', ?, ?, ?, 'commit')`,
  ).run(a, JSON.stringify({ page_id: oldPage, title: 'Old Topic', action: 'update' }), SESSION);

  const alpha = committedCreate(db, 'Alpha', 'entity', [a, b]);
  const beta = committedCreate(db, 'Beta', 'concept', [a, b]);
  const summary = committedCreate(db, 'Source A', 'source-summary', [a]);
  const gamma = seedPagePlan(db, {
    session_id: SESSION,
    title: 'Gamma',
    action: 'create',
    source_ids: [b],
    draft_content: `---\ntitle: "Gamma"\n---\nShort.`,
    draft_status: 'draft_too_thin',
  });
  return {
    sources: [a, b],
    oldPage,
    alpha: alpha.page,
    beta: beta.page,
    summary: summary.page,
    plans: { alpha: alpha.plan, beta: beta.plan, summary: summary.plan, old, gamma },
  };
}

/** Something else rewrote the page after the compile. */
export function touchPage(db: Database.Database, pageId: string): void {
  db.prepare(`UPDATE pages SET last_updated = datetime('now', '+1 minutes') WHERE page_id = ?`).run(pageId);
}

/** nlp-service prices and usage for the estimate (GET /llm/pricing, /llm/usage). */
export const PRICING = {
  input_usd_per_m: 0.3,
  output_usd_per_m: 2.5,
  cached_input_usd_per_m: 0.03,
  draft_thinking_budget: 2048,
  draft_thinking_budget_is_cap: true,
  draft_max_output_tokens: 16000,
  draft_prompt_char_cap: 200000,
  disambiguate_thinking_budget: 1024,
  disambiguate_max_output_tokens: 8000,
  label_merge_thinking_budget: 1024,
  label_merge_max_output_tokens: 8000,
};

export const USAGE = { date: '2026-10-26', total_usd: 1.25, daily_cap_usd: 0, remaining_usd: -1 };
