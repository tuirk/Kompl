/**
 * Which pipeline owns a session's compile_progress row.
 *
 * POST /api/compile/run claims the row (claimCompileRun in lib/db.ts: status
 * 'running', fresh started_at) and, in the same synchronous turn, makes a new
 * CompileRun the session's current run here. A run that is no longer current
 * was superseded: the gate restarted the session after it went stale, or a
 * retry started a new run while the old pipeline was still waiting on a call.
 * A superseded run stops at its next step boundary and drops its own progress
 * writes, so it cannot write over the new run's steps, complete it or fail it.
 *
 * Limit: a sub-route call already in flight (draft, commit, ...) is its own
 * request and finishes its work; only the orchestrator stops.
 *
 * Kept in memory on globalThis: a pipeline only outlives its claim inside
 * this process (an app restart ends it), and dev-server reloads share one map.
 */

import type { CompileStepKey } from '../compile-steps';
import {
  completeCompileProgress,
  failCompileProgress,
  getCompileProgress,
  updateCompileStep,
} from '../db';

export class CompileCancelledError extends Error {
  constructor() {
    super('Cancelled by user');
    this.name = 'CompileCancelledError';
  }
}

export class CompileSupersededError extends Error {
  constructor() {
    super('Superseded by a newer run of this session');
    this.name = 'CompileSupersededError';
  }
}

const RUNS_KEY = '__komplCompileRuns';

function currentRuns(): Map<string, CompileRun> {
  const g = globalThis as { [RUNS_KEY]?: Map<string, CompileRun> };
  return (g[RUNS_KEY] ??= new Map<string, CompileRun>());
}

export class CompileRun {
  private constructor(readonly sessionId: string) {}

  /**
   * Makes a new run the session's current one. Call right after a successful
   * claimCompileRun, with no await in between.
   */
  static start(sessionId: string): CompileRun {
    const run = new CompileRun(sessionId);
    currentRuns().set(sessionId, run);
    return run;
  }

  get isCurrent(): boolean {
    return currentRuns().get(this.sessionId) === this;
  }

  /**
   * Step boundary: throws when this run must stop. A missing row counts as
   * cancelled: the session was discarded (DELETE /api/onboarding/session).
   */
  assertActive(): void {
    if (!this.isCurrent) throw new CompileSupersededError();
    const p = getCompileProgress(this.sessionId);
    if (!p || p.status === 'cancelled') throw new CompileCancelledError();
  }

  step(step: CompileStepKey, status: 'running' | 'done' | 'failed', detail?: string): void {
    if (this.isCurrent) updateCompileStep(this.sessionId, step, status, detail);
  }

  complete(): void {
    if (this.isCurrent) completeCompileProgress(this.sessionId);
  }

  fail(error: string): void {
    if (this.isCurrent) failCompileProgress(this.sessionId, error);
  }

  /** The pipeline has exited. */
  end(): void {
    if (this.isCurrent) currentRuns().delete(this.sessionId);
  }
}

/** True while a pipeline of this session is running in this process. */
export function isCompileRunLive(sessionId: string): boolean {
  return currentRuns().has(sessionId);
}
