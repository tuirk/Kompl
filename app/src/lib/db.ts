/**
 * Kompl v2 — single-writer SQLite wrapper.
 *
 * Architecture rule #1: kompl.db has exactly one open file handle at any
 * instant. During normal operation that handle is held by this Next.js
 * process. The migration script (scripts/migrate.py) holds it briefly at
 * container boot BEFORE Next.js starts, in the same container, so the
 * file descriptor is fully released before Node forks.
 *
 * Architecture rule #5: better-sqlite3.transaction() is SYNCHRONOUS-ONLY.
 * Per the official docs:
 *   "Transaction functions do not work with async functions. Technically
 *    speaking, async functions always return after the first await, which
 *    means the transaction will already be committed before any async
 *    code executes."
 *   — https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
 *
 * The Pass-5 three-phase commit pattern used by /api/sources/store (and,
 * in commit 4, /api/compile/commit) is:
 *
 *   Phase 1 — async pre-work (httpx calls, hashing, gzipping)
 *   Phase 2 — synchronous db.transaction(() => { ... writes ... })
 *   Phase 3 — fire-and-forget async follow-ups (vector upsert in commit 6+)
 *
 * Inside the Phase 2 callback there must be ZERO `await` calls. Phase 2
 * also includes filesystem writes via `fs.writeFileSync` because file
 * write + DB insert must succeed or fail together.
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DB_PATH = process.env.DB_PATH ?? '/data/db/kompl.db';
const DATA_ROOT = path.dirname(path.dirname(DB_PATH)); // /data
const RAW_DIR = path.join(DATA_ROOT, 'raw');

let _db: Database.Database | null = null;

function openDb(): Database.Database {
  if (_db) return _db;

  // Open in read-write mode. migrate.py has already created the schema
  // by the time Next.js starts (single-container entrypoint sequence).
  _db = new Database(DB_PATH, { fileMustExist: true });
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

export function getDb(): Database.Database {
  return openDb();
}

export function dbPath(): string {
  return DB_PATH;
}

// ============================================================================
// Health / introspection helpers (commit 2)
// ============================================================================

/**
 * Read the schema_version row from the settings table. Returns null if
 * the row does not exist (which would be a migration failure).
 */
export function getSchemaVersion(): number | null {
  const row = openDb()
    .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : null;
}

/**
 * Enumerate user tables (excluding sqlite_* internals and FTS5 shadow
 * tables). Used by /api/health to verify migration completed. The
 * integration test asserts this returns exactly 8 names.
 */
const EXPECTED_TABLES = [
  'sources',
  'pages',
  'provenance',
  'drafts',
  'activity_log',
  'aliases',
  'settings',
  'pages_fts',
] as const;

export function listUserTables(): string[] {
  const rows = openDb()
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type IN ('table', 'view')
         AND name IN (${EXPECTED_TABLES.map(() => '?').join(',')})`
    )
    .all(...EXPECTED_TABLES) as { name: string }[];
  return rows.map((r) => r.name).sort();
}

export { EXPECTED_TABLES };

// ============================================================================
// Domain types (kept tight — these mirror the schema, nothing more)
// ============================================================================

export interface SourceRow {
  source_id: string;
  title: string;
  source_type: string;
  source_url: string | null;
  content_hash: string;
  file_path: string;
  status: string;
  date_ingested: string;
  metadata: string | null; // JSON TEXT; caller parses if needed
}

export interface ActivityRow {
  id: number;
  timestamp: string;
  action_type: string;
  source_id: string | null;
  details: string | null; // JSON TEXT
}

// ============================================================================
// Raw markdown storage (gzipped to /data/raw/<source_id>.md.gz)
//
// Rule #4 (version-preserving writes) applies to WIKI PAGE storage, not
// raw sources — raw sources are immutable once ingested. A re-ingest of
// the same URL creates a new source_id (new row) rather than overwriting.
// The `previous_content_path` column exists on `pages`, not `sources`.
// ============================================================================

export function rawFilePath(sourceId: string): string {
  return path.join(RAW_DIR, `${sourceId}.md.gz`);
}

/**
 * Synchronously gzip and write the markdown for a source. Intended to be
 * called INSIDE a `db.transaction()` callback (Phase 2) so that the file
 * write and the DB insert commit atomically. If either throws, the DB
 * transaction rolls back and we attempt to unlink the partial file.
 */
export function storeRawMarkdown(sourceId: string, markdown: string): string {
  if (!fs.existsSync(RAW_DIR)) {
    fs.mkdirSync(RAW_DIR, { recursive: true });
  }
  const filePath = rawFilePath(sourceId);
  const gzipped = zlib.gzipSync(Buffer.from(markdown, 'utf-8'));
  fs.writeFileSync(filePath, gzipped);
  return filePath;
}

/**
 * Read and decompress the raw markdown for a source. Used by the
 * /source/[source_id] server component. Returns null if the file is
 * missing (which would indicate DB/filesystem drift — the integration
 * test should catch this).
 */
export function readRawMarkdown(sourceId: string): string | null {
  const filePath = rawFilePath(sourceId);
  if (!fs.existsSync(filePath)) return null;
  const gzipped = fs.readFileSync(filePath);
  return zlib.gunzipSync(gzipped).toString('utf-8');
}

// ============================================================================
// Source writes (sync, used inside Phase 2 transactions)
// ============================================================================

export interface InsertSourceArgs {
  source_id: string;
  title: string;
  source_type: string;
  source_url: string | null;
  content_hash: string;
  file_path: string;
  metadata: Record<string, unknown> | null;
}

/**
 * Insert a single source row. Throws on duplicate source_id (caller
 * must translate to HTTP 409). Callable from inside a `db.transaction()`
 * callback — no `await`.
 */
export function insertSource(args: InsertSourceArgs): void {
  openDb()
    .prepare(
      `INSERT INTO sources
         (source_id, title, source_type, source_url, content_hash,
          file_path, status, metadata)
       VALUES
         (@source_id, @title, @source_type, @source_url, @content_hash,
          @file_path, 'active', @metadata)`
    )
    .run({
      source_id: args.source_id,
      title: args.title,
      source_type: args.source_type,
      source_url: args.source_url,
      content_hash: args.content_hash,
      file_path: args.file_path,
      metadata: args.metadata ? JSON.stringify(args.metadata) : null,
    });
}

/**
 * Fetch one source row by id. Used by /api/sources/[source_id] and the
 * /source/[source_id] server component. Returns null if not found.
 */
export function getSource(sourceId: string): SourceRow | null {
  const row = openDb()
    .prepare(
      `SELECT source_id, title, source_type, source_url, content_hash,
              file_path, status, date_ingested, metadata
         FROM sources
         WHERE source_id = ?`
    )
    .get(sourceId) as SourceRow | undefined;
  return row ?? null;
}

/**
 * Check whether a source_id already exists. Used for idempotent-retry
 * detection in /api/sources/store (return 409 instead of 500 on dupe).
 */
export function sourceExists(sourceId: string): boolean {
  const row = openDb()
    .prepare('SELECT 1 AS one FROM sources WHERE source_id = ?')
    .get(sourceId) as { one: number } | undefined;
  return !!row;
}

// ============================================================================
// Activity log writes (sync)
// ============================================================================

export interface InsertActivityArgs {
  action_type: string;
  source_id: string | null;
  details: Record<string, unknown> | null;
}

export function insertActivity(args: InsertActivityArgs): number {
  const info = openDb()
    .prepare(
      `INSERT INTO activity_log (action_type, source_id, details)
       VALUES (@action_type, @source_id, @details)`
    )
    .run({
      action_type: args.action_type,
      source_id: args.source_id,
      details: args.details ? JSON.stringify(args.details) : null,
    });
  return Number(info.lastInsertRowid);
}

/**
 * Fetch recent activity rows newer than `since`. Used by the feed page's
 * 2-second poll. `limit` caps the result set to protect against
 * slow-client blowup.
 *
 * IMPORTANT — timestamp format gotcha:
 * SQLite's `CURRENT_TIMESTAMP` (used by the activity_log default) stores
 * `YYYY-MM-DD HH:MM:SS` with a space and no timezone marker. Callers
 * commonly pass `since` in ISO 8601 form `YYYY-MM-DDTHH:MM:SS.sssZ`. A
 * naive `WHERE timestamp > ?` does a LEXICOGRAPHIC compare and silently
 * returns ZERO rows because ' ' (0x20) < 'T' (0x54), so every SQLite
 * timestamp is "less than" any ISO 8601 string for the same instant.
 *
 * Fix: wrap both sides with `datetime(...)` so SQLite normalizes to its
 * canonical format before comparing. `datetime('2026-04-08T13:51:27.000Z')`
 * → `'2026-04-08 13:51:27'`, then the comparison works correctly.
 */
// ============================================================================
// Page writes (sync, used inside Phase 2 transactions for compile commit)
// ============================================================================

export interface InsertPageArgs {
  page_id: string;
  title: string;
  page_type: string;
  category: string | null;
  summary: string | null;
  content_path: string;
  previous_content_path: string | null;
}

/**
 * Upsert a page row. On conflict (same page_id), update all fields and bump
 * last_updated + source_count. Called inside db.transaction() — no await.
 */
export function insertPage(args: InsertPageArgs): void {
  openDb()
    .prepare(
      `INSERT INTO pages
         (page_id, title, page_type, category, summary, content_path,
          previous_content_path, source_count)
       VALUES
         (@page_id, @title, @page_type, @category, @summary, @content_path,
          @previous_content_path, 1)
       ON CONFLICT(page_id) DO UPDATE SET
         title                 = excluded.title,
         page_type             = excluded.page_type,
         category              = excluded.category,
         summary               = excluded.summary,
         content_path          = excluded.content_path,
         previous_content_path = excluded.previous_content_path,
         last_updated          = CURRENT_TIMESTAMP,
         source_count          = source_count + 1`
    )
    .run(args);
}

/**
 * Fetch one page row by id. Used by /page/[page_id] server component.
 */
export interface PageRow {
  page_id: string;
  title: string;
  page_type: string;
  category: string | null;
  summary: string | null;
  content_path: string;
  previous_content_path: string | null;
  last_updated: string;
  source_count: number;
  created_at: string;
}

export function getPage(pageId: string): PageRow | null {
  const row = openDb()
    .prepare(
      `SELECT page_id, title, page_type, category, summary, content_path,
              previous_content_path, last_updated, source_count, created_at
         FROM pages WHERE page_id = ?`
    )
    .get(pageId) as PageRow | undefined;
  return row ?? null;
}

// ============================================================================
// Provenance writes (sync)
// ============================================================================

export interface InsertProvenanceArgs {
  source_id: string;
  page_id: string;
  content_hash: string;
  contribution_type: string;
}

export function insertProvenance(args: InsertProvenanceArgs): void {
  openDb()
    .prepare(
      `INSERT INTO provenance (source_id, page_id, content_hash, contribution_type)
       VALUES (@source_id, @page_id, @content_hash, @contribution_type)`
    )
    .run(args);
}

// ============================================================================
// Page file storage (gzipped to /data/pages/<page_id>.md.gz)
// The write (version-archiving) is done by nlp-service/services/file_store.py
// before the transaction. This helper reads from that location.
// ============================================================================

export function pagesFilePath(pageId: string): string {
  return path.join(DATA_ROOT, 'pages', `${pageId}.md.gz`);
}

/**
 * Read and decompress a compiled wiki page. Used by /page/[page_id] server
 * component. Returns null if the file is missing.
 */
export function readPageMarkdown(pageId: string): string | null {
  const filePath = pagesFilePath(pageId);
  if (!fs.existsSync(filePath)) return null;
  const gzipped = fs.readFileSync(filePath);
  return zlib.gunzipSync(gzipped).toString('utf-8');
}

// ============================================================================
// Compile status helpers (sync)
// ============================================================================

/**
 * Atomically claim one pending source for compilation.
 * Sets compile_status='in_progress' for a single row that is:
 *   - compile_status = 'pending'
 *   - compile_next_eligible_at IS NULL OR <= now  (datetime() on both sides per rule #5)
 * Returns the source_id of the claimed row, or null if nothing is eligible.
 *
 * The LIMIT 1 + single-writer pattern prevents double-processing even if two
 * callers race — only one UPDATE wins because better-sqlite3 is sync.
 */
export function claimCompileSource(): string | null {
  const db = openDb();
  // Fetch first eligible row
  const row = db
    .prepare(
      `SELECT source_id FROM sources
         WHERE compile_status = 'pending'
           AND (compile_next_eligible_at IS NULL
                OR datetime(compile_next_eligible_at) <= datetime('now'))
         ORDER BY date_ingested ASC
         LIMIT 1`
    )
    .get() as { source_id: string } | undefined;

  if (!row) return null;

  // Mark it in_progress atomically.
  db.prepare(
    `UPDATE sources
       SET compile_status = 'in_progress'
       WHERE source_id = ? AND compile_status = 'pending'`
  ).run(row.source_id);

  return row.source_id;
}

/**
 * Mark a source as successfully compiled. Called inside Phase 2 transaction.
 */
export function markCompileSuccess(sourceId: string, pageId: string): void {
  openDb()
    .prepare(
      `UPDATE sources
         SET compile_status = 'compiled',
             compile_attempts = compile_attempts + 1
         WHERE source_id = ?`
    )
    .run(sourceId);
  void pageId; // pageId stored in provenance; not duplicated on sources row
}

/**
 * Mark a source compile attempt as failed. Increments compile_attempts and
 * sets compile_next_eligible_at to an exponential backoff (2^attempts minutes).
 * After 5 attempts, sets compile_status = 'failed' permanently.
 *
 * Timestamp gotcha (CLAUDE.md rule #5): both sides of time comparisons on
 * compile_next_eligible_at must use datetime() — see claimCompileSource above.
 */
export function markCompileFailed(sourceId: string): void {
  const db = openDb();
  const row = db
    .prepare(
      `SELECT compile_attempts FROM sources WHERE source_id = ?`
    )
    .get(sourceId) as { compile_attempts: number } | undefined;

  if (!row) return;

  const attempts = (row.compile_attempts ?? 0) + 1;
  if (attempts >= 5) {
    db.prepare(
      `UPDATE sources
         SET compile_status = 'failed',
             compile_attempts = ?
         WHERE source_id = ?`
    ).run(attempts, sourceId);
  } else {
    // Exponential backoff: 2^attempts minutes
    const delayMinutes = Math.pow(2, attempts);
    db.prepare(
      `UPDATE sources
         SET compile_status = 'pending',
             compile_attempts = ?,
             compile_next_eligible_at = datetime('now', '+' || ? || ' minutes')
         WHERE source_id = ?`
    ).run(attempts, delayMinutes, sourceId);
  }
}

/**
 * Get one pending compile-eligible source row. Used by the drain poller to
 * check existence before claiming (the claim is done in claimCompileSource).
 */
export function getPendingCompile(): SourceRow | null {
  const row = openDb()
    .prepare(
      `SELECT source_id, title, source_type, source_url, content_hash,
              file_path, status, date_ingested, metadata
         FROM sources
         WHERE compile_status = 'pending'
           AND (compile_next_eligible_at IS NULL
                OR datetime(compile_next_eligible_at) <= datetime('now'))
         ORDER BY date_ingested ASC
         LIMIT 1`
    )
    .get() as SourceRow | undefined;
  return row ?? null;
}

export function getRecentActivity(since: string | null, limit = 100): ActivityRow[] {
  const db = openDb();
  if (since) {
    return db
      .prepare(
        `SELECT id, timestamp, action_type, source_id, details
           FROM activity_log
           WHERE datetime(timestamp) > datetime(?)
           ORDER BY id DESC
           LIMIT ?`
      )
      .all(since, limit) as ActivityRow[];
  }
  return db
    .prepare(
      `SELECT id, timestamp, action_type, source_id, details
         FROM activity_log
         ORDER BY id DESC
         LIMIT ?`
    )
    .all(limit) as ActivityRow[];
}
