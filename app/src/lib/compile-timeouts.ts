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
const DRAFT_PER_BATCH_MS    = 600_000; // inner callDraftPage ceiling per batch
const CROSSREF_PER_PLAN_MS  = 30_000;  // wikilink injection per plan
const COMMIT_PER_PLAN_MS    = 60_000;  // db tx + write-page 30s + vector-upsert 30s

function withSlack(rawMs: number, floorMs: number): number {
  return Math.max(floorMs, Math.ceil(rawMs * OVERHEAD) + HEADROOM_MS);
}

// resolve = fuzzy 60s + embedding 60s + sourceCount × disambiguate-batch.
// Empirical: 10 sources → 192 pairs → ~19 batches × 30s = 570s + 120s
// prelude = 690s. Formula scales linearly past that.
export function computeResolveMs(sourceCount: number): number {
  const raw = 120_000 + sourceCount * RESOLVE_PER_SOURCE_MS;
  return withSlack(raw, RESOLVE_FLOOR_MS);
}

// match = sequential `for source` × top-3 candidates × (tfidf + triage).
// candidatesPerSource defaults to 3 (the slice(0, 3) cap in match/route.ts).
export function computeMatchMs(sourceCount: number, candidatesPerSource = 3): number {
  const raw = sourceCount * candidatesPerSource * MATCH_PER_PAIR_MS;
  return withSlack(raw, MATCH_FLOOR_MS);
}

// draft = ⌈planCount / DRAFT_CONCURRENCY⌉ batches × per-batch inner ceiling.
// concurrency defaults to 10 (DRAFT_CONCURRENCY env in /api/compile/draft).
export function computeDraftMs(planCount: number, concurrency = 10): number {
  const batches = Math.max(1, Math.ceil(planCount / concurrency));
  const raw = batches * DRAFT_PER_BATCH_MS;
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
