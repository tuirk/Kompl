/**
 * Step 5 of the wiki repair (owner decision D7): the label merge a compile
 * makes for its new labels (lib/compile/label-merge.ts, nlp-service
 * /pipeline/consolidate-labels), made once over the whole wiki's labels.
 *
 * Every label goes in as "new", most used first (at most
 * MAX_REPAIR_LABELS), with its page count, so any label may merge into any
 * other; the service only returns merges into a label it was given, and only
 * of the smaller label into the bigger (owner decision 2026-10-25: a part of
 * a combined label and a 1-2 page label inside a more-used one's name fold
 * into it). This module only applies merges into a label it sent.
 * A page whose label merges gets the new label on its page row and in its
 * frontmatter `category:` line, through the outbox commit (CLAUDE.md rule 5,
 * lib/page-rewrite.ts), which keeps the previous version. Pages Kompl does
 * not draft (source notes) only get the new label on their page row; their
 * text is never changed. Saved Links is never touched.
 */

import type Database from 'better-sqlite3';

import { getCategoryGroups, getPage, readPageMarkdown } from '../db';
import { wikiLabelCounts } from '../compile/draft-labels';
import { yamlLabel } from '../compile/label-merge';
import { APP_PAGE_IDS, isDraftedPage } from '../draft-rules';
import { commitPageRewrite, pageVersionToken } from '../page-rewrite';
import { replaceFrontmatterField } from '../yaml-frontmatter';
import { postNlp } from './calls';
import { MAX_REPAIR_LABELS } from './limits';

const LABEL_CALL_TIMEOUT_MS = 120_000;

/** The wiki's labels the call is shown: most used first, then by name. */
export function repairLabels(): string[] {
  const counts = wikiLabelCounts();
  return [...counts.keys()]
    .sort((a, b) => counts.get(b)! - counts.get(a)! || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_REPAIR_LABELS);
}

/**
 * One AI call: which labels mean the same as another. Returns label → the
 * label it becomes (chains followed to their end). Throws RepairCallError.
 */
export async function consolidateWikiLabels(labels: string[], model: string): Promise<Map<string, string>> {
  const target = new Map<string, string>();
  if (labels.length < 2) return target;
  const counts = wikiLabelCounts();
  const pageCounts = Object.fromEntries(labels.map((l) => [l, counts.get(l) ?? 0]));
  const res = await postNlp<{ items: Array<{ label: string; into: string }> }>(
    '/pipeline/consolidate-labels',
    { existing_labels: [], new_labels: labels, page_counts: pageCounts, compile_model: model },
    LABEL_CALL_TIMEOUT_MS,
  );
  const sent = new Set(labels);
  for (const { label, into } of res.items) {
    if (sent.has(label) && sent.has(into) && label !== into && !target.has(label)) target.set(label, into);
  }
  const final = new Map<string, string>();
  for (const label of target.keys()) {
    let end = label;
    const seen = new Set<string>();
    while (target.has(end) && !seen.has(end)) {
      seen.add(end);
      end = target.get(end)!;
    }
    if (end !== label) final.set(label, end);
  }
  return final;
}

export interface LabelOutcome {
  /** Labels renamed. */
  merged: number;
  /** Pages that took the new label. */
  pages: number;
  /** Pages that changed meanwhile and kept their label. */
  missed: number;
}

/** Gives every page with a merged label its new one. */
export async function applyLabelMerges(db: Database.Database, target: Map<string, string>): Promise<LabelOutcome> {
  const outcome: LabelOutcome = { merged: 0, pages: 0, missed: 0 };
  if (target.size === 0) return outcome;
  const used = new Set<string>();
  const setColumn = db.prepare('UPDATE pages SET category = ? WHERE page_id = ? AND category = ?');
  for (const group of getCategoryGroups()) {
    const into = target.get(group.category);
    if (!into) continue;
    for (const row of group.pages) {
      if (APP_PAGE_IDS.has(row.page_id)) continue;
      const page = getPage(row.page_id);
      if (!page || page.category !== group.category) continue;
      const markdown = isDraftedPage(page) && page.pending_content === null ? readPageMarkdown(page.page_id) : null;
      const relabelled = markdown ? replaceFrontmatterField(markdown, 'category', yamlLabel(into)) : null;
      if (relabelled === null) {
        // No text to change (a source note, a page without the line): the label only.
        if (setColumn.run(into, page.page_id, group.category).changes > 0) outcome.pages++;
        else outcome.missed++;
      } else {
        const result = await commitPageRewrite({
          pageId: page.page_id,
          markdown: relabelled,
          expectedToken: pageVersionToken(page.page_id),
          draftRules: null,
          activity: null,
          category: into,
        });
        if (result.ok) outcome.pages++;
        else outcome.missed++;
      }
      used.add(group.category);
    }
  }
  outcome.merged = used.size;
  return outcome;
}
