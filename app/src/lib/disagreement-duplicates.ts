/**
 * One disagreement, one finding shown. The claim check keys its findings by
 * page, kind and pair of sources (lib/claim-check/record-finding.ts), but
 * runs before that keyed them by claim pair, so a page can hold several
 * findings for one disagreement. Those rows stay stored as they are (owner
 * verdicts included); the read models (page panel, MCP read_page,
 * recent_changes, wiki_status) hide the extra ones with hiddenDuplicates.
 *
 * Among the checks' findings (claim_check, wiki_check) on one page with the
 * same kind and the same two sources, one is shown: the one the owner judged
 * last, else the oldest. A shown one the owner has not judged is hidden too
 * when the page's own open text (a page_text finding not cleared and not
 * dismissed) already cites both of its sources. Page-text findings and
 * triage findings are never hidden.
 */

import type Database from 'better-sqlite3';

import { fromRow, type Disagreement, type DisagreementFinder, type DisagreementRow } from './disagreements';

const CHECK_FINDERS: ReadonlySet<DisagreementFinder> = new Set(['claim_check', 'wiki_check']);

/** The ids, lowercased, deduplicated and sorted. */
function pairOf(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))].sort();
}

/** Does `cited` include both of `pair`'s sources? */
export function citesBoth(cited: readonly string[], pair: readonly string[]): boolean {
  const lower = new Set(cited.map((id) => id.toLowerCase()));
  return pair.length === 2 && pair.every((id) => lower.has(id.toLowerCase()));
}

/** The page's own open text: page-text findings not cleared and not dismissed. */
export function isOpenPageText(r: Pick<Disagreement, 'found_by' | 'cleared_at' | 'status'>): boolean {
  return r.found_by === 'page_text' && r.cleared_at === null && r.status !== 'dismissed';
}

/** Of findings for one disagreement, the one to show: the owner's latest verdict, else the oldest. */
export function representative<T extends Pick<Disagreement, 'owner_verdict' | 'owner_verdict_at' | 'created_at'>>(
  rows: readonly T[],
): T | undefined {
  const judged = rows.filter((r) => r.owner_verdict !== null);
  if (judged.length > 0) {
    return judged.reduce((best, r) => ((r.owner_verdict_at ?? '') > (best.owner_verdict_at ?? '') ? r : best));
  }
  return rows.reduce<T | undefined>((best, r) => (!best || r.created_at < best.created_at ? r : best), undefined);
}

/** The ids of the findings the read models leave out (see the header). */
export function hiddenDuplicates(records: readonly Disagreement[]): Set<string> {
  const hidden = new Set<string>();
  const groups = new Map<string, Disagreement[]>();
  for (const r of records) {
    if (!CHECK_FINDERS.has(r.found_by)) continue;
    const pair = pairOf(r.source_ids);
    if (pair.length !== 2) continue;
    const key = [r.page_id, r.kind, ...pair].join('\u0000');
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const openText = records.filter(isOpenPageText);
  for (const rows of groups.values()) {
    const shown = representative(rows)!;
    for (const r of rows) if (r !== shown) hidden.add(r.disagreement_id);
    const covered = openText.some((t) => t.page_id === shown.page_id && citesBoth(t.source_ids, shown.source_ids));
    if (covered && shown.owner_verdict === null) hidden.add(shown.disagreement_id);
  }
  return hidden;
}

/** hiddenDuplicates over every finding on the given pages (open and cleared alike). */
export function hiddenDuplicatesOnPages(db: Database.Database, pageIds: Iterable<string>): Set<string> {
  const ids = [...new Set(pageIds)];
  if (ids.length === 0) return new Set();
  const rows = db
    .prepare(`SELECT * FROM disagreements WHERE page_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, rowid`)
    .all(JSON.stringify(ids)) as DisagreementRow[];
  return hiddenDuplicates(rows.map(fromRow));
}
