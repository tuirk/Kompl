/**
 * Promote a session's staged items into a compile run: the body of
 * POST /api/onboarding/finalize, shared with POST /api/agent/sources
 * (MCP add_source) so both start compiles exactly the same way.
 *
 *   - Read included pending/ingested staging rows for the session
 *   - Create compile_progress (the 'queued' row the orchestrator, the
 *     reconciler and the dashboard banner all observe)
 *   - Log an onboarding_confirmed activity row
 *   - Trigger n8n /webhook/session-compile, which hits /api/compile/run
 *
 * Returns the HTTP status and JSON body the route answers with.
 */

import {
  createCompileProgress,
  getCompileModel,
  getRunningCompileSession,
  getSetting,
  getStagingBySession,
  logActivity,
  setSetting,
  supersedeOrphanQueuedSessions,
} from './db';
import { pageUpgradeBlock } from './page-upgrade-state';
import { wikiRepairBlock } from './wiki-repair/state';
import { triggerSessionCompile } from './trigger-n8n';

export interface FinalizeResult {
  status: number;
  body: Record<string, unknown>;
}

export async function finalizeSession(session_id: string): Promise<FinalizeResult> {
  // Accept both 'pending' (fresh staging) and 'ingested' (legacy-lifted
  // by v18 migration — already have a sources row at compile_status='pending'
  // and need the pipeline to run extract → schema on them). The downstream
  // extract step reads sources.compile_status regardless of how they got
  // there, so both kinds finalize cleanly.
  const staged = getStagingBySession(session_id).filter(
    (s) => s.included && (s.status === 'pending' || s.status === 'ingested')
  );
  if (staged.length === 0) {
    return {
      status: 400,
      body: {
        error_code: 'no_items_staged',
        error: 'No included pending staging rows for this session.',
      },
    };
  }

  // No compile while pages are being updated to the current writing rules
  // or the wiki is being repaired (lib/page-upgrade.ts, lib/wiki-repair).
  // Checked before any side effect.
  const upgrading = pageUpgradeBlock() ?? wikiRepairBlock();
  if (upgrading) return { status: 409, body: { ...upgrading } };

  // Clear orphan queued rows (failed n8n trigger, abandoned tab) so they
  // do not hold the global gate while the user starts a fresh session.
  supersedeOrphanQueuedSessions(session_id);

  // Global concurrency gate: only one compile session at a time. Two
  // concurrent pipelines collide on the Gemini rate limiter singleton,
  // SQLite WAL writer, and Chroma collection — producing cascading step
  // failures.
  const active = getRunningCompileSession();
  if (active) {
    if (active.session_id !== session_id) {
      return {
        status: 409,
        body: {
          error_code: 'session_in_progress',
          error: 'Another compile session is already running.',
          active_session_id: active.session_id,
        },
      };
    }
    // Same-session replay (double-click, two tabs, network retry). Skip
    // all side effects — createCompileProgress wipes step state via
    // ON CONFLICT DO UPDATE, and n8n has no webhook dedupe so a second
    // trigger starts a second workflow execution.
    //
    // Known edge: after a 503 on first trigger, the row is stuck 'queued'
    // with started_at=NULL and a replay here also returns idempotent —
    // the user must wait up to 5 min for reconcileStuckCompileSessions
    // (/api/health sweep) to flip it to 'failed', OR cancel via
    // DELETE /api/onboarding/session and re-submit.
    return { status: 200, body: { session_id, queued: staged.length, already_running: true } };
  }

  // Mark first-time onboarding complete so dashboard redirect stops sending
  // the user back to /onboarding. Matches the behaviour of /confirm.
  if (!getSetting('onboarding_completed')) {
    setSetting('onboarding_completed', '1');
  }

  // Create the compile_progress row BEFORE the n8n trigger so a POST failure
  // still leaves a row for the reconciler to find. Same ordering as /confirm.
  // v20: lock this session to the current Settings compile_model so a
  // Settings change mid-run doesn't cause mixed-model output. Preserved
  // across retries (createCompileProgress ON CONFLICT doesn't overwrite).
  createCompileProgress(session_id, staged.length, getCompileModel());
  logActivity('onboarding_confirmed', {
    source_id: null,
    details: { session_id, queued: staged.length, deleted: 0 },
  });

  const trigger = await triggerSessionCompile(session_id);
  if (!trigger.ok) {
    logActivity('compile_trigger_failed', {
      source_id: null,
      details: {
        session_id,
        reason: trigger.reason,
        upstream_status: trigger.upstreamStatus,
      },
    });
    return {
      status: 503,
      body: {
        error: trigger.reason,
        session_id,
        queued: staged.length,
        upstream_status: trigger.upstreamStatus,
      },
    };
  }

  return { status: 200, body: { session_id, queued: staged.length } };
}
