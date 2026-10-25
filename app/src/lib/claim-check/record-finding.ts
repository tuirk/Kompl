/**
 * A claim-check verdict as a possible disagreement (run.ts): one finding
 * per page, finder, kind and pair of SOURCES, however many claim pairs
 * between those two sources the judge flags.
 *
 *   - An open page-text finding (not cleared, not dismissed) that already
 *     cites both sources is that disagreement: nothing new is recorded, and
 *     the verdict's sides, quotes and reason go on that finding when it has
 *     none of its own.
 *   - Else the finding for the pair is refreshed, whatever key an earlier
 *     run stored it under (runs before this keyed findings by claim pair),
 *     unless it holds more checked quotes than the verdict: the strongest
 *     quotes win, the most recent on a tie, and the sides, quotes and reason
 *     always come from the same verdict.
 *   - Else a new finding is recorded, keyed `sources:<kind>:<a>|<b>`.
 *
 * Status and the owner's verdict are never touched (recordDisagreement).
 * Synchronous; runs inside run.ts's transaction.
 */

import type Database from 'better-sqlite3';

import { citesBoth, isOpenPageText, representative } from '../disagreement-duplicates';
import { fromRow, recordDisagreement, type DisagreementKind, type DisagreementRow } from '../disagreements';
import type { ClaimCheckFinder } from './verdicts';

export interface ClaimFinding {
  page_id: string;
  found_by: ClaimCheckFinder;
  kind: DisagreementKind;
  topic: string;
  reason: string | null;
  source_a: string;
  quote_a: string | null;
  source_b: string;
  quote_b: string | null;
  session_id: string | null;
}

/** recorded: a check finding was added or refreshed; kept: a stronger one was left as is; covered: the page text records it. */
export type ClaimFindingOutcome = { outcome: 'recorded' | 'kept' | 'covered'; disagreement_id: string };

/** The key of a new finding: kind and the two sources, in either order. */
export function sourcePairKey(kind: DisagreementKind, a: string, b: string): string {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort();
  return `sources:${kind}:${x}|${y}`;
}

const checkedQuotes = (f: { quote_a: string | null; quote_b: string | null }) => (f.quote_a ? 1 : 0) + (f.quote_b ? 1 : 0);

export function recordClaimFinding(db: Database.Database, f: ClaimFinding): ClaimFindingOutcome {
  const pair = [f.source_a, f.source_b];
  const onPage = (db.prepare('SELECT * FROM disagreements WHERE page_id = ? ORDER BY created_at, rowid').all(f.page_id) as DisagreementRow[]).map(
    fromRow,
  );

  const text = onPage.find((r) => isOpenPageText(r) && citesBoth(r.source_ids, pair));
  if (text) {
    // Lend the verdict's evidence to the page's own finding, filling only what it lacks.
    if (text.reason === null && f.reason) {
      db.prepare(`UPDATE disagreements SET reason = ?, updated_at = datetime('now') WHERE disagreement_id = ?`).run(
        f.reason,
        text.disagreement_id,
      );
    }
    // Sides and quotes go together, so only onto a finding that has none.
    const bare = !text.source_a && !text.source_b && !text.quote_a && !text.quote_b;
    if (bare && checkedQuotes(f) > 0) {
      db.prepare(
        `UPDATE disagreements SET source_a = ?, quote_a = ?, source_b = ?, quote_b = ?, updated_at = datetime('now')
          WHERE disagreement_id = ?`,
      ).run(f.source_a, f.quote_a, f.source_b, f.quote_b, text.disagreement_id);
    }
    return { outcome: 'covered', disagreement_id: text.disagreement_id };
  }

  const key = sourcePairKey(f.kind, f.source_a, f.source_b);
  const same = onPage.filter(
    (r) => r.found_by === f.found_by && r.kind === f.kind && (r.match_key === key || citesBoth(r.source_ids, pair)),
  );
  const stored = representative(same);
  if (stored && checkedQuotes(stored) > checkedQuotes(f)) return { outcome: 'kept', disagreement_id: stored.disagreement_id };

  const result = recordDisagreement(
    db,
    {
      page_id: f.page_id,
      found_by: f.found_by,
      kind: f.kind,
      key: stored?.match_key ?? key,
      topic: f.topic,
      reason: f.reason,
      source_a: f.source_a,
      quote_a: f.quote_a,
      source_b: f.source_b,
      quote_b: f.quote_b,
      session_id: f.session_id,
    },
    { replaceQuotes: true },
  );
  return { outcome: 'recorded', disagreement_id: result.disagreement_id };
}
