/**
 * One run of the claim check: a compile's (plan 3.3, found_by
 * 'claim_check', pairs with a claim from the session's new sources) or the
 * whole-wiki check's (plan 3.6, found_by 'wiki_check', every pair).
 *
 *   1. candidate pairs not judged yet, ranked (./candidates.ts);
 *   2. the first `maxPairs` go to the judge (./judge.ts), each side with its
 *      source's title and date and its checked quote, the earlier-dated
 *      claim first;
 *   3. each answered batch is saved at once, in one transaction: every
 *      verdict in claim_verdicts (./verdicts.ts), and every disputed or
 *      outdated verdict as a possible disagreement on the subject's page
 *      (lib/disagreements.ts recordDisagreement, keyed by the pair, so it
 *      never doubles and never touches the owner's verdict);
 *   4. one claim_check_run activity row sums the run up.
 *
 * Findings (owner's choice, 2026-10-24): disputed → disputed, outdated →
 * changed (D5: the sides are the superseded claim and the provably newer
 * one). Scope, opinion and none verdicts are saved, so the pair is never
 * judged again, but are not shown to the owner. A finding's side b is the
 * newer claim of a change, else, in a compile, the new source's claim.
 *
 * Never throws for the judge's failures: a daily cost ceiling, a rate limit
 * or failed calls end the run early and are reported in the summary.
 */

import type Database from 'better-sqlite3';

import { getDb, logActivity } from '../db';
import { recordDisagreement, type DisagreementKind } from '../disagreements';
import { sourceDates, type SourceDate } from '../source-dates';
import { findCandidatePairs, type CandidatePair } from './candidates';
import { loadWikiClaims, subjectPages, type WikiClaim } from './claims';
import { judgeClaimPairs, type JudgePair, type JudgeStop, type JudgedPair, type JudgeSide } from './judge';
import { judgedPairKeys, saveClaimVerdict, type ClaimCheckFinder, type ClaimVerdict } from './verdicts';

/** The verdicts that become possible disagreements, and their kind in the record. */
const FINDING_KIND: Partial<Record<ClaimVerdict, DisagreementKind>> = {
  disputed: 'disputed',
  outdated: 'changed',
};

/** Examples kept in the activity row. */
const MAX_EXAMPLES = 3;

export interface ClaimCheckOptions {
  found_by: ClaimCheckFinder;
  model: string;
  /** Hard cap on pairs judged in this run. */
  maxPairs: number;
  session_id?: string | null;
  /** A compile's new sources; absent for the whole-wiki check. */
  newSourceIds?: ReadonlySet<string>;
  shouldStop?: () => JudgeStop | null;
  /** After each answered batch: pairs judged and findings so far. */
  onProgress?: (progress: { judged: number; findings: number }) => void;
}

export interface ClaimCheckSummary {
  /** Candidate pairs not judged yet when the run started. */
  candidates: number;
  /** Pairs sent to the judge (at most maxPairs). */
  selected: number;
  /** Pairs that got a verdict. */
  judged: number;
  /** Verdicts recorded as possible disagreements. */
  findings: number;
  by_kind: Partial<Record<DisagreementKind, number>>;
  calls: number;
  failed_calls: number;
  stopped: JudgeStop | null;
  examples: Array<{ page_id: string; page_title: string; topic: string; kind: DisagreementKind }>;
}

/** Candidate pairs not judged yet, ranked. `newSourceIds` limits them to a compile's sources. */
export function pendingClaimPairs(db: Database.Database, newSourceIds?: ReadonlySet<string>): CandidatePair[] {
  return findCandidatePairs(loadWikiClaims(db), {
    pageBySubject: subjectPages(db),
    judged: judgedPairKeys(db),
    newSourceIds,
  });
}

function side(claim: WikiClaim, dates: Map<string, SourceDate>, titles: Map<string, string>): JudgeSide {
  const date = dates.get(claim.source_id.toLowerCase());
  return {
    claim: claim.text,
    quote: claim.quote,
    source_title: titles.get(claim.source_id) ?? null,
    date: date?.date ?? null,
    date_kind: date?.date_kind ?? null,
  };
}

/** The titles of the given sources, by source_id. */
function sourceTitles(db: Database.Database, ids: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  const stmt = db.prepare('SELECT title FROM sources WHERE source_id = ?');
  for (const id of new Set(ids)) {
    const row = stmt.get(id) as { title: string } | undefined;
    if (row?.title) out.set(id, row.title);
  }
  return out;
}

/** The pair's claims, the earlier-dated first (undated last; ties by claim key). */
function chronological(pair: CandidatePair, dates: Map<string, SourceDate>): [WikiClaim, WikiClaim] {
  const day = (c: WikiClaim) => dates.get(c.source_id.toLowerCase())?.date ?? '9999-99-99';
  const [x, y] = [pair.first, pair.second];
  return day(x) < day(y) || (day(x) === day(y) && x.key < y.key) ? [x, y] : [y, x];
}

interface Prepared {
  pair: CandidatePair;
  a: WikiClaim;
  b: WikiClaim;
}

/** The finding's sides: a change's superseded claim then the newer one; else the new source's claim as b. */
function findingSides(p: Prepared, v: JudgedPair, newSourceIds?: ReadonlySet<string>): [WikiClaim, WikiClaim] {
  if (v.verdict === 'outdated') return v.newer === 'a' ? [p.b, p.a] : [p.a, p.b];
  if (newSourceIds && newSourceIds.has(p.a.source_id) && !newSourceIds.has(p.b.source_id)) return [p.b, p.a];
  return [p.a, p.b];
}

export async function runClaimCheck(options: ClaimCheckOptions): Promise<ClaimCheckSummary> {
  const db = getDb();
  const pairs = pendingClaimPairs(db, options.newSourceIds);
  const selected = pairs.slice(0, Math.max(0, options.maxPairs));
  const sourceIds = selected.flatMap((p) => [p.first.source_id, p.second.source_id]);
  const dates = sourceDates(db, sourceIds);
  const titles = sourceTitles(db, sourceIds);
  const prepared = new Map<string, Prepared>();
  const judgeInput: JudgePair[] = selected.map((pair) => {
    const [a, b] = chronological(pair, dates);
    prepared.set(pair.pair_key, { pair, a, b });
    return { pair_id: pair.pair_key, subject: pair.subject, a: side(a, dates, titles), b: side(b, dates, titles) };
  });

  const summary: ClaimCheckSummary = {
    candidates: pairs.length,
    selected: selected.length,
    judged: 0,
    findings: 0,
    by_kind: {},
    calls: 0,
    failed_calls: 0,
    stopped: null,
    examples: [],
  };
  const pageTitle = db.prepare('SELECT title FROM pages WHERE page_id = ?');

  const save = db.transaction((verdicts: JudgedPair[]) => {
    for (const v of verdicts) {
      const p = prepared.get(v.pair_id);
      if (!p) continue;
      const kept = saveClaimVerdict(db, {
        pair_key: p.pair.pair_key,
        source_a: p.a.source_id,
        claim_a: p.a.text,
        source_b: p.b.source_id,
        claim_b: p.b.text,
        subject: p.pair.subject,
        verdict: v.verdict,
        topic: v.topic,
        reason: v.reason || null,
        newer: v.verdict === 'outdated' ? v.newer : null,
        found_by: options.found_by,
        model: options.model,
        session_id: options.session_id ?? null,
      });
      if (!kept) continue;
      summary.judged++;
      const kind = FINDING_KIND[v.verdict];
      if (!kind) continue;
      const page = pageTitle.get(p.pair.page_id) as { title: string } | undefined;
      if (!page) continue;
      const [sa, sb] = findingSides(p, v, options.newSourceIds);
      try {
        // Its own savepoint: a finding that cannot be recorded never loses the batch's verdicts.
        db.transaction(() =>
          recordDisagreement(db, {
            page_id: p.pair.page_id,
            found_by: options.found_by,
            kind,
            key: `claims:${p.pair.pair_key}`,
            topic: v.topic || p.pair.subject,
            reason: v.reason || null,
            source_a: sa.source_id,
            quote_a: sa.quote,
            source_b: sb.source_id,
            quote_b: sb.quote,
            session_id: options.session_id ?? null,
          }),
        )();
      } catch (err) {
        console.error('[claim-check] finding not recorded', p.pair.page_id, err instanceof Error ? err.message : err);
        continue;
      }
      summary.findings++;
      summary.by_kind[kind] = (summary.by_kind[kind] ?? 0) + 1;
      if (summary.examples.length < MAX_EXAMPLES) {
        summary.examples.push({ page_id: p.pair.page_id, page_title: page.title, topic: v.topic || p.pair.subject, kind });
      }
    }
  });

  if (judgeInput.length > 0) {
    const outcome = await judgeClaimPairs(judgeInput, options.model, {
      shouldStop: options.shouldStop,
      onBatch: (verdicts) => {
        save(verdicts);
        options.onProgress?.({ judged: summary.judged, findings: summary.findings });
      },
    });
    summary.calls = outcome.calls;
    summary.failed_calls = outcome.failed_calls;
    summary.stopped = outcome.stopped;

    logActivity('claim_check_run', {
      source_id: null,
      session_id: options.session_id ?? null,
      step_key: options.found_by === 'claim_check' ? 'claims' : null,
      details: {
        found_by: options.found_by,
        model: options.model,
        candidates: summary.candidates,
        selected: summary.selected,
        judged: summary.judged,
        findings: summary.findings,
        by_kind: summary.by_kind,
        failed_calls: summary.failed_calls,
        stopped: summary.stopped,
        examples: summary.examples,
      },
    });
  }
  return summary;
}
