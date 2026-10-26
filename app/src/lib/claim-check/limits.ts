/**
 * Limits of the claim check (plan 3.3) and the whole-wiki check (plan 3.6).
 * Kept free of server imports so Settings and the activity feed can show
 * them.
 */

/** CLAUDE.md rule 7 hard cap: claim pairs one compile may judge (CLAIM_JUDGE_BATCH_SIZE per call). */
export const MAX_CLAIM_CHECK_PAIRS_PER_COMPILE = 60;

/** Hard cap on the claim pairs one whole-wiki check run judges; the next run goes on from there. */
export const MAX_WIKI_CHECK_PAIRS_PER_RUN = 600;

/**
 * Pairs per judge call. Batch prompting keeps about the same accuracy up to
 * ~6 items per call (Cheng et al. 2023, "Batch Prompting"); larger batches
 * drift. nlp-service routers/claims.py accepts at most 8.
 */
export const CLAIM_JUDGE_BATCH_SIZE = 6;

/** Judge calls in flight at once. */
export const CLAIM_JUDGE_CONCURRENCY = 3;

/** A run stops after this many judge calls in a row fail (errors, not limits). */
export const MAX_CONSECUTIVE_JUDGE_FAILURES = 3;

/**
 * A subject found in more than this share of all the wiki's claims is too
 * common to anchor a pair: nearly every claim would pair with every other.
 */
export const TOO_COMMON_SUBJECT_SHARE = 0.35;

/** Candidate pairs kept per claim: its most similar claims from other sources. */
export const PAIRS_PER_CLAIM = 3;

/** Longest claim or source sentence sent to the judge, in characters. */
export const CLAIM_MAX_CHARS = 400;
