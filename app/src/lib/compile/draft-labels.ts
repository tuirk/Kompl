/**
 * Category labels ("Crypto", "Travel"): one per page, kept in pages.category
 * and in the page's frontmatter `category:` line.
 *
 * Drafts are offered the wiki's labels so they reuse one instead of
 * inventing a near copy. DraftLabels keeps that list for one draft run and
 * grows it as each draft finishes, so drafts starting later in the same run
 * (even in the same layer) see the labels earlier drafts added. The end-of-
 * compile merge (lib/compile/label-merge.ts) catches the copies parallel
 * drafts still invent.
 */

import { getCategoryGroups } from '../db';
import { extractFrontmatterField } from '../yaml-frontmatter';

// Never offered or merged. 'Uncategorized' stands for "no label"; 'General'
// is a sink the model would reuse for every page once offered.
const NOT_LABELS = new Set(['uncategorized', 'general']);

/** Case-insensitive key two spellings of one label share. */
export function labelKey(label: string): string {
  return label.trim().toLowerCase();
}

export function isPageLabel(label: string | null | undefined): label is string {
  return typeof label === 'string' && label.trim() !== '' && !NOT_LABELS.has(labelKey(label));
}

/** The label a draft's frontmatter gives its page, if it is a real one. */
export function draftLabel(markdown: string): string | null {
  const label = extractFrontmatterField(markdown, 'category');
  return isPageLabel(label) ? label.trim() : null;
}

/** Labels on the wiki's live pages with their page counts, by label name. */
export function wikiLabelCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const g of getCategoryGroups()) {
    if (isPageLabel(g.category)) counts.set(g.category, g.pages.length);
  }
  return counts;
}

export class DraftLabels {
  private readonly labels: string[] = [];
  private readonly keys = new Set<string>();

  constructor(existing: Iterable<string>) {
    for (const label of existing) this.add(label);
  }

  /**
   * The list a draft starting now is offered: the wiki's labels, then the
   * ones this run's drafts added, in the order those drafts finished.
   */
  list(): string[] {
    return [...this.labels];
  }

  /**
   * Records the label of a draft that just finished. A spelling that only
   * differs in case from a listed label is not listed again.
   */
  addFromDraft(markdown: string): void {
    const label = draftLabel(markdown);
    if (label) this.add(label);
  }

  private add(label: string): void {
    if (!isPageLabel(label) || this.keys.has(labelKey(label))) return;
    this.keys.add(labelKey(label));
    this.labels.push(label.trim());
  }
}
