/**
 * The 'labels' compile step (plan 2.3, owner decision D7): one AI call per
 * compile merges the category labels this compile added into labels that
 * mean the same thing ("Crypto" into "Cryptocurrency").
 *
 * Runs after crossref and before commit, on this session's drafts waiting
 * to commit. Only each draft's frontmatter `category:` line changes, never
 * its text, so the commit writes every page once, with its final label,
 * through the outbox (CLAUDE.md rule 5), and drafts queued for approval
 * (auto-approve off) carry it too.
 *
 * A label is new when no live page has it yet. Labels the wiki already had
 * are never renamed, so a label set before this compile (by an earlier
 * compile, an import or, later, by hand) stays as it is; merging old labels
 * is the wiki-wide Repair run's job (plan Phase 4). A case variant of a known
 * label is merged without a call. The call is made only when the drafts add
 * at least one new label, and skipping it (daily cost cap, rate limit,
 * failure) never fails the compile.
 */

import { getDb, getPage, getPagePlansByStatus, logActivity } from '../db';
import { yamlDoubleQuote } from '../yaml-escape';
import { replaceFrontmatterField } from '../yaml-frontmatter';
import { draftLabel, labelKey, wikiLabelCounts } from './draft-labels';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

/** Most labels one call sends (nlp-service routers/labels.py checks the same). */
export const MAX_EXISTING_LABELS = 300;
export const MAX_NEW_LABELS = 100;
// One short call (at most 4096 output tokens); a slow answer only skips the merge.
const LABEL_MERGE_TIMEOUT_MS = 120_000;

export interface LabelMergeOutcome {
  /** Step detail for the progress page. */
  detail: string;
  /** Labels renamed in this session's drafts. */
  merged: number;
  /** Drafts whose label changed. */
  drafts: number;
}

interface LabelledDraft {
  plan_id: string;
  markdown: string;
  label: string;
}

/**
 * This session's drafts waiting to commit whose label the commit will store:
 * new pages, and updates of pages without a label (an update keeps the
 * page's own label, lib/db.ts insertPage).
 */
function labelledDrafts(sessionId: string): LabelledDraft[] {
  const drafts: LabelledDraft[] = [];
  for (const plan of getPagePlansByStatus(sessionId, 'crossreffed')) {
    if (plan.action === 'provenance-only' || !plan.draft_content) continue;
    if (plan.action === 'update' && plan.existing_page_id && getPage(plan.existing_page_id)?.category != null) continue;
    const label = draftLabel(plan.draft_content);
    if (label) drafts.push({ plan_id: plan.plan_id, markdown: plan.draft_content, label });
  }
  return drafts;
}

/** Most used first, then by name, so the same wiki always sends the same list. */
function byUse(counts: Map<string, number>): string[] {
  return [...counts.keys()].sort((a, b) => counts.get(b)! - counts.get(a)! || (a < b ? -1 : a > b ? 1 : 0));
}

const SKIP_REASONS: Record<number, string> = {
  429: 'rate limited',
  503: 'daily cost limit reached',
};

async function callConsolidate(
  existing: string[],
  fresh: string[],
  compileModel: string,
): Promise<{ merges: Array<{ label: string; into: string }> } | { skipped: string }> {
  try {
    const res = await fetch(`${NLP_SERVICE_URL}/pipeline/consolidate-labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ existing_labels: existing, new_labels: fresh, compile_model: compileModel }),
      signal: AbortSignal.timeout(LABEL_MERGE_TIMEOUT_MS),
    });
    if (!res.ok) return { skipped: SKIP_REASONS[res.status] ?? 'merge check failed' };
    const body = (await res.json()) as { items: Array<{ label: string; into: string }> };
    return { merges: body.items };
  } catch {
    return { skipped: 'merge check failed' };
  }
}

/** The label as a YAML scalar: plain when that reads back the same. */
function yamlLabel(label: string): string {
  return /^[\p{L}\p{N}][^"\\#:\r\n]*$/u.test(label) && label === label.trim() ? label : yamlDoubleQuote(label);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function describeOutcome(merged: number, drafts: number, fresh: number, skipped: string | null): string {
  const parts: string[] = [];
  if (merged > 0) parts.push(`${plural(merged, 'category', 'categories')} merged (${plural(drafts, 'page', 'pages')})`);
  if (skipped) parts.push(`${fresh} new not checked: ${skipped}`);
  else if (merged === 0) parts.push(fresh > 0 ? `${fresh} new, none merged` : 'no new categories');
  return parts.join(' · ');
}

/**
 * Merges this session's new draft labels. `assertActive` runs after the call
 * and throws when the compile was cancelled or superseded meanwhile; nothing
 * is written then.
 */
export async function mergeDraftLabels(
  sessionId: string,
  compileModel: string,
  assertActive: () => void,
): Promise<LabelMergeOutcome> {
  const drafts = labelledDrafts(sessionId);
  const wiki = wikiLabelCounts();
  const wikiByKey = new Map([...wiki.keys()].map((l) => [labelKey(l), l]));

  // label → the label it becomes. Case variants first, no call needed: of a
  // wiki label, the wiki's spelling; of each other, the most used spelling.
  const target = new Map<string, string>();
  const spellings = new Map<string, Map<string, number>>();
  for (const { label } of drafts) {
    if (wiki.has(label)) continue;
    const known = wikiByKey.get(labelKey(label));
    if (known) {
      target.set(label, known);
      continue;
    }
    const group = spellings.get(labelKey(label)) ?? new Map<string, number>();
    group.set(label, (group.get(label) ?? 0) + 1);
    spellings.set(labelKey(label), group);
  }
  const freshCounts = new Map<string, number>();
  for (const group of spellings.values()) {
    const [main, ...variants] = byUse(group);
    for (const v of variants) target.set(v, main);
    freshCounts.set(main, [...group.values()].reduce((s, n) => s + n, 0));
  }
  const fresh = byUse(freshCounts).slice(0, MAX_NEW_LABELS);

  let skipped: string | null = null;
  if (fresh.length > 0) {
    const existing = byUse(wiki).slice(0, MAX_EXISTING_LABELS);
    const answer = await callConsolidate(existing, fresh, compileModel);
    assertActive();
    if ('skipped' in answer) {
      skipped = answer.skipped;
      console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'labels_merge_skipped', session_id: sessionId, reason: skipped, new_labels: fresh.length }));
    } else {
      // nlp-service already checks this; only merges of a label sent as new
      // into a label sent are applied.
      const sentNew = new Set(fresh);
      const sent = new Set([...existing, ...fresh]);
      for (const { label, into } of answer.merges) {
        if (sentNew.has(label) && sent.has(into) && label !== into && !target.has(label)) target.set(label, into);
      }
    }
  }

  const finalLabel = (label: string): string => {
    const seen = new Set<string>();
    while (target.has(label) && !seen.has(label)) {
      seen.add(label);
      label = target.get(label)!;
    }
    return label;
  };

  // Phase 2-style sync transaction: no await, no file I/O. A draft changed
  // since it was read (compare-and-set on its text) is left as it now is.
  const db = getDb();
  const applied = new Map<string, { into: string; pages: number }>();
  let changed = 0;
  db.transaction(() => {
    const update = db.prepare(
      `UPDATE page_plans SET draft_content = ?
        WHERE plan_id = ? AND draft_status = 'crossreffed' AND draft_content = ?`
    );
    for (const d of drafts) {
      const into = finalLabel(d.label);
      if (into === d.label) continue;
      const markdown = replaceFrontmatterField(d.markdown, 'category', yamlLabel(into));
      if (markdown === null || update.run(markdown, d.plan_id, d.markdown).changes === 0) continue;
      changed++;
      const entry = applied.get(d.label) ?? { into, pages: 0 };
      entry.pages++;
      applied.set(d.label, entry);
    }
    if (changed > 0) {
      logActivity('labels_merged', {
        source_id: null,
        session_id: sessionId,
        step_key: 'labels',
        details: {
          merged: applied.size,
          drafts: changed,
          merges: [...applied].map(([label, { into, pages }]) => ({ label, into, pages })),
        },
      });
    }
  })();

  return {
    detail: describeOutcome(applied.size, changed, fresh.length, skipped),
    merged: applied.size,
    drafts: changed,
  };
}
