/**
 * Limits on re-checking stored triage failures (lib/compile/triage-recheck.ts).
 * Kept free of server imports so Settings and the activity feed can show them.
 */

/** CLAUDE.md rule 7 hard cap: triage calls one compile may spend on re-checks. */
export const MAX_TRIAGE_RECHECKS_PER_COMPILE = 10;

/** A pair whose triage has failed this many times (cost ceiling refusals not counted) is dropped. */
export const MAX_TRIAGE_ATTEMPTS = 3;
