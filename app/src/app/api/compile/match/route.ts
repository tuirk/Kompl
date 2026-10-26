/**
 * POST /api/compile/match
 *
 * Part 2d — Wiki-Aware Updates: LLM triage against existing pages.
 *
 * For returning sessions (page_count > 0), calls /pipeline/triage for each
 * session source against at most MAX_TRIAGE_CANDIDATES_PER_SOURCE
 * non-summary pages: first the pages whose subject the source names, then
 * pages TF-IDF finds similar (lib/triage-candidates.ts). Each call is
 * judged on the claims the source's extraction makes about the page, with
 * the page's related section, or on the source's text when it makes none
 * (lib/triage-evidence.ts).
 *
 * A triage call that gives no verdict (rate limit, daily cost ceiling, any
 * other error) is decision 'triage_failed' with the cause as its reason,
 * never 'skip': plan makes nothing from it (no plan, no provenance link),
 * so nothing records the source as checked against that page. Failures are
 * counted in stats.triage_failed and logged as one match_triage_failed
 * activity row. Each one is also stored (lib/triage-rechecks.ts) for a later
 * compile to check again.
 *
 * will_plan (default true) says whether plan will run on this step's
 * matches. Only then may match re-check stored failures
 * (lib/compile/triage-recheck.ts, behind a switch that is off by default)
 * and drop a stored pair that a triage has now answered; otherwise the
 * verdicts would be lost with the pairs.
 *
 * Short-circuits to { skipped: true, matches: [] } for first-compile
 * sessions (no existing pages to match against).
 *
 * Request:  { session_id: string, canonical_entities: unknown[], will_plan?: boolean }
 * Response: { session_id, skipped, matches, stats }
 */

import { NextResponse } from 'next/server';
import {
  getEffectiveCompileModel,
  getPageCount,
  getPagesByType,
  getSourcesBySession,
  logActivity,
  readRawMarkdown,
  updateCompileStep,
} from '@/lib/db';
import { activeRedo } from '@/lib/compile-redo/state';
import { NO_RECHECKS, recheckStoredTriages } from '@/lib/compile/triage-recheck';
import { callTriage, triageFailureOf, type MatchEntry, type TriageFailure, type TriageResponse } from '@/lib/triage-call';
import { SAVED_LINKS_PAGE_ID } from '@/lib/lint-result';
import { namesInSource, pickTriageCandidates, sharesSubject } from '@/lib/triage-candidates';
import { claimsAbout, readExtraction, readTriageInput, subjectNames, triageAliases } from '@/lib/triage-evidence';
import { recordTriageFailure, removeTriagePair } from '@/lib/triage-rechecks';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

interface TfidfMatch {
  page_id: string;
  similarity: number;
}

interface TfidfResponse {
  overlap_score: number;
  top_matches: TfidfMatch[];
}

/** Shown in the activity row; the full list is in the step's matches. */
const MAX_FAILURE_EXAMPLES = 5;

const NO_MATCH_STATS = {
  sources_checked: 0, candidates_found: 0, updates: 0, contradictions: 0, skips: 0, triage_failed: 0, ...NO_RECHECKS,
};

async function callTfidfOverlap(
  sourceText: string,
  corpusPageIds: string[]
): Promise<TfidfResponse> {
  const res = await fetch(`${NLP_SERVICE_URL}/extract/tfidf-overlap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_text: sourceText, corpus_page_ids: corpusPageIds }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`tfidf-overlap failed: ${res.status}`);
  return res.json() as Promise<TfidfResponse>;
}

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const body = rawBody as Record<string, unknown>;
  const { session_id } = body as { session_id?: string };
  if (typeof session_id !== 'string' || !session_id.trim()) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }
  if (body.will_plan !== undefined && typeof body.will_plan !== 'boolean') {
    return NextResponse.json({ error: 'will_plan must be a boolean' }, { status: 422 });
  }
  const willPlan = body.will_plan !== false;

  try {
  // Short-circuit for first compile (no existing pages). No page, so no
  // stored pair either (deleting a page removes its pairs).
  const pageCount = getPageCount();
  if (pageCount === 0) {
    return NextResponse.json({ session_id, skipped: true, matches: [], stats: NO_MATCH_STATS });
  }

  // Build TF-IDF candidate corpus from non-summary pages. Kompl's own Saved
  // Links page is an overview too, but no source ever updates it (an eval run
  // planned 10 updates of it on 2026-10-25, one failing as no_pages_to_list).
  // A re-plan of this compile (lib/compile-redo/) leaves out the pages the
  // compile itself created: the sources would only match their own text,
  // and the new plan decides from scratch whether those pages stay.
  const redo = activeRedo(session_id);
  const ownPages = new Set(redo?.point === 'plan' ? redo.own_pages.map((p) => p.page_id) : []);
  const candidatePages = getPagesByType(['entity', 'concept', 'comparison', 'overview'])
    .filter((p) => p.page_id !== SAVED_LINKS_PAGE_ID && !ownPages.has(p.page_id));
  if (candidatePages.length === 0) {
    return NextResponse.json({ session_id, skipped: true, matches: [], stats: NO_MATCH_STATS });
  }

  const corpusPageIds = candidatePages.map((p) => p.page_id);
  const pageById = new Map(candidatePages.map((p) => [p.page_id, p]));
  const sources = getSourcesBySession(session_id);
  const aliases = triageAliases();

  const matches: MatchEntry[] = [];
  const failures: MatchEntry[] = [];
  let totalCandidates = 0;
  let updates = 0;
  let contradictions = 0;
  let skips = 0;

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    // Live progress for the UI's "Checking existing wiki" tracker. Without
    // this the step shows just "PROCESSING" with no count while peer steps
    // (extract, ingest_*) show X/Y. Mirrors the per-completion update
    // pattern used by the extract worker pool and runPerItemStep.
    updateCompileStep(
      session_id,
      'match',
      'running',
      `${i}/${sources.length} sources checked`,
    );
    const markdown = readRawMarkdown(source.source_id);
    if (!markdown) continue;
    const extraction = readExtraction(source.source_id);

    // Pages whose subject this source names, with its claims about each.
    const named = namesInSource(source.source_id);
    const shared = candidatePages
      .filter((p) => sharesSubject(p, named))
      .map((p) => ({ page_id: p.page_id, title: p.title, claims: claimsAbout(extraction, subjectNames(p, aliases)).length }));

    // TF-IDF ranks them and fills the slots they leave. A failure is not
    // fatal: the shared-entity pages are still checked.
    let tfidfMatches: TfidfMatch[] = [];
    try {
      tfidfMatches = (await callTfidfOverlap(markdown, corpusPageIds)).top_matches;
    } catch {
      if (shared.length === 0) continue;
    }

    const topCandidates = pickTriageCandidates(shared, tfidfMatches);
    totalCandidates += topCandidates.length;

    for (const pageId of topCandidates) {
      const page = pageById.get(pageId);
      if (!page) continue;

      const existingSummary = page.summary ?? '';
      // Judged on the source's claims about the page, else its text.
      const input = readTriageInput(markdown, extraction, page, aliases);

      let triageResult: TriageResponse;
      try {
        triageResult = await callTriage(input, existingSummary, page.title, getEffectiveCompileModel(session_id));
      } catch (err) {
        // No verdict is not a 'skip': plan must not record this source on
        // the page (see the header). Stored for a later re-check.
        const failure = triageFailureOf(err);
        console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'match_triage_failed', session_id, source_id: source.source_id, page_id: page.page_id, reason: failure, error: err instanceof Error ? err.message : String(err) }));
        recordTriageFailure(source.source_id, page.page_id, failure, session_id);
        const failed: MatchEntry = {
          source_id: source.source_id,
          page_id: page.page_id,
          page_title: page.title,
          decision: 'triage_failed',
          reason: failure,
        };
        matches.push(failed);
        failures.push(failed);
        continue;
      }

      matches.push({
        source_id: source.source_id,
        page_id: page.page_id,
        page_title: page.title,
        decision: triageResult.decision,
        reason: triageResult.reason,
      });
      // Answered: an earlier failure of this pair is settled once plan
      // takes the verdict.
      if (willPlan) removeTriagePair(source.source_id, page.page_id);

      if (triageResult.decision === 'update') updates++;
      else if (triageResult.decision === 'contradiction') contradictions++;
      else skips++;
    }
  }

  const rechecks = willPlan ? await recheckStoredTriages(session_id) : { matches: [], stats: NO_RECHECKS };
  matches.push(...rechecks.matches);

  if (failures.length > 0) {
    const count = (f: TriageFailure) => failures.filter((m) => m.reason === f).length;
    const sourceTitle = new Map(sources.map((s) => [s.source_id, s.title]));
    logActivity('match_triage_failed', {
      source_id: null,
      session_id,
      step_key: 'match',
      details: {
        session_id,
        failed: failures.length,
        cost_ceiling: count('daily_cost_ceiling'),
        rate_limited: count('llm_rate_limited'),
        errors: count('triage_error'),
        examples: failures.slice(0, MAX_FAILURE_EXAMPLES).map((m) => ({
          source_title: sourceTitle.get(m.source_id) ?? null,
          page_title: m.page_title,
        })),
      },
    });
  }

  return NextResponse.json({
    session_id,
    skipped: false,
    matches,
    stats: {
      sources_checked: sources.length,
      candidates_found: totalCandidates,
      updates,
      contradictions,
      skips,
      triage_failed: failures.length,
      ...rechecks.stats,
    },
  });
  } catch (err) {
    // Own the stack trace here — orchestrator only sees the serialised message.
    console.error('[match]', err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
