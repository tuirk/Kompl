/**
 * What the draft step sends under the prompt budget (plan 2.1, audit B4),
 * and how it reports what the budget cut.
 *
 * The nlp-service fits the source documents to the prompt budget
 * (nlp-service/services/draft_budget.py): this session's sources first and
 * whole, older ones by relevance. This module orders what it receives,
 * builds the page list an overview drafts from, and turns the cuts it
 * reports into the draft step's detail line.
 */

import type Database from 'better-sqlite3';

import { extractFrontmatterField } from '../yaml-frontmatter';

/** A source the prompt budget left out (sent_chars 0) or shortened. */
export interface DraftSourceCut {
  source_id: string;
  sent_chars: number;
  cut_chars: number;
}

/** The cuts of one plan's draft, with source titles for the report. */
export interface PlanPromptCut {
  plan_id: string;
  title: string;
  sources: Array<DraftSourceCut & { source_title: string }>;
}

/**
 * This session's sources first, in plan order; then older ones, newest
 * first (ties keep plan order). The nlp-service keeps this order when every
 * source fits, and uses it to break relevance ties when they do not.
 */
export function orderDraftSources<T extends { is_new: boolean; date_ingested: string | null }>(sources: T[]): T[] {
  const fresh = sources.filter((s) => s.is_new);
  const older = sources
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !s.is_new)
    .sort((a, b) => {
      const da = a.s.date_ingested ?? '';
      const db = b.s.date_ingested ?? '';
      if (da !== db) return da < db ? 1 : -1;
      return a.i - b.i;
    })
    .map(({ s }) => s);
  return [...fresh, ...older];
}

// A plan whose draft is (or became) a page an overview can list.
const LISTABLE = new Set(['drafted', 'crossreffed', 'pending_approval', 'committed']);

/**
 * The pages an overview drafts from: its related plans, in order, each with
 * the summary from its draft's front matter, or from the page it updates
 * when it has no usable draft. Read from page_plans, so a retry after the
 * related plans already committed still lists them. Plans with neither
 * (a failed new page) are left out.
 */
export function overviewPages(
  db: Database.Database,
  relatedPlanIds: string[],
): Array<{ title: string; type: string; summary: string }> {
  const planRow = db.prepare(
    `SELECT title, page_type, draft_content, draft_status, existing_page_id
       FROM page_plans WHERE plan_id = ?`,
  );
  const pageSummary = db.prepare('SELECT summary FROM pages WHERE page_id = ?');
  const pages: Array<{ title: string; type: string; summary: string }> = [];
  const seen = new Set<string>();
  for (const id of relatedPlanIds) {
    const plan = planRow.get(id) as
      | { title: string; page_type: string; draft_content: string | null; draft_status: string; existing_page_id: string | null }
      | undefined;
    if (!plan || seen.has(plan.title.toLowerCase())) continue;
    let summary: string | null = null;
    if (plan.draft_content && LISTABLE.has(plan.draft_status)) {
      summary = extractFrontmatterField(plan.draft_content, 'summary') ?? '';
    } else if (plan.existing_page_id) {
      const page = pageSummary.get(plan.existing_page_id) as { summary: string | null } | undefined;
      if (page) summary = page.summary ?? '';
    }
    if (summary === null) continue;
    seen.add(plan.title.toLowerCase());
    pages.push({ title: plan.title, type: plan.page_type, summary });
  }
  return pages;
}

const SHOWN_TITLES = 3;

/**
 * One line for the draft step detail, '' when nothing was cut, e.g.
 * `prompt budget: 2 sources left out, 1 shortened on "Bitcoin" (84,000 chars): "A", "B", "C"`.
 */
export function describePromptCuts(cuts: PlanPromptCut[]): string {
  const all = cuts.flatMap((c) => c.sources);
  if (all.length === 0) return '';
  const leftOut = all.filter((s) => s.sent_chars === 0).length;
  const shortened = all.length - leftOut;
  const counts: string[] = [];
  if (leftOut > 0) counts.push(`${leftOut} source${leftOut === 1 ? '' : 's'} left out`);
  if (shortened > 0) {
    counts.push(leftOut > 0 ? `${shortened} shortened` : `${shortened} source${shortened === 1 ? '' : 's'} shortened`);
  }
  const where = cuts.length === 1 ? `on "${cuts[0].title}"` : `on ${cuts.length} pages`;
  const chars = all.reduce((n, s) => n + s.cut_chars, 0).toLocaleString('en-US');
  const titles = [...new Set(all.map((s) => s.source_title))];
  const named = titles.slice(0, SHOWN_TITLES).map((t) => `"${t}"`).join(', ');
  const more = titles.length > SHOWN_TITLES ? ` +${titles.length - SHOWN_TITLES} more` : '';
  return `prompt budget: ${counts.join(', ')} ${where} (${chars} chars): ${named}${more}`;
}
