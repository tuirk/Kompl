import { NextResponse } from 'next/server';
import {
  dbPath,
  getDb,
  getPageCount,
  getSchemaVersion,
  getVectorBacklogCount,
  listUserTables,
  markStaleSessionsFailed,
  reconcileStuckCompileSessions,
  EXPECTED_TABLES,
} from '@/lib/db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

/**
 * GET /api/health
 *
 * Used by integration test stage 1 (migration & schema sanity), Docker
 * healthcheck, and `kompl status`. Returns 200 with a structured payload when
 * the DB opened successfully, migration ran, and all expected tables exist.
 * Returns 500 only on hard errors (DB unreachable, unexpected throw).
 *
 * NLP/vector signals are reported as degraded (HTTP 200, status:'degraded')
 * rather than error (HTTP 500) — the app remains usable without them and
 * Docker healthcheck must not restart the app just because NLP is temporarily
 * down.
 */
export async function GET() {
  try {
    // Clean up any sessions left 'running' by a server restart or crash.
    // This runs on every health probe so stale sessions are fixed automatically on startup.
    const staleSessionsFixed = markStaleSessionsFailed(30);
    // Clean up 'queued' sessions that never got picked up by n8n (silent
    // webhook drop, n8n down at the time of confirm, process killed mid-flight).
    const stuckQueuedFixed = reconcileStuckCompileSessions(5);

    const db = getDb();
    const tables = listUserTables();
    const tableCount = tables.length;
    const schemaVersion = getSchemaVersion();
    const dbWritable = !db.readonly;

    const allExpectedPresent = EXPECTED_TABLES.every((t) => tables.includes(t));

    const pageCount = getPageCount();
    const vectorBacklog = getVectorBacklogCount();

    // NLP service ping — non-blocking, 2s timeout.
    let nlpOk = false;
    try {
      const nlpRes = await fetch(`${NLP_SERVICE_URL}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      nlpOk = nlpRes.ok;
    } catch { /* non-fatal */ }

    const dbOk = dbWritable && allExpectedPresent && schemaVersion === 16;

    // status:'ok' requires DB healthy + NLP reachable + no vector backlog.
    // status:'degraded' means the app is serving but something needs attention.
    // status:'error' means the DB itself is broken (returned as HTTP 500 below).
    const status: 'ok' | 'degraded' =
      dbOk && nlpOk && vectorBacklog === 0 ? 'ok' : 'degraded';

    return NextResponse.json(
      {
        status,
        db_writable: dbWritable,
        schema_version: schemaVersion,
        table_count: tableCount,
        tables,
        db_path: dbPath(),
        page_count: pageCount,
        nlp_ok: nlpOk,
        vector_backlog: vectorBacklog,
        stale_sessions_fixed: staleSessionsFixed,
        stuck_queued_fixed: stuckQueuedFixed,
      },
      // Return 200 for both 'ok' and 'degraded' so Docker healthcheck only
      // fails on hard errors. The app is usable in degraded state.
      { status: dbOk ? 200 : 500 }
    );
  } catch (err) {
    return NextResponse.json(
      {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
