import { NextResponse } from 'next/server';
import {
  dbPath,
  getDb,
  getPageCount,
  getSchemaVersion,
  listUserTables,
  markStaleSessionsFailed,
  EXPECTED_TABLES,
} from '@/lib/db';

/**
 * GET /api/health
 *
 * Used by integration test stage 1 (migration & schema sanity). Returns
 * 200 with a structured payload when the DB opened successfully, migration
 * ran, and all 8 expected tables exist. Returns 500 otherwise.
 */
export async function GET() {
  try {
    // Clean up any sessions left 'running' by a server restart or crash.
    // This runs on every health probe so stale sessions are fixed automatically on startup.
    const staleSessionsFixed = markStaleSessionsFailed(30);

    const db = getDb();
    const tables = listUserTables();
    const tableCount = tables.length;
    const schemaVersion = getSchemaVersion();
    const dbWritable = !db.readonly;

    const allExpectedPresent = EXPECTED_TABLES.every((t) => tables.includes(t));

    const status = dbWritable && allExpectedPresent && schemaVersion === 12
      ? 'ok'
      : 'degraded';

    const pageCount = getPageCount();

    return NextResponse.json(
      {
        status,
        db_writable: dbWritable,
        schema_version: schemaVersion,
        table_count: tableCount,
        tables,
        db_path: dbPath(),
        page_count: pageCount,
        stale_sessions_fixed: staleSessionsFixed,
      },
      { status: status === 'ok' ? 200 : 500 }
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
