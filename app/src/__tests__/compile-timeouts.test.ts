/**
 * Outer-timeout formulas for run/route.ts orchestrator wrappers.
 *
 * These tests pin the formula SHAPE (floor + ceil(rate × N × OVERHEAD) +
 * HEADROOM_MS), not specific milliseconds for arbitrary N — so tuning a
 * per-item rate updates one constant in compile-timeouts.ts + a couple
 * of expected values here, not a wide test diff.
 *
 * The static AbortSignal constants from PR #71 (commit b7b2d48) were
 * ticking bombs that fire at some N+1; session 97f58805 hit the
 * outer-undici headersTimeout at 16m 46s on a 38-plan draft. These
 * formulas guarantee the ceiling rises linearly with N.
 */

import { describe, it, expect } from 'vitest';
import {
  computeDisambiguateMs,
  computeResolveMs,
  computeMatchMs,
  computeDraftMs,
  draftRounds,
  computeCrossrefMs,
  computeCommitMs,
} from '../lib/compile-timeouts';

const OVERHEAD = 1.2;
const HEADROOM_MS = 180_000;

// Pin the floors to mirror compile-timeouts.ts. If these change there, this
// test drives the regression boundary.
const RESOLVE_FLOOR_MS  = 300_000;
const MATCH_FLOOR_MS    = 120_000;
const DRAFT_FLOOR_MS    = 600_000;
const CROSSREF_FLOOR_MS = 120_000;
const COMMIT_FLOOR_MS   = 120_000;

const RESOLVE_PER_SOURCE_MS = 60_000;
const DISAMBIGUATE_FLOOR_MS     = 600_000;
const DISAMBIGUATE_PER_BATCH_MS = 120_000;
// lib/resolve-ranking.ts disambiguatePairCap: 10 pairs per source, 120 to 600.
const pairCap = (sources: number) => Math.min(600, Math.max(120, sources * 10));
const MATCH_PER_PAIR_MS     = 60_000;
const DRAFT_PER_ROUND_MS    = 630_000;
const CROSSREF_PER_PLAN_MS  = 30_000;
const COMMIT_PER_PLAN_MS    = 60_000;

const expected = (rawMs: number, floorMs: number): number =>
  Math.max(floorMs, Math.ceil(rawMs * OVERHEAD) + HEADROOM_MS);

describe('computeDisambiguateMs', () => {
  // One LLM call per 10 pairs, plus three partial batches for the split by
  // kind and by page side.
  const batches = (pairs: number) => Math.min(pairs, Math.ceil(pairs / 10) + 3);

  it('keeps the fixed 10 min it replaced as its floor', () => {
    expect(computeDisambiguateMs(0)).toBe(DISAMBIGUATE_FLOOR_MS);
    expect(computeDisambiguateMs(2)).toBe(DISAMBIGUATE_FLOOR_MS);
  });

  it('grows with the number of LLM batches', () => {
    expect(computeDisambiguateMs(45)).toBe(expected(batches(45) * DISAMBIGUATE_PER_BATCH_MS, DISAMBIGUATE_FLOOR_MS));
    expect(computeDisambiguateMs(120)).toBe(expected(batches(120) * DISAMBIGUATE_PER_BATCH_MS, DISAMBIGUATE_FLOOR_MS));
    expect(computeDisambiguateMs(120)).toBeGreaterThan(computeDisambiguateMs(60));
  });

  it('leaves room for two batches at the slowest DeepSeek time seen (400s) at the cap', () => {
    const typical = 11 * 30_000;
    expect(computeDisambiguateMs(pairCap(0))).toBeGreaterThan(typical + 2 * 400_000);
  });
});

describe('computeResolveMs', () => {
  // Layer 3 can fill the session's cap from a single source, so resolve
  // always allows the 120s prelude plus the disambiguate ceiling at that cap.
  const atCap = (n: number) => 120_000 + computeDisambiguateMs(pairCap(n)) + HEADROOM_MS;

  it('covers a full Layer 3 at N=0 and N=1', () => {
    expect(computeResolveMs(0)).toBe(atCap(0));
    expect(computeResolveMs(1)).toBe(atCap(1));
    expect(computeResolveMs(0)).toBeGreaterThanOrEqual(RESOLVE_FLOOR_MS);
  });

  it('never lets the outer call abort the inner disambiguate call', () => {
    for (const n of [0, 1, 5, 10, 24, 38, 60, 100]) {
      expect(computeResolveMs(n)).toBeGreaterThan(120_000 + computeDisambiguateMs(pairCap(n)));
    }
  });

  it('scales linearly with sources once that passes the cap ceiling', () => {
    const raw = 120_000 + 300 * RESOLVE_PER_SOURCE_MS;
    expect(computeResolveMs(300)).toBe(expected(raw, RESOLVE_FLOOR_MS));
    const raw400 = 120_000 + 400 * RESOLVE_PER_SOURCE_MS;
    expect(computeResolveMs(400)).toBe(expected(raw400, RESOLVE_FLOOR_MS));
  });
});

describe('computeMatchMs', () => {
  it('returns headroom at N=0 (floor is below headroom; headroom wins)', () => {
    expect(computeMatchMs(0)).toBe(expected(0, MATCH_FLOOR_MS));
    expect(computeMatchMs(0)).toBeGreaterThanOrEqual(MATCH_FLOOR_MS);
  });

  it('uses default candidatesPerSource=3', () => {
    const raw = 10 * 3 * MATCH_PER_PAIR_MS;
    expect(computeMatchMs(10)).toBe(expected(raw, MATCH_FLOOR_MS));
  });

  it('honors explicit candidatesPerSource', () => {
    const raw = 10 * 5 * MATCH_PER_PAIR_MS;
    expect(computeMatchMs(10, 5)).toBe(expected(raw, MATCH_FLOOR_MS));
  });

  it('scales linearly at N=50', () => {
    const raw = 50 * 3 * MATCH_PER_PAIR_MS;
    expect(computeMatchMs(50)).toBe(expected(raw, MATCH_FLOOR_MS));
  });

  it('adds one triage call per allowed re-check of a stored failure', () => {
    const raw = 10 * 3 * MATCH_PER_PAIR_MS + 10 * 30_000;
    expect(computeMatchMs(10, 3, 10)).toBe(expected(raw, MATCH_FLOOR_MS));
  });
});

describe('computeDraftMs', () => {
  it('returns one round at 0 rounds (Math.max(1, ...) keeps a single-round budget)', () => {
    const raw = 1 * DRAFT_PER_ROUND_MS;
    expect(computeDraftMs(0)).toBe(expected(raw, DRAFT_FLOOR_MS));
    expect(computeDraftMs(0)).toBeGreaterThanOrEqual(DRAFT_FLOOR_MS);
  });

  it('allows one draft call plus its dossier ranking per round', () => {
    expect(computeDraftMs(1)).toBe(expected(DRAFT_PER_ROUND_MS, DRAFT_FLOOR_MS));
    expect(computeDraftMs(4)).toBe(expected(4 * DRAFT_PER_ROUND_MS, DRAFT_FLOOR_MS));
  });

  it('exceeds the static 1.5M ms that fired on session 97f58805 (38 plans)', () => {
    // 38 plans in one layer: 4 rounds. PR #71's static value was 1.5M ms.
    expect(computeDraftMs(draftRounds({ entity: 38 }, false))).toBeGreaterThan(1_500_000);
  });
});

describe('draftRounds', () => {
  it('runs the layers one after another, each in rounds of 10', () => {
    expect(draftRounds({ 'source-summary': 12, entity: 3, concept: 1 }, false)).toBe(2 + 1 + 1);
    expect(draftRounds({ entity: 38 }, false, 5)).toBe(8);
  });

  it('adds the round of the summary a first compile drafts alone', () => {
    expect(draftRounds({ 'source-summary': 3 }, true)).toBe(2);
  });

  it('counts no round for copied original-source pages or empty layers', () => {
    expect(draftRounds({ 'original-source': 4, entity: 0 }, false)).toBe(0);
  });

  it('gives a 7-plan first compile its 5 rounds, not the 900 s it had (audit H3)', () => {
    const rounds = draftRounds({ 'source-summary': 3, entity: 2, concept: 1, overview: 1 }, true);
    expect(rounds).toBe(5);
    expect(computeDraftMs(rounds)).toBe(expected(5 * DRAFT_PER_ROUND_MS, DRAFT_FLOOR_MS));
    expect(computeDraftMs(rounds)).toBeGreaterThan(5 * 600_000);
  });
});

describe('computeCrossrefMs', () => {
  it('returns headroom at N=0 (floor is below headroom; headroom wins)', () => {
    expect(computeCrossrefMs(0)).toBe(expected(0, CROSSREF_FLOOR_MS));
    expect(computeCrossrefMs(0)).toBeGreaterThanOrEqual(CROSSREF_FLOOR_MS);
  });

  it('returns the floor at small N (raw < floor)', () => {
    // 1 plan × 30s × 1.2 + 180s = 216s. Floor is 120s, so 216s wins.
    const raw = 1 * CROSSREF_PER_PLAN_MS;
    expect(computeCrossrefMs(1)).toBe(expected(raw, CROSSREF_FLOOR_MS));
  });

  it('scales linearly at N=38', () => {
    const raw = 38 * CROSSREF_PER_PLAN_MS;
    expect(computeCrossrefMs(38)).toBe(expected(raw, CROSSREF_FLOOR_MS));
  });
});

describe('computeCommitMs', () => {
  it('returns headroom at N=0 (floor is below headroom; headroom wins)', () => {
    expect(computeCommitMs(0)).toBe(expected(0, COMMIT_FLOOR_MS));
    expect(computeCommitMs(0)).toBeGreaterThanOrEqual(COMMIT_FLOOR_MS);
  });

  it('scales linearly at N=10', () => {
    const raw = 10 * COMMIT_PER_PLAN_MS;
    expect(computeCommitMs(10)).toBe(expected(raw, COMMIT_FLOOR_MS));
  });

  it('scales linearly at N=38', () => {
    const raw = 38 * COMMIT_PER_PLAN_MS;
    expect(computeCommitMs(38)).toBe(expected(raw, COMMIT_FLOOR_MS));
  });
});

describe('floor enforcement (degenerate inputs)', () => {
  it('every compute*Ms returns at least its floor at N=0 (no NaN, no zero, no sub-floor)', () => {
    expect(computeResolveMs(0)).toBeGreaterThanOrEqual(RESOLVE_FLOOR_MS);
    expect(computeMatchMs(0)).toBeGreaterThanOrEqual(MATCH_FLOOR_MS);
    expect(computeDraftMs(0)).toBeGreaterThanOrEqual(DRAFT_FLOOR_MS);
    expect(computeCrossrefMs(0)).toBeGreaterThanOrEqual(CROSSREF_FLOOR_MS);
    expect(computeCommitMs(0)).toBeGreaterThanOrEqual(COMMIT_FLOOR_MS);
  });

  it('every compute*Ms returns a positive integer at any non-negative N', () => {
    for (const n of [0, 1, 5, 10, 38, 100, 1000]) {
      for (const fn of [computeDisambiguateMs, computeResolveMs, computeMatchMs, computeDraftMs, computeCrossrefMs, computeCommitMs]) {
        const result = fn(n);
        expect(Number.isInteger(result)).toBe(true);
        expect(result).toBeGreaterThan(0);
      }
    }
  });
});
