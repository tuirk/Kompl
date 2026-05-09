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
  computeResolveMs,
  computeMatchMs,
  computeDraftMs,
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
const MATCH_PER_PAIR_MS     = 60_000;
const DRAFT_PER_BATCH_MS    = 600_000;
const CROSSREF_PER_PLAN_MS  = 30_000;
const COMMIT_PER_PLAN_MS    = 60_000;

const expected = (rawMs: number, floorMs: number): number =>
  Math.max(floorMs, Math.ceil(rawMs * OVERHEAD) + HEADROOM_MS);

describe('computeResolveMs', () => {
  it('returns prelude + headroom at N=0 (floor enforced as a minimum)', () => {
    const raw = 120_000 + 0 * RESOLVE_PER_SOURCE_MS;
    expect(computeResolveMs(0)).toBe(expected(raw, RESOLVE_FLOOR_MS));
    expect(computeResolveMs(0)).toBeGreaterThanOrEqual(RESOLVE_FLOOR_MS);
  });

  it('scales linearly at N=1', () => {
    const raw = 120_000 + 1 * RESOLVE_PER_SOURCE_MS;
    expect(computeResolveMs(1)).toBe(expected(raw, RESOLVE_FLOOR_MS));
  });

  it('scales linearly at N=10', () => {
    const raw = 120_000 + 10 * RESOLVE_PER_SOURCE_MS;
    expect(computeResolveMs(10)).toBe(expected(raw, RESOLVE_FLOOR_MS));
  });

  it('scales linearly at N=100', () => {
    const raw = 120_000 + 100 * RESOLVE_PER_SOURCE_MS;
    expect(computeResolveMs(100)).toBe(expected(raw, RESOLVE_FLOOR_MS));
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
});

describe('computeDraftMs', () => {
  it('returns 1-batch-worth at N=0 (Math.max(1, ...) keeps a single-batch budget)', () => {
    // batches floor at 1 even when planCount=0; raw = 1 × 600_000
    const raw = 1 * DRAFT_PER_BATCH_MS;
    expect(computeDraftMs(0)).toBe(expected(raw, DRAFT_FLOOR_MS));
    expect(computeDraftMs(0)).toBeGreaterThanOrEqual(DRAFT_FLOOR_MS);
  });

  it('returns the same as N=0 at N=1 (1 batch × 600s × 1.2 + 180s = 900s, > 600s floor)', () => {
    const raw = 1 * DRAFT_PER_BATCH_MS;
    expect(computeDraftMs(1)).toBe(expected(raw, DRAFT_FLOOR_MS));
  });

  it('uses default concurrency=10', () => {
    const raw = Math.ceil(38 / 10) * DRAFT_PER_BATCH_MS; // 4 batches × 600s
    expect(computeDraftMs(38)).toBe(expected(raw, DRAFT_FLOOR_MS));
  });

  it('exceeds the static 1.5M ms that fired on session 97f58805 (38 plans)', () => {
    // The whole point of the refactor: 38 plans needed >1.5M ms but PR #71's
    // static value was exactly 1.5M ms.
    expect(computeDraftMs(38)).toBeGreaterThan(1_500_000);
  });

  it('honors explicit concurrency', () => {
    const raw = Math.ceil(38 / 5) * DRAFT_PER_BATCH_MS; // 8 batches at concurrency=5
    expect(computeDraftMs(38, 5)).toBe(expected(raw, DRAFT_FLOOR_MS));
  });

  it('scales linearly at N=100', () => {
    const raw = Math.ceil(100 / 10) * DRAFT_PER_BATCH_MS; // 10 batches
    expect(computeDraftMs(100)).toBe(expected(raw, DRAFT_FLOOR_MS));
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
      for (const fn of [computeResolveMs, computeMatchMs, computeDraftMs, computeCrossrefMs, computeCommitMs]) {
        const result = fn(n);
        expect(Number.isInteger(result)).toBe(true);
        expect(result).toBeGreaterThan(0);
      }
    }
  });
});
