// Outer-timeout formulas for run/route.ts orchestrator wrappers. Compute
// headersTimeout = bodyTimeout = AbortSignal.timeout from the work-size N
// already known to the orchestrator. Replaces the static AbortSignal.timeout
// constants shipped in PR #71 (commit b7b2d48) — those were ticking bombs
// that would fire at N+1.
//
// Each formula returns Math.max(FLOOR_MS, ceil(rate * N * OVERHEAD) +
// HEADROOM_MS). Floors guard against degenerate N=0/1 producing sub-second
// timeouts. OVERHEAD covers per-call latency variance; HEADROOM_MS covers
// I/O blips (DNS, slow disk) independent of the work itself.
//
// Tuning: per-item rates are derived from the inner-call AbortSignals at
// each route. If a wrapper still fires legitimately, change the rate
// constant in this file (one place); do not retune at the call site.

import { disambiguatePairCap } from './resolve-ranking';

const OVERHEAD = 1.2;          // 20% relative slack for per-call variance
const HEADROOM_MS = 180_000;   // 3 min absolute headroom for I/O blips

// Floors per wrapper — ensures N=0/1 still produces a usable timeout.
const RESOLVE_FLOOR_MS  = 300_000; // 5 min
const MATCH_FLOOR_MS    = 120_000; // 2 min
const DRAFT_FLOOR_MS    = 600_000; // 10 min — single-plan inner ceiling
const CROSSREF_FLOOR_MS = 120_000; // 2 min
const COMMIT_FLOOR_MS   = 120_000; // 2 min

// Per-item rates — see the inline rationale comments in run/route.ts wrappers.
const RESOLVE_PER_SOURCE_MS = 60_000;  // ~2 disambiguate batches × 30s avg
const MATCH_PER_PAIR_MS     = 60_000;  // tfidf 30s + triage 30s, sequential
const MATCH_RECHECK_MS      = 30_000;  // one triage call (lib/triage-call.ts timeout)
const DRAFT_PER_ROUND_MS    = 630_000; // one round of parallel drafts: tfidf-rank 30s + inner callDraftPage 600s
const CROSSREF_PER_PLAN_MS  = 30_000;  // wikilink injection per plan
const COMMIT_PER_PLAN_MS    = 60_000;  // db tx + write-page 30s + vector-upsert 30s

function withSlack(rawMs: number, floorMs: number): number {
  return Math.max(floorMs, Math.ceil(rawMs * OVERHEAD) + HEADROOM_MS);
}

// Inner Layer 3 call in resolve/route.ts: nlp-service asks the LLM about 10
// pairs per call, entity and concept pairs, with or without a page side, in
// separate batches. 120s per call covers a slow DeepSeek batch (~30s is
// typical); the floor is the fixed 10 min this formula replaced, which two
// slow batches could exceed.
const DISAMBIGUATE_FLOOR_MS     = 600_000;
const DISAMBIGUATE_PER_BATCH_MS = 120_000;
const DISAMBIGUATE_BATCH_SIZE   = 10; // nlp-service resolve_disambiguate

// disambiguate = one LLM call per batch; the split into four groups (kind,
// page side or not) adds at most three partial batches, and no batch is empty.
export function computeDisambiguateMs(pairCount: number): number {
  const batches = Math.min(pairCount, Math.ceil(pairCount / DISAMBIGUATE_BATCH_SIZE) + 3);
  return withSlack(batches * DISAMBIGUATE_PER_BATCH_MS, DISAMBIGUATE_FLOOR_MS);
}

// resolve = fuzzy 60s + embedding 60s + disambiguate. Layer 3 asks up to
// disambiguatePairCap(sourceCount) pairs (one list article can fill it), so
// the step always allows the prelude plus the disambiguate ceiling at that
// cap; the per-source term only takes over for very large sessions.
export function computeResolveMs(sourceCount: number): number {
  const raw = 120_000 + sourceCount * RESOLVE_PER_SOURCE_MS;
  const atCap = 120_000 + computeDisambiguateMs(disambiguatePairCap(sourceCount)) + HEADROOM_MS;
  return Math.max(withSlack(raw, RESOLVE_FLOOR_MS), atCap);
}

// match = sequential `for source` × top-3 candidates × (tfidf + triage),
// then up to recheckCalls triage calls on stored failures (the per-compile
// cap in lib/triage-recheck-limits.ts; 0 when match may not re-check).
// candidatesPerSource defaults to 3 (MAX_TRIAGE_CANDIDATES_PER_SOURCE in
// lib/triage-candidates.ts).
export function computeMatchMs(sourceCount: number, candidatesPerSource = 3, recheckCalls = 0): number {
  const raw = sourceCount * candidatesPerSource * MATCH_PER_PAIR_MS + recheckCalls * MATCH_RECHECK_MS;
  return withSlack(raw, MATCH_FLOOR_MS);
}

// Rounds of parallel drafts the draft step runs. /api/compile/draft drafts
// its layers (LAYER_ORDER: summaries, entities, concepts, comparisons,
// overviews) one after another, each in rounds of DRAFT_CONCURRENCY (10)
// calls, and on a wiki's first compile one summary drafts alone first: a
// round of its own. Original-source pages are copied, with no LLM call.
// Sizing by plan count alone gave a 7-plan first compile one round (900 s)
// for its 4-5.
export function draftRounds(plansByType: Record<string, number>, firstAlone: boolean, concurrency = 10): number {
  let rounds = firstAlone ? 1 : 0;
  for (const [pageType, count] of Object.entries(plansByType)) {
    if (pageType !== 'original-source' && count > 0) rounds += Math.ceil(count / concurrency);
  }
  return rounds;
}

// draft = rounds (draftRounds) × the ceiling of one round.
export function computeDraftMs(rounds: number): number {
  const raw = Math.max(1, rounds) * DRAFT_PER_ROUND_MS;
  return withSlack(raw, DRAFT_FLOOR_MS);
}

// crossref = sequential per-plan wikilink injection (no LLM).
export function computeCrossrefMs(planCount: number): number {
  const raw = planCount * CROSSREF_PER_PLAN_MS;
  return withSlack(raw, CROSSREF_FLOOR_MS);
}

// commit = sequential `for plan` × (DB tx + write-page 30s + vector-upsert 30s).
export function computeCommitMs(planCount: number): number {
  const raw = planCount * COMMIT_PER_PLAN_MS;
  return withSlack(raw, COMMIT_FLOOR_MS);
}
