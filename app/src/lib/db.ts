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
 * The Pass-5 three-phase commit pattern used by /api/compile/commit is:
 *
 *   Phase 1 — async pre-work (httpx calls, hashing, gzipping)
 *   Phase 2 — synchronous db.transaction(() => { ... writes ... })
 *   Phase 3 — fire-and-forget async follow-ups (vector upsert in commit 6+)
 *
 * Inside the Phase 2 callback there must be ZERO `await` calls. Phase 2
 * also includes filesystem writes via `fs.writeFileSync` because file
 * write + DB insert must succeed or fail together.
 */

import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { COMPILE_STEP_KEYS, type CompileStepKey } from './compile-steps';
import { assertSafeId, isSafeId } from './safe-paths';
import type { ActivityEventType } from './activity-events';
import { DEFAULT_COMPILE_MODEL, isLlmModel, type LlmModel } from './llm-models';
import { buildFtsQuery } from './fts-query';
import { numericConflict } from './name-guard';
import { COMPARISON_RELATIONS, quoteVerifiedColumn, quoteVerifiedFromColumn, relationKey } from './relation-rows';
import type { SourceMentionRows } from './mention-rows';
import { urlKey, urlKeyCandidates } from './url-key';

// Model registry lives in llm-models.ts (client-safe, no DB imports);
// re-exported here so server code keeps importing it from '@/lib/db'.
export {
  LLM_MODELS, DEFAULT_COMPILE_MODEL, isLlmModel, getProviderForModel,
  type LlmModel,
} from './llm-models';

const DB_PATH = process.env.DB_PATH ?? '/data/db/kompl.db';
export const DATA_ROOT = path.dirname(path.dirname(DB_PATH)); // /data
const RAW_DIR = path.join(DATA_ROOT, 'raw');
const PAGES_DIR = path.join(DATA_ROOT, 'pages');

let _db: Database.Database | null = null;

function openDb(): Database.Database {
  if (_db) return _db;

  // Open in read-write mode. migrate.py has already created the schema
  // by the time Next.js starts (single-container entrypoint sequence).
  _db = new Database(DB_PATH, { fileMustExist: true });
  _db.pragma('journal_mode = WAL');
  // Retry for up to 5 s on SQLITE_BUSY before throwing — handles concurrent
  // reads during heavy compile loads without failing the transaction.
  _db.pragma('busy_timeout = 5000');
  // NORMAL is safe with WAL mode and faster than FULL (the WAL journal already
  // guarantees durability at the OS level). Note: recent transactions may be
  // lost on OS/power crash (not app crash) — acceptable for a web app.
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');
  // 64 MB in-memory page cache — reduces disk I/O on repeated reads.
  _db.pragma('cache_size = -64000');
  // 256 MB memory-mapped I/O — fewer syscalls for sequential scans.
  _db.pragma('mmap_size = 268435456');
  return _db;
}

export function getDb(): Database.Database {
  return openDb();
}

export function dbPath(): string {
  return DB_PATH;
}

// Test-only: inject an in-memory db (or null to clear). Gated to NODE_ENV=test
// so production code can never accidentally swap the handle.
export function __setDbForTesting(db: Database.Database | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('__setDbForTesting may only be called when NODE_ENV=test');
  }
  _db = db;
}

// ============================================================================
// Health / introspection helpers (commit 2)
// ============================================================================

/**
 * Read an arbitrary key from the settings table. Returns null if absent.
 */
export function getSetting(key: string): string | null {
  const row = openDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Write an arbitrary key-value pair to the settings table (upsert).
 */
export function setSetting(key: string, value: string): void {
  openDb()
    .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(key, value);
}

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
 * tables). Used by /api/health to verify migration completed; stage 1
 * of the integration test checks how many names it returns.
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
  'page_links',
  'extractions',
  'page_plans',
  'compile_progress',
  'chat_messages',
  'ingest_failures',
  'vector_backfill_queue',
  'entity_mentions',
  'relationship_mentions',
  'collect_staging',
  'triage_rechecks',
  'disagreements',
  'claim_verdicts',
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
  compile_status: string | null;
  compile_attempts: number | null;
  /** Read by getAllSources only, so a backup carries it. */
  compile_next_eligible_at?: string | null;
  onboarding_session_id: string | null;
  /** Which cascade step produced `title` at ingest time. Drives the
   *  /api/compile/extract rescue trigger. NULL for rows ingested before
   *  schema v25 — the rescue trigger falls back to the legacy
   *  isGarbageTitle heuristic for those rows. */
  title_source: string | null;
  /** ISO timestamp when title was LLM-rescued in /api/compile/extract.
   *  NULL = never rescued (or pre-v25 row). Used as the idempotency
   *  marker so recompile does not re-rescue and rename the wiki page
   *  on every cycle. */
  title_rescued_at: string | null;
  /** v30: publication date, YYYY-MM-DD, and where it came from
   *  (lib/source-dates.ts). NULL for sources added before: read them
   *  with sourceDateOf, which gives their ingest day. */
  published_at?: string | null;
  published_at_source?: string | null;
}

export interface ActivityRow {
  id: number;
  timestamp: string;
  action_type: string;
  source_id: string | null;
  details: string | null;    // JSON TEXT
  source_title: string | null; // joined from sources — always resolved, never an ID
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
  assertSafeId(sourceId, 'source');
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
  compile_status?: 'pending';
  onboarding_session_id?: string | null;
  /** Cascade winner from the converter (file/url) or ingest-text path
   *  ('paste'|'text_first_line'|'saved_link'). Optional for backward
   *  compatibility with call sites not yet updated; missing → NULL,
   *  which the rescue trigger treats as "legacy row, use isGarbageTitle". */
  title_source?: string | null;
  /** v30: the publication date the ingest step picked (lib/source-dates.ts
   *  pickSourceDate); missing -> NULL. */
  published_at?: string | null;
  published_at_source?: string | null;
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
          file_path, status, metadata, compile_status, onboarding_session_id,
          title_source, published_at, published_at_source)
       VALUES
         (@source_id, @title, @source_type, @source_url, @content_hash,
          @file_path, 'active', @metadata, @compile_status, @onboarding_session_id,
          @title_source, @published_at, @published_at_source)`
    )
    .run({
      source_id: args.source_id,
      title: args.title,
      source_type: args.source_type,
      source_url: args.source_url,
      content_hash: args.content_hash,
      file_path: args.file_path,
      metadata: args.metadata ? JSON.stringify(args.metadata) : null,
      compile_status: args.compile_status ?? 'pending',
      onboarding_session_id: args.onboarding_session_id ?? null,
      title_source: args.title_source ?? null,
      published_at: args.published_at ?? null,
      published_at_source: args.published_at_source ?? null,
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
              file_path, status, date_ingested, metadata,
              compile_status, compile_attempts, onboarding_session_id,
              title_source, title_rescued_at, published_at, published_at_source
         FROM sources
         WHERE source_id = ?`
    )
    .get(sourceId) as SourceRow | undefined;
  return row ?? null;
}


/**
 * Delete a source row and return the path of its raw file for cleanup by the
 * caller. Returns null if the source does not exist.
 * Intended to be called INSIDE a db.transaction() callback (sync only).
 *
 * The path comes from the source id (rawFilePath), never from the stored
 * file_path column: a restored backup can put any path there, and the
 * caller unlinks what this returns.
 */
export function deleteSource(sourceId: string): string | null {
  const db = openDb();
  const row = db
    .prepare('SELECT 1 FROM sources WHERE source_id = ?')
    .get(sourceId);
  if (!row) return null;
  const filePath = rawFilePath(sourceId);
  // Must delete child rows before parent — foreign_keys = ON enforces this.
  db.prepare('DELETE FROM extractions WHERE source_id = ?').run(sourceId);
  db.prepare('DELETE FROM sources WHERE source_id = ?').run(sourceId);
  // Invalidate archived-page-ids cache — the deleted source's provenance rows
  // have been removed, which may change which pages are "all-archived".
  _archivedIdsCache = null;
  return filePath;
}

// ============================================================================
// Activity log writes (sync)
// ============================================================================

export interface InsertActivityArgs {
  action_type: string;
  source_id: string | null;
  details: Record<string, unknown> | null;
  /**
   * Compile-pipeline session UUID. Set by every caller in compile + onboarding
   * routes so /api/compile/progress/events can return per-(session, step)
   * audit trails. Null for non-pipeline events (e.g. n8n open-string injection,
   * boot reconciler, source recompile).
   */
  session_id?: string | null;
  /**
   * The CompileStepKey the event was emitted from (e.g. 'extract', 'resolve').
   * Pairs with session_id; null when session_id is null.
   */
  step_key?: string | null;
}

/**
 * @deprecated Use `logActivity(type, {...})` instead. Only allowed direct
 * caller is [app/src/app/api/activity/route.ts](app/src/app/api/activity/route.ts) — the n8n open-string
 * escape hatch. The typed wrapper enforces ActivityEventType at the call
 * site so a new event without a registry entry is a compile error.
 */
export function insertActivity(args: InsertActivityArgs): number {
  const info = openDb()
    .prepare(
      `INSERT INTO activity_log (action_type, source_id, details, session_id, step_key)
       VALUES (@action_type, @source_id, @details, @session_id, @step_key)`
    )
    .run({
      action_type: args.action_type,
      source_id: args.source_id,
      details: args.details ? JSON.stringify(args.details) : null,
      session_id: args.session_id ?? null,
      step_key: args.step_key ?? null,
    });
  return Number(info.lastInsertRowid);
}

/**
 * Typed activity-log writer. The `type` argument is narrowed to the keys
 * of the ACTIVITY_EVENTS registry in [lib/activity-events.tsx](app/src/lib/activity-events.tsx); passing a
 * string not in the registry is a compile error.
 */
export function logActivity(
  type: ActivityEventType,
  args: {
    source_id: string | null;
    details?: Record<string, unknown> | null;
    /** Compile-pipeline session UUID, when the event is emitted from a pipeline route. */
    session_id?: string | null;
    /** Step the event was emitted from (e.g. 'extract', 'resolve'). */
    step_key?: string | null;
  }
): number {
  return insertActivity({
    action_type: type,
    source_id: args.source_id,
    details: args.details ?? null,
    session_id: args.session_id ?? null,
    step_key: args.step_key ?? null,
  });
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
 * Upsert a page row. On conflict (same page_id, i.e. an update), update the
 * fields and bump last_updated + source_count. An update keeps the page's
 * category (it only fills one in when the page has none) and its summary
 * when the update brings none, as lib/page-rewrite.ts does: a draft without
 * a `category:` line no longer moves the page to "Uncategorized".
 * Called inside db.transaction() — no await.
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
         category              = COALESCE(pages.category, excluded.category),
         summary               = COALESCE(excluded.summary, pages.summary),
         content_path          = excluded.content_path,
         previous_content_path = excluded.previous_content_path,
         last_updated          = CURRENT_TIMESTAMP,
         source_count          = source_count + 1`
    )
    .run(args);
}


/**
 * Fetch one page row by id. Used by /wiki/[page_id] server component.
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
  pending_content: string | null;
}

export function getPage(pageId: string): PageRow | null {
  const row = openDb()
    .prepare(
      `SELECT page_id, title, page_type, category, summary, content_path,
              previous_content_path, last_updated, source_count, created_at,
              pending_content
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

export interface ProvenanceRow {
  source_id: string;
  page_id: string;
  content_hash: string;
  contribution_type: string;
  date_compiled: string;
}

export function getAllProvenance(): ProvenanceRow[] {
  return openDb()
    .prepare('SELECT source_id, page_id, content_hash, contribution_type, date_compiled FROM provenance')
    .all() as ProvenanceRow[];
}

// ============================================================================
// Page file storage (gzipped to /data/pages/<page_id>.md.gz)
// The write (version-archiving) is done by nlp-service/services/file_store.py
// before the transaction. This helper reads from that location.
// ============================================================================

export function pagesFilePath(pageId: string): string {
  assertSafeId(pageId, 'page');
  return path.join(DATA_ROOT, 'pages', `${pageId}.md.gz`);
}

/**
 * Read and decompress a compiled wiki page. Used by /wiki/[page_id] server
 * component. Returns null if both the file and pending_content are missing.
 *
 * pages.pending_content (raw TEXT) wins while it is set: a commit sets it in
 * its transaction and clears it only after the file write lands, so it is
 * newer than any file on disk — the Phase 2→3a window, a failed write and
 * boot-reconciler lag. Read-only: flushing it is the reconciler's job.
 */
export function readPageMarkdown(pageId: string): string | null {
  const filePath = pagesFilePath(pageId);
  const pending = getPage(pageId)?.pending_content;
  if (pending != null) return pending;
  if (fs.existsSync(filePath)) {
    const gzipped = fs.readFileSync(filePath);
    return zlib.gunzipSync(gzipped).toString('utf-8');
  }
  return null;
}

// ============================================================================
// Wiki index helpers (commit 11)
// ============================================================================

/** All compiled pages, newest first. Used by /wiki index and /api/pages.
 *
 * When includeArchived=false (default): excludes legacy page_type='archived' rows
 * AND pages where every backing source is archived (all-archived-sources filter).
 */
export function getAllPages(includeArchived = false): PageRow[] {
  const rows = openDb()
    .prepare(
      `SELECT page_id, title, page_type, category, summary, content_path,
              previous_content_path, last_updated, source_count, created_at
         FROM pages
        ${includeArchived ? '' : "WHERE page_type != 'archived'"}
        ORDER BY last_updated DESC`
    )
    .all() as PageRow[];
  if (includeArchived) return rows;
  const archivedIds = getAllArchivedPageIds();
  return rows.filter((r) => !archivedIds.has(r.page_id));
}

/** All compiled page IDs. Used by /api/compile/extract to build TF-IDF corpus. */
export function getAllPageIds(): string[] {
  return (openDb().prepare('SELECT page_id FROM pages').all() as { page_id: string }[]).map(
    (r) => r.page_id
  );
}

export interface CategoryGroup {
  category: string;
  pages: PageRow[];
}

/** Pages grouped by category, sorted alphabetically by category then title.
 *
 * When includeArchived=false (default): excludes page_type='archived' rows
 * and pages where every backing source is archived.
 */
export function getCategoryGroups(includeArchived = false): CategoryGroup[] {
  const rows = openDb()
    .prepare(
      `SELECT page_id, title, page_type, category, summary, content_path,
              previous_content_path, last_updated, source_count, created_at
         FROM pages
        ${includeArchived ? '' : "WHERE page_type != 'archived'"}
        ORDER BY COALESCE(category, 'Uncategorized'), title`
    )
    .all() as PageRow[];
  const filtered = includeArchived ? rows : (() => {
    const archivedIds = getAllArchivedPageIds();
    return rows.filter((r) => !archivedIds.has(r.page_id));
  })();
  const map = new Map<string, PageRow[]>();
  for (const row of filtered) {
    const cat = row.category ?? 'Uncategorized';
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat)!.push(row);
  }
  return Array.from(map.entries()).map(([category, pages]) => ({ category, pages }));
}

/** FTS5 full-text search against pages_fts (title + content).
 *
 * The query is tokenized like the index (see buildFtsQuery), each term
 * prefix-matched, so "sha-256", "proof-of-work" and "cryp" all find pages.
 * Uses parameterized binding (no string interpolation) to eliminate SQL
 * injection risk.
 *
 * Pass excludePageIds (e.g. getAllArchivedPageIds()) to post-filter results.
 * Post-filtering keeps FTS5 rank ordering intact — no subquery in the SQL.
 */
export function searchPages(query: string, limit = 20, excludePageIds?: Set<string>): PageRow[] {
  const ftsQuery = buildFtsQuery(query);
  if (ftsQuery === null) return [];
  const rows = searchPagesFts(ftsQuery, limit);
  if (!excludePageIds || excludePageIds.size === 0) return rows;
  return rows.filter((r) => !excludePageIds.has(r.page_id));
}

/**
 * Run a prebuilt FTS5 MATCH expression (see lib/fts-query.ts), best match
 * first. Optional filters apply before LIMIT, so a filtered search isn't cut
 * short by pages it would drop. Category matches case-insensitively.
 * Archived pages never match: they carry no search row, but a restore
 * made before import left them out still gave them one.
 */
export function searchPagesFts(
  ftsQuery: string,
  limit: number,
  filters: { category?: string; pageType?: string } = {}
): PageRow[] {
  const category = filters.category ?? null;
  const pageType = filters.pageType ?? null;
  return openDb()
    .prepare(
      `SELECT p.page_id, p.title, p.page_type, p.category, p.summary,
              p.content_path, p.previous_content_path, p.last_updated,
              p.source_count, p.created_at
         FROM pages_fts f
         JOIN pages p ON p.page_id = f.page_id
        WHERE pages_fts MATCH ?
          AND p.page_type != 'archived'
          AND (? IS NULL OR p.category = ? COLLATE NOCASE)
          AND (? IS NULL OR p.page_type = ?)
        ORDER BY rank
        LIMIT ?`
    )
    .all(ftsQuery, category, category, pageType, pageType, limit) as PageRow[];
}

/** Pages that link TO the given page_id (backlinks). */
export function getBacklinks(pageId: string): PageRow[] {
  return openDb()
    .prepare(
      `SELECT DISTINCT p.page_id, p.title, p.page_type, p.category, p.summary,
              p.content_path, p.previous_content_path, p.last_updated,
              p.source_count, p.created_at
         FROM page_links l
         JOIN pages p ON p.page_id = l.source_page_id
        WHERE l.target_page_id = ?`
    )
    .all(pageId) as PageRow[];
}

/** Pages the given page links TO (its wikilinks), by title. */
export function getLinkedPages(pageId: string): Array<{ page_id: string; title: string }> {
  return openDb()
    .prepare(
      `SELECT DISTINCT p.page_id, p.title
         FROM page_links l
         JOIN pages p ON p.page_id = l.target_page_id
        WHERE l.source_page_id = ? AND l.target_page_id != l.source_page_id
        ORDER BY p.title COLLATE NOCASE`
    )
    .all(pageId) as Array<{ page_id: string; title: string }>;
}

/** Insert a page_links row (called from compile commit when wikilinks are parsed). */
export function insertPageLink(sourcePageId: string, targetPageId: string, linkType: 'wikilink' | 'provenance' | 'entity-ref'): void {
  openDb()
    .prepare(
      `INSERT OR IGNORE INTO page_links (source_page_id, target_page_id, link_type)
       VALUES (?, ?, ?)`
    )
    .run(sourcePageId, targetPageId, linkType);
}

/** Count of compiled wiki pages. Used by /api/compile/extract to determine wiki_exists. */
export function getPageCount(): number {
  const row = openDb()
    .prepare('SELECT COUNT(*) AS n FROM pages')
    .get() as { n: number };
  return row.n;
}

/** Count of pages waiting for vector re-indexing (failed upsert). */
export function getVectorBacklogCount(): number {
  const row = openDb()
    .prepare('SELECT COUNT(*) AS n FROM vector_backfill_queue')
    .get() as { n: number };
  return row.n;
}

export function getRecentActivity(since: string | null, limit = 100): ActivityRow[] {
  const db = openDb();
  if (since) {
    return db
      .prepare(
        `SELECT a.id, a.timestamp, a.action_type, a.source_id, a.details,
                s.title AS source_title
           FROM activity_log a
           LEFT JOIN sources s ON a.source_id = s.source_id
           WHERE datetime(a.timestamp) > datetime(?)
           ORDER BY a.id DESC
           LIMIT ?`
      )
      .all(since, limit) as ActivityRow[];
  }
  return db
    .prepare(
      `SELECT a.id, a.timestamp, a.action_type, a.source_id, a.details,
              s.title AS source_title
         FROM activity_log a
         LEFT JOIN sources s ON a.source_id = s.source_id
         ORDER BY a.id DESC
         LIMIT ?`
    )
    .all(limit) as ActivityRow[];
}

/**
 * Activity rows scoped to a specific (session_id, step_key) — used by the
 * progress UI's expand-to-reveal view (Phase C). Returns most-recent-first;
 * `limit` is clamped to [1, 200].
 *
 * Both columns added in migration v23. Pre-v23 rows have NULL session_id and
 * step_key, so this function will never return them — desirable, those events
 * predate the scoping concept.
 */
export function getEventsForStep(
  sessionId: string,
  stepKey: string,
  limit = 50,
): ActivityRow[] {
  const cap = Math.max(1, Math.min(200, Math.trunc(limit) || 50));
  return openDb()
    .prepare(
      `SELECT a.id, a.timestamp, a.action_type, a.source_id, a.details,
              s.title AS source_title
         FROM activity_log a
         LEFT JOIN sources s ON a.source_id = s.source_id
         WHERE a.session_id = ? AND a.step_key = ?
         ORDER BY a.id DESC
         LIMIT ?`
    )
    .all(sessionId, stepKey, cap) as ActivityRow[];
}

// ============================================================================
// Extraction helpers (Part 2a)
// ============================================================================

export interface ExtractionRow {
  source_id: string;
  ner_output: string;        // JSON TEXT
  profile: string;
  keyphrase_output: string | null;  // JSON TEXT
  tfidf_output: string | null;      // JSON TEXT
  llm_output: string;        // JSON TEXT
  created_at: string;
}

/**
 * Upsert an extraction result for a source. ON CONFLICT replaces the row —
 * re-running extraction on the same source overwrites the previous result.
 */
export function insertExtraction(data: {
  source_id: string;
  ner_output: object;
  profile: string;
  keyphrase_output: object | null;
  tfidf_output: object | null;
  llm_output: object;
}): void {
  openDb()
    .prepare(
      `INSERT OR REPLACE INTO extractions
         (source_id, ner_output, profile, keyphrase_output, tfidf_output, llm_output)
       VALUES
         (@source_id, @ner_output, @profile, @keyphrase_output, @tfidf_output, @llm_output)`
    )
    .run({
      source_id: data.source_id,
      ner_output: JSON.stringify(data.ner_output),
      profile: data.profile,
      keyphrase_output: data.keyphrase_output ? JSON.stringify(data.keyphrase_output) : null,
      tfidf_output: data.tfidf_output ? JSON.stringify(data.tfidf_output) : null,
      llm_output: JSON.stringify(data.llm_output),
    });
}

/**
 * Store a new extraction, mark its source extracted and swap in its mention
 * rows, in one transaction (the extract route). A crash part-way leaves none
 * of it, so the next compile extracts the source again instead of finding it
 * extracted with no mention rows.
 */
export function saveExtraction(
  data: Parameters<typeof insertExtraction>[0],
  mentions: Pick<SourceMentionRows, 'entities' | 'relations'>
): void {
  openDb().transaction(() => {
    insertExtraction(data);
    markSourceExtracted(data.source_id);
    replaceSourceMentions(data.source_id, mentions.entities, mentions.relations);
  })();
}

/** Fetch one extraction row by source_id. Returns null if not found. */
export function getExtraction(sourceId: string): ExtractionRow | null {
  const row = openDb()
    .prepare(
      `SELECT source_id, ner_output, profile, keyphrase_output, tfidf_output,
              llm_output, created_at
         FROM extractions
         WHERE source_id = ?`
    )
    .get(sourceId) as ExtractionRow | undefined;
  return row ?? null;
}

/** Fetch all extractions for sources belonging to a given onboarding session. */
export function getExtractionsBySession(sessionId: string): ExtractionRow[] {
  return openDb()
    .prepare(
      `SELECT e.source_id, e.ner_output, e.profile, e.keyphrase_output,
              e.tfidf_output, e.llm_output, e.created_at
         FROM extractions e
         JOIN sources s ON s.source_id = e.source_id
        WHERE s.onboarding_session_id = ?
        ORDER BY e.created_at ASC`
    )
    .all(sessionId) as ExtractionRow[];
}

/**
 * Fetch extractions for an explicit set of source_ids. Used by the draft
 * step (Flag 3A) to load cross-session extractions when a plan's
 * `source_ids` spans sessions — a Rule 2/3 entity page whose corpus-wide
 * `getSourceIdsMentioning` pulled sources from older sessions still wants
 * its pre-digested facts in the dossier.
 *
 * Orphan IDs (sources deleted after the plan was written) just don't
 * appear in the result — caller's `if (!ext) continue;` guard handles it.
 */
export function getExtractionsBySourceIds(sourceIds: string[]): ExtractionRow[] {
  if (sourceIds.length === 0) return [];
  const placeholders = sourceIds.map(() => '?').join(',');
  return openDb()
    .prepare(
      `SELECT e.source_id, e.ner_output, e.profile, e.keyphrase_output,
              e.tfidf_output, e.llm_output, e.created_at
         FROM extractions e
        WHERE e.source_id IN (${placeholders})
        ORDER BY e.created_at ASC`
    )
    .all(...sourceIds) as ExtractionRow[];
}

// ---------------------------------------------------------------------------
// entity_mentions — wiki-wide entity mention index (schema v17)
// ---------------------------------------------------------------------------
//
// Lets the plan step answer "how many distinct sources have ever mentioned
// this entity?" as a single indexed COUNT, independent of compile session
// boundaries. Writes happen at extract-commit time with alias pinning so
// "GPT-4" and "GPT4" collapse to one canonical before counting.

/**
 * Bulk insert (canonical_name, source_id, entity_type) rows. Uses INSERT OR
 * IGNORE so a re-extracted source can't double-count (PRIMARY KEY is the
 * (canonical, source) pair). Runs in a single transaction. first_seen_at
 * defaults to now; the resolve rebuild passes the old row's.
 */
export function insertEntityMentions(
  mentions: Array<{ canonical_name: string; source_id: string; entity_type: string | null; first_seen_at?: string | null }>
): void {
  if (mentions.length === 0) return;
  const db = openDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO entity_mentions (canonical_name, source_id, entity_type, first_seen_at)
     VALUES (@canonical_name, @source_id, @entity_type, COALESCE(@first_seen_at, CURRENT_TIMESTAMP))`
  );
  db.transaction((rows: typeof mentions) => {
    for (const row of rows) {
      stmt.run({
        canonical_name: row.canonical_name,
        source_id: row.source_id,
        entity_type: row.entity_type,
        first_seen_at: row.first_seen_at ?? null,
      });
    }
  })(mentions);
}

/**
 * Remove all mention rows for a source. Called when a source is re-extracted
 * so the mention set reflects the latest llm_output (canonicals may shift if
 * aliases were edited between extracts).
 */
export function deleteEntityMentionsForSource(sourceId: string): void {
  openDb()
    .prepare(`DELETE FROM entity_mentions WHERE source_id = ?`)
    .run(sourceId);
}

/**
 * COUNT(DISTINCT source_id) for a canonical name. Case-insensitive via the
 * COLLATE NOCASE on the column. Returns 0 if the entity has never been
 * mentioned (e.g. first extraction just happened but the write hasn't
 * committed yet).
 */
export function countSourcesMentioning(canonicalName: string): number {
  const row = openDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM entity_mentions WHERE canonical_name = ?`
    )
    .get(canonicalName) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * All source_ids that have ever mentioned a canonical entity name. Used by
 * the plan step when a session-new entity crosses the wiki-wide threshold —
 * the new page needs provenance for every historical source that mentioned
 * the entity, not just the sources in the current compile session.
 */
export function getSourceIdsMentioning(canonicalName: string): string[] {
  return (openDb()
    .prepare(
      `SELECT DISTINCT source_id FROM entity_mentions WHERE canonical_name = ?`
    )
    .all(canonicalName) as Array<{ source_id: string }>).map((r) => r.source_id);
}

/**
 * Bulk insert (from, to, type, source_id) rows into relationship_mentions.
 * Caller is responsible for normalizing from/to order for direction-agnostic
 * relationships (competes_with, contradicts) so the PK collapses "A vs B"
 * and "B vs A" to one row (lib/relation-rows.ts does both).
 *
 * An existing row keeps its other columns (first_seen_at included); only its
 * description (v28) is refreshed, and only by a non-null one, and its quote
 * with quote_verified (v30), only by a non-null quote. A new row's
 * first_seen_at defaults to now; the resolve rebuild passes the old row's.
 */
export function insertRelationshipMentions(
  mentions: Array<{
    from_canonical: string;
    to_canonical: string;
    relationship_type: string;
    source_id: string;
    description?: string | null;
    quote?: string | null;
    quote_verified?: boolean | null;
    first_seen_at?: string | null;
  }>
): void {
  if (mentions.length === 0) return;
  const db = openDb();
  const stmt = db.prepare(
    `INSERT INTO relationship_mentions
       (from_canonical, to_canonical, relationship_type, source_id, description, quote, quote_verified,
        first_seen_at)
     VALUES (@from_canonical, @to_canonical, @relationship_type, @source_id, @description, @quote,
             @quote_verified, COALESCE(@first_seen_at, CURRENT_TIMESTAMP))
     ON CONFLICT(from_canonical, to_canonical, relationship_type, source_id)
       DO UPDATE SET description = COALESCE(excluded.description, description),
                     quote_verified = CASE WHEN excluded.quote IS NULL THEN quote_verified
                                           ELSE excluded.quote_verified END,
                     quote = COALESCE(excluded.quote, quote)`
  );
  db.transaction((rows: typeof mentions) => {
    for (const row of rows) {
      const quote = row.quote ?? null;
      stmt.run({
        from_canonical: row.from_canonical,
        to_canonical: row.to_canonical,
        relationship_type: row.relationship_type,
        source_id: row.source_id,
        description: row.description ?? null,
        quote,
        quote_verified: quote === null ? null : quoteVerifiedColumn(row.quote_verified),
        first_seen_at: row.first_seen_at ?? null,
      });
    }
  })(mentions);
}

/** Remove relationship_mentions rows for a source (used before re-extract). */
export function deleteRelationshipMentionsForSource(sourceId: string): void {
  openDb()
    .prepare(`DELETE FROM relationship_mentions WHERE source_id = ?`)
    .run(sourceId);
}

/**
 * Swap a source's entity_mentions and relationship_mentions for a new
 * extraction's, in one transaction: a failure part-way keeps the old rows
 * instead of leaving the source with none while its extraction row stays
 * (the next compile would not extract it again). The inserts' own
 * transactions run as savepoints inside this one.
 */
export function replaceSourceMentions(
  sourceId: string,
  entities: Parameters<typeof insertEntityMentions>[0],
  relations: Parameters<typeof insertRelationshipMentions>[0]
): void {
  openDb().transaction(() => {
    deleteEntityMentionsForSource(sourceId);
    deleteRelationshipMentionsForSource(sourceId);
    insertEntityMentions(entities);
    insertRelationshipMentions(relations);
  })();
}

/**
 * Rewrite a session's mention rows after resolve. Each source's rows, rebuilt
 * from its extraction through the resolver's groups (lib/mention-rows.ts
 * sessionMentionRows), replace its old ones through replaceSourceMentions,
 * all in one transaction. The rows follow the resolver's latest groups, so a
 * merge a rerun no longer makes leaves the counts, and a rerun with the same
 * groups gives the same rows.
 *
 * A row keeps the first_seen_at of the old row with its key, else the
 * source's earliest old row (a renamed row was seen when its source was),
 * else the extraction's created_at (a source extracted without rows). A
 * relation without a sentence keeps the old row's, and one without a quote
 * the old row's quote. A source outside the session is skipped, so other
 * sessions' rows never change. Returns the number of sources rewritten.
 */
export function rebuildSessionMentions(sessionId: string, sources: SourceMentionRows[]): number {
  const inSession = openDb().prepare('SELECT 1 FROM sources WHERE source_id = ? AND onboarding_session_id = ?');
  return rewriteMentionRows(sources, (sourceId) => Boolean(inSession.get(sourceId, sessionId)));
}

/**
 * The same rewrite for every source given, whatever its session: the wiki
 * repair (lib/wiki-repair) re-credits every source's mentions from its
 * extraction in one transaction. A source no longer in the wiki is skipped.
 */
export function rebuildWikiMentions(sources: SourceMentionRows[]): number {
  const exists = openDb().prepare('SELECT 1 FROM sources WHERE source_id = ?');
  return rewriteMentionRows(sources, (sourceId) => Boolean(exists.get(sourceId)));
}

function rewriteMentionRows(sources: SourceMentionRows[], include: (sourceId: string) => boolean): number {
  const db = openDb();
  const oldEntities = db.prepare('SELECT canonical_name, first_seen_at FROM entity_mentions WHERE source_id = ?');
  const oldRelations = db.prepare(
    `SELECT from_canonical, to_canonical, relationship_type, first_seen_at, description, quote, quote_verified
       FROM relationship_mentions WHERE source_id = ?`
  );
  const extractedAt = db.prepare('SELECT created_at FROM extractions WHERE source_id = ?');
  // canonical_name is COLLATE NOCASE, which folds ASCII letters only.
  const nocase = (name: string) => name.replace(/[A-Z]/g, (c) => c.toLowerCase());
  type OldRelation = {
    from_canonical: string;
    to_canonical: string;
    relationship_type: string;
    first_seen_at: string | null;
    description: string | null;
    quote: string | null;
    quote_verified: number | null;
  };

  let rebuilt = 0;
  db.transaction(() => {
    for (const { source_id, entities, relations } of sources) {
      if (!include(source_id)) continue;
      const entitySeen = new Map<string, string | null>();
      for (const r of oldEntities.all(source_id) as Array<{ canonical_name: string; first_seen_at: string | null }>) {
        entitySeen.set(nocase(r.canonical_name), r.first_seen_at);
      }
      const relationOld = new Map<string, OldRelation>();
      for (const r of oldRelations.all(source_id) as OldRelation[]) {
        relationOld.set(relationKey(r.from_canonical, r.to_canonical, r.relationship_type), r);
      }
      const earliest = [...entitySeen.values(), ...[...relationOld.values()].map((r) => r.first_seen_at)]
        .filter((d): d is string => !!d)
        .sort()[0];
      const seenAt =
        earliest ?? (extractedAt.get(source_id) as { created_at: string | null } | undefined)?.created_at ?? null;
      replaceSourceMentions(
        source_id,
        entities.map((e) => ({ ...e, source_id, first_seen_at: entitySeen.get(nocase(e.canonical_name)) ?? seenAt })),
        relations.map((r) => {
          const old = relationOld.get(relationKey(r.from_canonical, r.to_canonical, r.relationship_type));
          const quote =
            r.quote === null && old?.quote
              ? { quote: old.quote, quote_verified: quoteVerifiedFromColumn(old.quote_verified) }
              : { quote: r.quote, quote_verified: r.quote_verified };
          return {
            ...r,
            ...quote,
            source_id,
            description: r.description ?? old?.description ?? null,
            first_seen_at: old?.first_seen_at ?? seenAt,
          };
        })
      );
      rebuilt += 1;
    }
  })();
  return rebuilt;
}

/**
 * COUNT(DISTINCT source_id) for a specific relationship pair+type.
 * Callers pass from/to already sorted (for direction-agnostic types).
 */
export function countSourcesForRelationship(
  fromCanonical: string,
  toCanonical: string,
  relationshipType: string
): number {
  const row = openDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM relationship_mentions
        WHERE from_canonical = ? AND to_canonical = ? AND relationship_type = ?`
    )
    .get(fromCanonical, toCanonical, relationshipType) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** All source_ids that witnessed a specific relationship. Mirrors getSourceIdsMentioning. */
export function getSourceIdsForRelationship(
  fromCanonical: string,
  toCanonical: string,
  relationshipType: string
): string[] {
  return (openDb()
    .prepare(
      `SELECT DISTINCT source_id FROM relationship_mentions
        WHERE from_canonical = ? AND to_canonical = ? AND relationship_type = ?`
    )
    .all(fromCanonical, toCanonical, relationshipType) as Array<{ source_id: string }>
  ).map((r) => r.source_id);
}

/**
 * The (from, to) name pairs of a session's competes_with / contradicts rows
 * (COMPARISON_RELATIONS), as resolve left them: the plan step's comparison
 * candidates.
 */
export function getSessionComparisonPairs(sessionId: string): Array<{ from_canonical: string; to_canonical: string }> {
  const types = [...COMPARISON_RELATIONS];
  return openDb()
    .prepare(
      `SELECT DISTINCT rm.from_canonical, rm.to_canonical
         FROM relationship_mentions rm
         JOIN sources s ON s.source_id = rm.source_id
        WHERE s.onboarding_session_id = ?
          AND rm.relationship_type IN (${types.map(() => '?').join(', ')})
        ORDER BY rm.from_canonical, rm.to_canonical`
    )
    .all(sessionId, ...types) as Array<{ from_canonical: string; to_canonical: string }>;
}

/**
 * Distinct sources that say two subjects compete with or contradict each
 * other: competes_with and contradicts rows together, in either stored
 * order (a row renamed before rows were re-sorted may be unsorted).
 */
export function getComparisonSourceIds(nameA: string, nameB: string): string[] {
  const types = [...COMPARISON_RELATIONS];
  return (openDb()
    .prepare(
      `SELECT DISTINCT source_id FROM relationship_mentions
        WHERE relationship_type IN (${types.map(() => '?').join(', ')})
          AND ((from_canonical = ? AND to_canonical = ?) OR (from_canonical = ? AND to_canonical = ?))
        ORDER BY source_id`
    )
    .all(...types, nameA, nameB, nameB, nameA) as Array<{ source_id: string }>
  ).map((r) => r.source_id);
}

/**
 * Total count of sources that have successfully contributed to the wiki.
 * Used as the denominator for percentage-based promotion thresholds.
 * Counts only sources with compile_status='active' — ingested-but-failed
 * sources don't belong in the denominator.
 */
export function getCorpusActiveSourceCount(): number {
  const row = openDb()
    .prepare(`SELECT COUNT(*) AS n FROM sources WHERE compile_status = 'active'`)
    .get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Fetch all extraction rows — used for kompl backup export. */
export function getAllExtractions(): ExtractionRow[] {
  return openDb()
    .prepare(
      `SELECT source_id, ner_output, profile, keyphrase_output, tfidf_output,
              llm_output, created_at
         FROM extractions
        ORDER BY created_at ASC`
    )
    .all() as ExtractionRow[];
}

/** All settings rows for wiki export. */
export function getExportableSettings(): Array<{ key: string; value: string }> {
  return openDb()
    .prepare(`SELECT key, value FROM settings`)
    .all() as Array<{ key: string; value: string }>;
}

/**
 * Set compile_status = 'extracted' for a source after successful extraction.
 */
export function markSourceExtracted(sourceId: string): void {
  openDb()
    .prepare(
      `UPDATE sources
          SET compile_status = 'extracted'
        WHERE source_id = ?
          AND compile_status IN ('pending', 'in_progress')`
    )
    .run(sourceId);
}

export interface UpdateSourceTitleOpts {
  /** When true, also stamp title_rescued_at = now in the same UPDATE.
   *  Used by the /api/compile/extract LLM-title rescue path so subsequent
   *  recompiles can detect "this title was already rescued" and skip
   *  re-rescuing (prevents wiki-page title churn on every recompile). */
  markRescued?: boolean;
}

/**
 * Replace a source's title — used when the extract LLM derives a real
 * document title for a source whose original title was a filename stub
 * (arxiv ID, digit-only filename, etc.). Trim + cap at 250 chars to keep
 * the column index lean. No-op on empty input.
 *
 * Atomic when markRescued is set: title and title_rescued_at update in
 * the same UPDATE statement, so a crash between them cannot leave the
 * row in a "rescued title, no marker → re-rescue forever" state.
 */
export function updateSourceTitle(
  sourceId: string,
  newTitle: string,
  opts: UpdateSourceTitleOpts = {}
): void {
  const trimmed = (newTitle ?? '').trim();
  if (!trimmed) return;
  const capped = trimmed.length > 250 ? trimmed.slice(0, 250) : trimmed;
  if (opts.markRescued) {
    openDb()
      .prepare(
        `UPDATE sources
            SET title = ?, title_rescued_at = datetime('now')
          WHERE source_id = ?`
      )
      .run(capped, sourceId);
  } else {
    openDb()
      .prepare(`UPDATE sources SET title = ? WHERE source_id = ?`)
      .run(capped, sourceId);
  }
}

/**
 * Reset a source back to 'pending' so the compile pipeline will re-process it.
 * Clears attempt counter and backoff timestamp. Used by the manual recompile
 * endpoint and the UI retry flow.
 */
export function resetSourceForRecompile(sourceId: string): void {
  openDb()
    .prepare(
      `UPDATE sources
          SET compile_status = 'pending',
              compile_attempts = 0,
              compile_next_eligible_at = NULL
        WHERE source_id = ?`
    )
    .run(sourceId);
}

// ---------------------------------------------------------------------------
// Alias helpers — Part 2b entity resolution
// ---------------------------------------------------------------------------

/**
 * Alias status (schema v29). Compiles use 'active' rows only (getAliases).
 * 'suspended' rows are set aside until confirmed (lib/alias-screen.ts sets
 * them); a new resolver match re-activates one. 'retired' rows were judged
 * wrong and are never used or re-added. NULL reads as 'active'.
 */
export type AliasStatus = 'active' | 'suspended' | 'retired';

/** A new alias → canonical mapping and how the resolver made it. */
export interface AliasInsert {
  alias: string;
  canonical: string;
  /** The resolver rule or layer that matched the names ("skeleton", "llm", ...). */
  method?: string | null;
  /** The similarity behind the match, when the resolver knew one. */
  score?: number | null;
  session_id?: string | null;
}

/**
 * Batch-insert alias → canonical_name mappings in a single transaction.
 * The aliases table has no UNIQUE constraint on alias, so we load existing
 * pairs first and skip duplicates rather than relying on INSERT OR IGNORE.
 * Duplicates are judged on the (alias, canonical) pair: an alias whose old
 * row getAliases() ignores (see name-guard.ts) can get a new mapping; the
 * old row is kept, never deleted. For a pair already stored:
 *   - active: nothing changes
 *   - suspended: the new match re-activates it and records its method,
 *     score and session (status_reason 'rematched')
 *   - retired: nothing changes, and no new row is added
 */
export function bulkInsertAliases(aliases: AliasInsert[]): void {
  if (aliases.length === 0) return;
  const db = openDb();
  const pairKey = (alias: string, canonical: string) => `${alias.toLowerCase()}\u0000${canonical.toLowerCase()}`;
  const existing = new Map<string, Array<{ id: number; status: string }>>();
  for (const r of db.prepare('SELECT id, alias, canonical_name, status FROM aliases').all() as Array<{
    id: number;
    alias: string;
    canonical_name: string | null;
    status: string | null;
  }>) {
    const key = pairKey(r.alias, r.canonical_name ?? '');
    const list = existing.get(key) ?? [];
    list.push({ id: r.id, status: r.status ?? 'active' });
    existing.set(key, list);
  }
  const insert = db.prepare(
    'INSERT INTO aliases (alias, canonical_name, method, score, session_id) VALUES (?, ?, ?, ?, ?)'
  );
  const reactivate = db.prepare(
    `UPDATE aliases
        SET status = 'active', status_reason = 'rematched', status_at = datetime('now'),
            method = ?, score = ?, session_id = ?
      WHERE id = ? AND status = 'suspended'`
  );
  db.transaction((rows: AliasInsert[]) => {
    for (const { alias, canonical, method = null, score = null, session_id = null } of rows) {
      const key = pairKey(alias, canonical);
      const stored = existing.get(key);
      if (!stored) {
        insert.run(alias, canonical, method, score, session_id);
        existing.set(key, [{ id: -1, status: 'active' }]);
        continue;
      }
      if (stored.some((r) => r.status === 'retired' || r.status === 'active')) continue;
      for (const r of stored) {
        if (r.status !== 'suspended') continue;
        reactivate.run(method, score, session_id, r.id);
        r.status = 'active';
      }
    }
  })(aliases);
}

/**
 * Return the alias → canonical_name pairs the compile steps may use (Layer 1
 * fuzzy resolution, mention pinning, dossiers, crossref link targets).
 *
 * Only active rows (v29; NULL status counts as active): suspended and
 * retired aliases bind nothing. Rows whose two names carry different numbers
 * ("Python 3" → "Python 2", "Python" → "Python 2") are left out too:
 * resolution created those before it could tell versions apart, and they
 * would keep sending new sources to the wrong page. The rows stay in the
 * table (getAllAliases, backups). Oldest first, so a newer mapping for the
 * same alias wins where callers build a map.
 */
export function getAliases(): Array<{ alias: string; canonical_name: string }> {
  const rows = openDb()
    .prepare(
      `SELECT alias, canonical_name FROM aliases
        WHERE canonical_name IS NOT NULL AND COALESCE(status, 'active') = 'active'
        ORDER BY id`
    )
    .all() as Array<{ alias: string; canonical_name: string }>;
  return rows.filter((r) => numericConflict(r.alias, r.canonical_name) === null);
}

/** An alias row as a kompl backup carries it. */
export interface AliasRecord {
  alias: string;
  canonical_name: string;
  canonical_page_id: string | null;
  method: string | null;
  score: number | null;
  session_id: string | null;
  status: string | null;
  status_reason: string | null;
  status_at: string | null;
  created_at: string | null;
}

/** All alias rows, whatever their status, oldest first — used for kompl backup export. */
export function getAllAliases(): AliasRecord[] {
  return openDb()
    .prepare(
      `SELECT alias, canonical_name, canonical_page_id, method, score, session_id,
              status, status_reason, status_at, created_at
         FROM aliases ORDER BY id`
    )
    .all() as AliasRecord[];
}

/**
 * Return titles of all entity and concept pages — used by the resolver to match
 * session entities/concepts against pages that already exist in the wiki. This
 * is the cross-session bridge that keeps the alias drawer from being the sole
 * signal for cross-session canonicalisation. Sorted, so the resolver breaks
 * ties between matching pages the same way on every run.
 */
export function getEntityAndConceptPageTitles(): Array<{ title: string; page_type: string }> {
  return openDb()
    .prepare(
      `SELECT title, page_type FROM pages WHERE page_type IN ('entity', 'concept')
        ORDER BY title, page_type`
    )
    .all() as Array<{ title: string; page_type: string }>;
}

/**
 * Pin an alias row's canonical_page_id once the canonical's page has been
 * committed. Shared by compile/commit and approve-plan so both auto-approve
 * and manual-approve paths keep the alias drawer in sync with actual pages.
 * Used for entity and concept pages (page_type === 'entity' | 'concept').
 * No-op if there is no alias row for the title.
 */
export function backfillAliasCanonicalPageId(title: string, pageId: string): void {
  openDb()
    .prepare(`UPDATE aliases SET canonical_page_id = ? WHERE canonical_name = ? COLLATE NOCASE`)
    .run(pageId, title);
}

/**
 * Fetch contradiction events logged against a page, newest first.
 *
 * Canonical source of truth is the activity_log row written by plan Rule 6
 * when the match step's LLM triage returns decision='contradiction'. No
 * separate table — the activity row carries the full payload (source meta,
 * reason, timestamps) so the sidebar, future inbox, or any audit surface
 * can read the same data without a schema change.
 *
 * Uses json_extract (SQLite 3.38+) on the already-indexed activity_log
 * table. No new indexes — contradiction volume is expected to be low (LLM
 * triage only flags above the 0.3 TF-IDF threshold) and the page_id scan
 * stays bounded.
 */
export interface PageContradiction {
  source_id: string | null;
  source_title: string | null;
  source_url: string | null;
  source_type: string | null;
  date_ingested: string | null;
  reason: string | null;
  session_id: string | null;
  detected_at: string | null;
}

export function getPageContradictions(pageId: string): PageContradiction[] {
  const rows = openDb()
    .prepare(
      // Tiebreak on id DESC because activity_log.timestamp has 1s resolution —
      // two contradictions logged in the same second must still come back in
      // insertion order (newest first).
      `SELECT details
         FROM activity_log
        WHERE action_type = 'page_contradiction_detected'
          AND json_extract(details, '$.page_id') = ?
        ORDER BY timestamp DESC, id DESC`
    )
    .all(pageId) as Array<{ details: string | null }>;

  const out: PageContradiction[] = [];
  for (const row of rows) {
    if (!row.details) continue;
    try {
      const d = JSON.parse(row.details) as Record<string, unknown>;
      out.push({
        source_id: typeof d.source_id === 'string' ? d.source_id : null,
        source_title: typeof d.source_title === 'string' ? d.source_title : null,
        source_url: typeof d.source_url === 'string' ? d.source_url : null,
        source_type: typeof d.source_type === 'string' ? d.source_type : null,
        date_ingested: typeof d.date_ingested === 'string' ? d.date_ingested : null,
        reason: typeof d.reason === 'string' ? d.reason : null,
        session_id: typeof d.session_id === 'string' ? d.session_id : null,
        detected_at: typeof d.detected_at === 'string' ? d.detected_at : null,
      });
    } catch {
      // Malformed JSON — skip the row, don't crash the sidebar.
    }
  }
  return out;
}


// ============================================================================
// Page plan helpers (Part 2c-i)
// ============================================================================

export interface PagePlanRow {
  plan_id: string;
  session_id: string;
  title: string;
  page_type: string;
  action: string;
  source_ids: string;    // JSON TEXT — parse with JSON.parse
  existing_page_id: string | null;
  related_plan_ids: string | null;  // JSON TEXT
  draft_content: string | null;
  draft_status: string;
  draft_error: string | null;  // populated by updatePlanFailed (schema v24)
  created_at: string;
}

/**
 * `draft_status` defaults to 'planned' (draft writes it next). A plan with
 * nothing to draft or link up, a provenance-only plan, is stored
 * 'crossreffed': ready for commit.
 */
export function insertPagePlan(plan: {
  plan_id: string;
  session_id: string;
  title: string;
  page_type: string;
  action: string;
  source_ids: string[];
  existing_page_id?: string | null;
  related_plan_ids?: string[];
  draft_status?: 'planned' | 'crossreffed';
}): void {
  openDb()
    .prepare(
      `INSERT INTO page_plans
         (plan_id, session_id, title, page_type, action,
          source_ids, existing_page_id, related_plan_ids, draft_status)
       VALUES
         (@plan_id, @session_id, @title, @page_type, @action,
          @source_ids, @existing_page_id, @related_plan_ids, @draft_status)`
    )
    .run({
      plan_id: plan.plan_id,
      session_id: plan.session_id,
      title: plan.title,
      page_type: plan.page_type,
      action: plan.action,
      source_ids: JSON.stringify(plan.source_ids),
      existing_page_id: plan.existing_page_id ?? null,
      related_plan_ids: plan.related_plan_ids ? JSON.stringify(plan.related_plan_ids) : null,
      draft_status: plan.draft_status ?? 'planned',
    });
}

/**
 * Deletes all non-committed page_plans for a session before re-planning.
 * Makes the plan step idempotent on retry: stale 'planned', 'drafted',
 * 'crossreffed', and 'failed' rows from a prior failed run are cleared so
 * the draft step only sees plans from the current run.
 * Preserves 'committed' (already written to pages table),
 * 'pending_approval' (awaiting user review, separate lifecycle),
 * and 'rejected' (audit trail).
 */
export function clearStagedPagePlans(sessionId: string): void {
  openDb()
    .prepare(
      `DELETE FROM page_plans
        WHERE session_id = ?
          AND draft_status NOT IN ('committed', 'pending_approval', 'rejected')`
    )
    .run(sessionId);
}


export function getPagePlansByStatus(sessionId: string, status: string): PagePlanRow[] {
  return openDb()
    .prepare(
      `SELECT plan_id, session_id, title, page_type, action,
              source_ids, existing_page_id, related_plan_ids,
              draft_content, draft_status, draft_error, created_at
         FROM page_plans
        WHERE session_id = ? AND draft_status = ?
        ORDER BY created_at ASC`
    )
    .all(sessionId, status) as PagePlanRow[];
}

/**
 * All page_plans rows for the session, regardless of draft_status. Used by
 * /api/compile/progress/items?step=plan|draft|crossref to render the per-page
 * progress list in the expand-to-reveal UI.
 */
export function getAllPagePlansBySession(sessionId: string): PagePlanRow[] {
  return openDb()
    .prepare(
      `SELECT plan_id, session_id, title, page_type, action,
              source_ids, existing_page_id, related_plan_ids,
              draft_content, draft_status, draft_error, created_at
         FROM page_plans
        WHERE session_id = ?
        ORDER BY created_at ASC`
    )
    .all(sessionId) as PagePlanRow[];
}

/**
 * Sources for the session, with a synthetic `extracted` flag based on whether
 * an extractions row exists. Backs /api/compile/progress/items?step=extract:
 * the UI shows ✓ for extracted, ⏳ for pending, with no separate failed state
 * here (per-source extract failures land in activity_log, not as a row state).
 */
export function getSourcesForSessionWithExtractStatus(
  sessionId: string,
): Array<{ source_id: string; title: string; extracted: boolean }> {
  const rows = openDb()
    .prepare(
      `SELECT s.source_id, s.title,
              CASE WHEN e.source_id IS NULL THEN 0 ELSE 1 END AS extracted
         FROM sources s
         LEFT JOIN extractions e ON e.source_id = s.source_id
        WHERE s.onboarding_session_id = ?
        ORDER BY s.date_ingested ASC`
    )
    .all(sessionId) as Array<{ source_id: string; title: string; extracted: 0 | 1 }>;
  return rows.map((r) => ({
    source_id: r.source_id,
    title: r.title,
    extracted: r.extracted === 1,
  }));
}

/**
 * Pages committed during the session — joined via the page_plans rows that
 * belong to the session. Backs /api/compile/progress/items?step=commit.
 */
export function getPagesForSession(
  sessionId: string,
): Array<{ page_id: string; title: string }> {
  return openDb()
    .prepare(
      `SELECT DISTINCT p.page_id, p.title
         FROM pages p
         JOIN page_plans pp ON pp.existing_page_id = p.page_id
                            OR (pp.draft_status = 'committed' AND pp.title = p.title)
        WHERE pp.session_id = ?
        ORDER BY p.title ASC`
    )
    .all(sessionId) as Array<{ page_id: string; title: string }>;
}

/**
 * Store a plan's draft. `draftRules` records the writing rules an LLM draft
 * was made under (lib/draft-rules.ts CURRENT_DRAFT_RULES); null for drafts
 * that are not LLM-written (original-source passthroughs). `baseVersion`
 * (v30) is the version of the page an update draft read
 * (lib/page-rewrite.ts pageTextVersionToken); null for a new page.
 *
 * Only a plan still waiting for its draft ('planned', or 'failed' by an
 * earlier attempt) takes it. A draft run that outlived its step (the
 * orchestrator gave up and a Retry drafted, linked or saved the plan since)
 * would otherwise move the plan back to 'drafted', where commit never reads
 * it and the page is lost. Returns false when the plan was not waiting.
 */
export function updatePlanDraft(
  planId: string,
  draftContent: string,
  draftRules: string | null,
  baseVersion: string | null = null,
  /** Sources the draft's prompt carried (v30); NULL credits every plan source (lib/plan-provenance.ts). */
  usedSourceIds: string[] | null = null,
): boolean {
  const result = openDb()
    .prepare(
      `UPDATE page_plans
          SET draft_content = ?, draft_status = 'drafted', draft_rules = ?, base_version = ?,
              used_source_ids = ?
        WHERE plan_id = ? AND draft_status IN ('planned', 'failed')`
    )
    .run(draftContent, draftRules, baseVersion, usedSourceIds ? JSON.stringify(usedSourceIds) : null, planId);
  return result.changes > 0;
}

/**
 * The draft step's failure write: updatePlanFailed, but only while the plan
 * still waits for its draft, for the same reason as updatePlanDraft. Returns
 * false when the plan was not waiting.
 */
export function updatePlanDraftFailed(planId: string, errorMessage: string): boolean {
  const truncated = errorMessage.length > 1000 ? errorMessage.slice(0, 1000) + '… [truncated]' : errorMessage;
  const result = openDb()
    .prepare(
      `UPDATE page_plans SET draft_status = 'failed', draft_error = ?
        WHERE plan_id = ? AND draft_status IN ('planned', 'failed')`
    )
    .run(truncated, planId);
  return result.changes > 0;
}

/**
 * Was the page rewritten after `since` (a page_plans.created_at)? Approving
 * an update draft made before v30, which records no base_version, falls
 * back to this (lib/approve-plan.ts). Every rewrite bumps last_updated.
 * Both are whole seconds: a page last written in the plan's own second was
 * written before planning read it (planning writes no pages), so it counts
 * as unchanged. A missing page counts as changed.
 */
export function pageRewrittenSince(pageId: string, since: string): boolean {
  const row = openDb()
    .prepare(
      `SELECT julianday(last_updated) > julianday(?) AS changed FROM pages WHERE page_id = ?`
    )
    .get(since, pageId) as { changed: number | null } | undefined;
  return row === undefined || row.changed !== 0;
}

export function updatePlanCrossref(planId: string, draftContent: string): void {
  openDb()
    .prepare(
      `UPDATE page_plans
          SET draft_content = ?, draft_status = 'crossreffed'
        WHERE plan_id = ?`
    )
    .run(draftContent, planId);
}

export function updatePlanStatus(planId: string, status: string): void {
  openDb()
    .prepare(`UPDATE page_plans SET draft_status = ? WHERE plan_id = ?`)
    .run(status, planId);
}

/**
 * Mark a page_plan as failed AND record the error message in one update.
 * Replaces the silent `updatePlanStatus(plan_id, 'failed')` pattern that
 * threw away every per-task error from the draft pLimit pool — operators
 * had to grep app logs for 30+ min to recover the cause. Truncates to 1000
 * chars to keep DB row size bounded; full stack lives in `console.error`
 * at the call site.
 */
export function updatePlanFailed(planId: string, errorMessage: string): void {
  const truncated = errorMessage.length > 1000 ? errorMessage.slice(0, 1000) + '… [truncated]' : errorMessage;
  openDb()
    .prepare(`UPDATE page_plans SET draft_status = 'failed', draft_error = ? WHERE plan_id = ?`)
    .run(truncated, planId);
}

/** Fetch a page by title (case-insensitive). Returns null if not found. */
export function getPageByTitle(title: string): PageRow | null {
  const row = openDb()
    .prepare(
      `SELECT page_id, title, page_type, category, summary, content_path,
              previous_content_path, last_updated, source_count, created_at
         FROM pages WHERE title = ? COLLATE NOCASE LIMIT 1`
    )
    .get(title) as PageRow | undefined;
  return row ?? null;
}

const PLAN_PAGE_COLUMNS = `p.page_id, p.title, p.page_type, p.category, p.summary, p.content_path,
              p.previous_content_path, p.last_updated, p.source_count, p.created_at`;

/**
 * A source's own page (plan Rule 1): the source-summary or original-source
 * page whose provenance holds the source. Titles are not unique and match
 * any page type, so a title lookup turned the "Ethereum" entity page into a
 * summary, and two sources titled "Introduction" shared one page. When
 * several pages hold the source, the one holding the fewest sources wins
 * (its own page, not one an old bug overwrote), then the oldest.
 *
 * A source page with no provenance at all is still found by its title, so a
 * page written before provenance existed keeps being updated, not duplicated.
 */
export function getSourcePage(sourceId: string, title: string): PageRow | null {
  const db = openDb();
  const own = db
    .prepare(
      `SELECT ${PLAN_PAGE_COLUMNS}
         FROM pages p
        WHERE p.page_type IN ('source-summary', 'original-source')
          AND EXISTS (SELECT 1 FROM provenance pr WHERE pr.page_id = p.page_id AND pr.source_id = ?)
        ORDER BY (SELECT COUNT(DISTINCT pr.source_id) FROM provenance pr WHERE pr.page_id = p.page_id),
                 p.created_at, p.page_id
        LIMIT 1`
    )
    .get(sourceId) as PageRow | undefined;
  if (own) return own;
  const untracked = db
    .prepare(
      `SELECT ${PLAN_PAGE_COLUMNS}
         FROM pages p
        WHERE p.title = ? COLLATE NOCASE
          AND p.page_type IN ('source-summary', 'original-source')
          AND NOT EXISTS (SELECT 1 FROM provenance pr WHERE pr.page_id = p.page_id)
        ORDER BY p.created_at, p.page_id
        LIMIT 1`
    )
    .get(title) as PageRow | undefined;
  return untracked ?? null;
}

/**
 * The page a canonical name updates (plan Rules 2 and 3): an entity,
 * concept, comparison or overview page with that title. Source pages and
 * archived pages are left out, so a source titled "Ethereum" never becomes
 * the Ethereum page. An entity or concept page wins, then the oldest.
 *
 * A page held after a failed rewrite (lib/page-hold.ts: page_type
 * 'archived', restore_page_type set) counts as the type it returns as, after
 * any live page: it keeps its title, and the plan leaves it alone instead of
 * making a second page with that title.
 */
export function getTopicPageByTitle(title: string): PageRow | null {
  const row = openDb()
    .prepare(
      `SELECT ${PLAN_PAGE_COLUMNS}
         FROM pages p
        WHERE p.title = ? COLLATE NOCASE
          AND (CASE WHEN p.page_type = 'archived' THEN p.restore_page_type ELSE p.page_type END)
              IN ('entity', 'concept', 'comparison', 'overview')
        ORDER BY CASE WHEN p.page_type = 'archived' THEN 1 ELSE 0 END,
                 CASE WHEN p.page_type IN ('entity', 'concept') OR p.restore_page_type IN ('entity', 'concept') THEN 0 ELSE 1 END,
                 p.created_at, p.page_id
        LIMIT 1`
    )
    .get(title) as PageRow | undefined;
  return row ?? null;
}

/**
 * Is a draft waiting for approval (auto-approve off) going to create a page
 * with this title, of one of `pageTypes`? The plan step plans no second
 * "create" of such a page while one waits (plan 1.8): approving both made
 * two pages.
 */
export function hasPendingCreate(title: string, pageTypes: readonly string[]): boolean {
  if (pageTypes.length === 0) return false;
  const types = pageTypes.map(() => '?').join(', ');
  return (
    openDb()
      .prepare(
        `SELECT 1 FROM page_plans
          WHERE draft_status = 'pending_approval' AND action = 'create'
            AND title = ? COLLATE NOCASE AND page_type IN (${types})
          LIMIT 1`
      )
      .get(title, ...pageTypes) !== undefined
  );
}

/**
 * Titles the resolver matches session names against: entity and concept
 * pages, plus the new entity and concept pages drafts waiting for approval
 * will create, so a name binds to such a page as it would once approved
 * (plan 1.8). Each with its summary (none yet for a waiting draft), which
 * Layer 2 compares names with by meaning. Sorted like
 * getEntityAndConceptPageTitles.
 */
export function getResolverPageTitles(): Array<{ title: string; page_type: string; summary: string | null }> {
  return openDb()
    .prepare(
      `SELECT title, page_type, NULLIF(TRIM(summary), '') AS summary FROM pages
        WHERE page_type IN ('entity', 'concept')
       UNION
       SELECT title, page_type, NULL FROM page_plans
        WHERE draft_status = 'pending_approval' AND action = 'create'
          AND page_type IN ('entity', 'concept')
       ORDER BY title, page_type`
    )
    .all() as Array<{ title: string; page_type: string; summary: string | null }>;
}

/**
 * The entity and concept pages with these titles (any case) and their
 * summaries, for what Layer 3 reads about a pair side bound to a page
 * (lib/resolve-page-sides.ts). A title can name an entity and a concept
 * page; both rows come back.
 */
export function getResolverPageSummaries(
  titles: string[]
): Array<{ title: string; page_type: string; summary: string | null }> {
  const stmt = openDb().prepare(
    `SELECT title, page_type, summary FROM pages
      WHERE title = ? COLLATE NOCASE AND page_type IN ('entity', 'concept')
      ORDER BY page_type`
  );
  return [...new Set(titles)].flatMap(
    (t) => stmt.all(t) as Array<{ title: string; page_type: string; summary: string | null }>
  );
}

/** Each source's stored kind for a canonical name: entity_mentions.entity_type ('CONCEPT' for concepts). */
export function getMentionKinds(canonicalName: string): Array<{ source_id: string; entity_type: string | null }> {
  return openDb()
    .prepare(`SELECT source_id, entity_type FROM entity_mentions WHERE canonical_name = ? ORDER BY source_id`)
    .all(canonicalName) as Array<{ source_id: string; entity_type: string | null }>;
}

/**
 * Sets compile_status = 'active' for sources that completed the session pipeline.
 * Called by commitSession after all page plans have been committed.
 */
export function markSourcesActive(sourceIds: string[]): void {
  if (sourceIds.length === 0) return;
  const placeholders = sourceIds.map(() => '?').join(', ');
  openDb()
    .prepare(
      `UPDATE sources SET compile_status = 'active'
        WHERE source_id IN (${placeholders})
          AND compile_status != 'failed'`
    )
    .run(...sourceIds);
}

// ============================================================================
// Compile progress helpers (Part 2c-ii)
// ============================================================================

const DEFAULT_STEPS = () =>
  Object.fromEntries(COMPILE_STEP_KEYS.map((s) => [s, { status: 'pending' }]));

export interface CompileProgressRow {
  session_id: string;
  status: string;
  current_step: string | null;
  steps: string; // JSON TEXT — parse to get step states
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  // v20: per-session compile_model lock. Nullable — pre-v20 rows stay NULL
  // and fall back to getCompileModel() at each step.
  compile_model: string | null;
}

/**
 * Insert a compile_progress row for a session, or reset it if one already
 * exists (for retry). All steps start as 'pending', status as 'queued'.
 *
 * v20: accepts optional compileModel to stamp the session's model lock on
 * creation. On conflict (retry), DO NOT overwrite the original compile_model —
 * a retry should keep the session's original model. If the caller passes
 * compileModel and the row exists with NULL (legacy session pre-v20), the
 * existing NULL is preserved; callers fall back to getCompileModel() for
 * legacy rows.
 */
export function createCompileProgress(
  sessionId: string,
  sourceCount = 0,
  compileModel: string | null = null,
): void {
  openDb()
    .prepare(
      `INSERT INTO compile_progress
         (session_id, status, current_step, steps, error, started_at, completed_at, source_count, compile_model)
       VALUES (?, 'queued', NULL, ?, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         status       = 'queued',
         current_step = NULL,
         steps        = excluded.steps,
         error        = NULL,
         started_at   = NULL,
         completed_at = NULL,
         source_count = CASE WHEN excluded.source_count > 0 THEN excluded.source_count ELSE compile_progress.source_count END`
    )
    .run(sessionId, JSON.stringify(DEFAULT_STEPS()), sourceCount, compileModel);
}

/**
 * Read the compile_model that was stamped on this session's compile_progress
 * row when it was first created. Returns null for legacy sessions (pre-v20)
 * or sessions created before the caller started passing compile_model to
 * createCompileProgress. Callers should fall back to getCompileModel() on
 * null so legacy sessions keep working.
 *
 * Read the stamp if present, fall back to the current Settings value
 * otherwise.
 */
export function getSessionCompileModel(sessionId: string): string | null {
  const row = openDb()
    .prepare(`SELECT compile_model FROM compile_progress WHERE session_id = ?`)
    .get(sessionId) as { compile_model: string | null } | undefined;
  return row?.compile_model ?? null;
}

/**
 * Resolve the Gemini model for a compile-step call. Every per-session LLM
 * call should use this instead of raw getCompileModel(): it prefers the
 * session's locked model (if one was stamped at finalize time) and falls
 * back to the current Settings value for legacy sessions or one-off
 * non-session calls.
 *
 * Accepts null/undefined for sessionId so non-session call sites (lint,
 * digest, recompile) can pass through without branching.
 */
export function getEffectiveCompileModel(
  sessionId: string | null | undefined,
): LlmModel {
  if (!sessionId) return getCompileModel();
  const locked = getSessionCompileModel(sessionId);
  return isLlmModel(locked) ? locked : getCompileModel();
}

/**
 * Update a single step's status and optional detail string.
 * Side effects:
 *   - When the first step goes 'running': set overall status='running' + started_at
 *   - When a step goes 'failed': set overall status='failed' + error=detail
 *   - Always update current_step to the given step name.
 */
export function updateCompileStep(
  sessionId: string,
  step: CompileStepKey,
  status: 'running' | 'done' | 'failed',
  detail?: string
): void {
  const db = openDb();
  const row = db
    .prepare('SELECT status, steps FROM compile_progress WHERE session_id = ?')
    .get(sessionId) as Pick<CompileProgressRow, 'status' | 'steps'> | undefined;
  if (!row) return;

  const steps = JSON.parse(row.steps) as Record<string, { status: string; detail?: string }>;
  steps[step] = detail !== undefined ? { status, detail } : { status };

  let overallStatus = row.status;
  let setStartedAt = '';
  // In-flight workers may still report step progress after cancel; never
  // resurrect the session gate (queued → running) from a cancelled row.
  if (row.status !== 'cancelled') {
    if (status === 'running' && row.status === 'queued') {
      overallStatus = 'running';
      setStartedAt = ", started_at = CURRENT_TIMESTAMP";
    }
    if (status === 'failed') {
      overallStatus = 'failed';
    }
  }

  db.prepare(
    `UPDATE compile_progress
        SET steps        = ?,
            current_step = ?,
            status       = ?,
            error        = CASE WHEN ? = 'failed' THEN ? ELSE error END
            ${setStartedAt}
      WHERE session_id   = ?`
  ).run(
    JSON.stringify(steps),
    step,
    overallStatus,
    status,
    detail ?? null,
    sessionId
  );
}

/** Mark the session compile as fully completed. */
export function completeCompileProgress(sessionId: string): void {
  openDb()
    .prepare(
      `UPDATE compile_progress
          SET status = 'completed', completed_at = CURRENT_TIMESTAMP
        WHERE session_id = ?`
    )
    .run(sessionId);
}

/** Mark the session compile as failed with an error message. */
export function failCompileProgress(sessionId: string, error: string): void {
  openDb()
    .prepare(
      `UPDATE compile_progress
          SET status = 'failed', error = ?
        WHERE session_id = ?`
    )
    .run(error, sessionId);
}

/** Mark the session compile as cancelled by the user. */
export function cancelCompileProgress(sessionId: string, reason: string): void {
  openDb()
    .prepare(
      `UPDATE compile_progress
          SET status = 'cancelled', error = ?, completed_at = CURRENT_TIMESTAMP
        WHERE session_id = ?`
    )
    .run(reason, sessionId);
}

/**
 * Cancel never-started queued sessions for other session_ids.
 *
 * Orphan rows are left when /api/onboarding/finalize created compile_progress
 * but the n8n trigger failed (row stays queued, started_at NULL). They hold
 * the global concurrency gate until the user manually cancels — blocking a
 * new onboarding run with "Another compile session is already running."
 */
export function supersedeOrphanQueuedSessions(exceptSessionId: string): number {
  const result = openDb()
    .prepare(
      `UPDATE compile_progress
          SET status = 'cancelled',
              error = 'Superseded by new compile session',
              completed_at = CURRENT_TIMESTAMP
        WHERE session_id != ?
          AND status = 'queued'
          AND started_at IS NULL`
    )
    .run(exceptSessionId);
  return result.changes as number;
}

/**
 * Mark stale 'running' sessions as failed using a per-session adaptive
 * threshold: 60 min floor + 6 min per source.
 *
 * Sized for DeepSeek (extract 200-400s/source, draft ~3 min/page); generous
 * for Gemini. Each session's threshold scales with its own size:
 *
 *   1 source       → 60 min  (floor)
 *   10 sources     → 60 min  (floor)
 *   30 sources     → 180 min
 *   100 sources    → 600 min (10h)
 *   500 sources    → 3000 min (50h)
 *
 * A flat cap (the prior shape — `markStaleSessionsFailed(30)` from the
 * health probe) killed legit DeepSeek sessions at 6 sources mid-pipeline.
 * A flat cap also makes no sense for the user with 1800 sources who needs
 * a multi-day session — they batch, but each batch can still be 100+
 * sources and run for hours.
 *
 * Implementation note: per-row threshold can't be expressed as a single
 * SQL UPDATE because the threshold depends on a JOIN-derived count.
 * Two-step (SELECT running rows + their source counts → UPDATE the ones
 * that exceed their personal threshold) is what we want.
 *
 * Called on every health probe AND when /api/compile/run starts a new
 * pipeline — both fine because the operation is idempotent (only marks
 * sessions that have actually exceeded their per-session cap).
 *
 * Uses datetime() wrapper on both sides per the SQLite timestamp comparison
 * gotcha (CLAUDE.md memory: feedback_sqlite_gotchas).
 *
 * Returns the number of rows cleaned up.
 */
export function markStaleSessionsFailed(): number {
  const db = openDb();
  // started_at IS NULL means 'queued' (never picked up by n8n) — those are
  // handled by reconcileStuckCompileSessions, not here.
  const candidates = db
    .prepare(
      `SELECT cp.session_id,
              cp.started_at,
              (SELECT COUNT(*)
                 FROM sources s
                WHERE s.onboarding_session_id = cp.session_id) AS source_count,
              CAST((julianday('now') - julianday(cp.started_at)) * 24 * 60 AS INTEGER) AS elapsed_min
         FROM compile_progress cp
        WHERE cp.status = 'running'
          AND cp.started_at IS NOT NULL`
    )
    .all() as Array<{
      session_id: string;
      started_at: string;
      source_count: number;
      elapsed_min: number;
    }>;

  if (candidates.length === 0) return 0;

  const updateStmt = db.prepare(
    `UPDATE compile_progress
        SET status = 'failed',
            error  = ?
      WHERE session_id = ?
        AND status = 'running'`
  );

  let cleaned = 0;
  for (const row of candidates) {
    const threshold = Math.max(60, row.source_count * 6);
    if (row.elapsed_min > threshold) {
      const result = updateStmt.run(
        `Pipeline interrupted — session of ${row.source_count} sources exceeded ${threshold} min limit. Click Retry to rerun.`,
        row.session_id,
      );
      cleaned += result.changes as number;
    }
  }
  return cleaned;
}

export type CompileRunClaim =
  | { claimed: true; restarted: boolean }
  | { claimed: false; reason: 'no_progress_record' | 'already_completed' | 'session_cancelled' | 'already_running' };

/**
 * The run gate of POST /api/compile/run: claim the session's row for a new
 * pipeline, in one transaction.
 *
 *   - missing, completed or cancelled → refused;
 *   - running within its time limit   → refused (already_running);
 *   - running past its time limit (markStaleSessionsFailed) → claimed again:
 *     a restart;
 *   - queued, failed (or any other)   → claimed.
 *
 * A claim sets status 'running' and a fresh started_at at once. A restarted
 * run therefore counts for getRunningCompileSession straight away, with a new
 * time limit; left 'failed', or 'running' with the old started_at, it would
 * let another session start alongside it.
 */
export function claimCompileRun(sessionId: string): CompileRunClaim {
  const db = openDb();
  return db.transaction((): CompileRunClaim => {
    const row = getCompileProgress(sessionId);
    if (!row) return { claimed: false, reason: 'no_progress_record' };
    if (row.status === 'completed') return { claimed: false, reason: 'already_completed' };
    if (row.status === 'cancelled') return { claimed: false, reason: 'session_cancelled' };

    const restarted = row.status === 'running';
    if (restarted) {
      markStaleSessionsFailed();
      if (getCompileProgress(sessionId)?.status === 'running') {
        return { claimed: false, reason: 'already_running' };
      }
    }

    db.prepare(
      `UPDATE compile_progress
          SET status       = 'running',
              started_at   = CURRENT_TIMESTAMP,
              error        = NULL,
              completed_at = NULL
        WHERE session_id   = ?`
    ).run(sessionId);
    return { claimed: true, restarted };
  })();
}

/**
 * Return the single fresh queued/running compile session, or null.
 *
 * Used as the global "is any compile active right now?" gate — every route
 * that starts or re-fires a pipeline checks this before creating a new
 * compile_progress row, and the dashboard uses it to disable "Add Sources"
 * at render time.
 *
 * Staleness filter:
 *   - queued rows (started_at IS NULL) are always considered active
 *   - running rows stay active until they exceed the same adaptive timeout as
 *     markStaleSessionsFailed(): max(60, source_count * 6) minutes
 *
 * That keeps the global concurrency gate aligned with the stale-session
 * cleanup. Otherwise a legit long-running session could disappear from the
 * gate after a flat 180 minutes and incorrectly allow a second compile to
 * start in parallel.
 *
 * Queued rows with started_at=NULL (created by createCompileProgress, not
 * yet picked up by n8n) are included — they are fresh-by-definition.
 *
 * Atomicity: callers follow `check getRunningCompileSession() →
 * createCompileProgress()` without a wrapping transaction. This is deliberate
 * and correct — Node.js is single-threaded and better-sqlite3 is synchronous,
 * so the check-to-insert window contains no `await` and cannot be interleaved
 * by another request for a DIFFERENT session_id. Do NOT wrap this pattern in
 * a transaction to "fix" the perceived TOCTOU — it isn't a TOCTOU, and adding
 * a write-lock would serialize unrelated request handling.
 *
 * Same-session double-submit (two POSTs with identical session_id) is NOT
 * prevented here — the guard deliberately passes through to support
 * legitimate retries. Caller sites own idempotency for that case.
 */
export function getRunningCompileSession(): {
  session_id: string;
  started_at: string | null;
  source_count: number;
} | null {
  const row = openDb()
    .prepare(
      `SELECT cp.session_id, cp.started_at, cp.source_count
         FROM compile_progress cp
        WHERE cp.status = 'queued'
           OR (
                cp.status = 'running'
            AND cp.started_at IS NOT NULL
            AND CAST((julianday('now') - julianday(cp.started_at)) * 24 * 60 AS INTEGER)
                <= MAX(
                     60,
                     (SELECT COUNT(*)
                        FROM sources s
                       WHERE s.onboarding_session_id = cp.session_id) * 6
                   )
              )
        ORDER BY COALESCE(started_at, created_at) DESC
        LIMIT 1`
    )
    .get() as { session_id: string; started_at: string | null; source_count: number } | undefined;
  return row ?? null;
}

/**
 * Mark 'queued' sessions that never got picked up by n8n as failed.
 * Runs on every health probe alongside markStaleSessionsFailed. Covers the
 * case where /api/onboarding/finalize created the row but the n8n webhook
 * POST dropped (process killed, n8n unreachable, silent 404 pre-fix).
 *
 * Writes a compile_failed activity row for each reconciled session so the
 * user sees "why" on the dashboard feed.
 *
 * Returns the number of rows reconciled.
 */
export function reconcileStuckCompileSessions(olderThanMinutes: number): number {
  const db = openDb();
  const stuckRows = db
    .prepare(
      `SELECT session_id FROM compile_progress
        WHERE status = 'queued'
          AND datetime(created_at) < datetime('now', ? || ' minutes')`
    )
    .all(`-${olderThanMinutes}`) as Array<{ session_id: string }>;

  if (stuckRows.length === 0) return 0;

  const ERROR_MSG =
    `Compile did not start — background worker was unreachable after ${olderThanMinutes} min. Click Retry.`;

  const tx = db.transaction(() => {
    const update = db.prepare(
      `UPDATE compile_progress
          SET status = 'failed', error = ?
        WHERE session_id = ? AND status = 'queued'`
    );
    // activity_log column is `timestamp`, not `created_at`; it has a
    // CURRENT_TIMESTAMP default so we omit it from the INSERT entirely.
    const activity = db.prepare(
      `INSERT INTO activity_log (action_type, source_id, details)
       VALUES ('compile_failed', NULL, ?)`
    );
    for (const row of stuckRows) {
      update.run(ERROR_MSG, row.session_id);
      activity.run(JSON.stringify({ session_id: row.session_id, reason: 'never_started' }));
    }
  });
  tx();
  return stuckRows.length;
}

/**
 * Reset compile_progress for a retry, preserving completed steps.
 * Only resets from the first non-done step onwards — completed expensive
 * steps (extract, draft) keep their 'done' status so runCompilePipeline
 * can skip them. Clears error and resets status to 'queued'.
 *
 * If all steps are already done, this is a no-op.
 */
export function resetForRetry(sessionId: string): void {
  const progress = getCompileProgress(sessionId);
  if (!progress) return;

  const steps = JSON.parse(progress.steps) as Record<string, { status: string; detail?: string }>;

  // Find the first non-done step
  let resetFrom = -1;
  for (let i = 0; i < COMPILE_STEP_KEYS.length; i++) {
    if (steps[COMPILE_STEP_KEYS[i]]?.status !== 'done') {
      resetFrom = i;
      break;
    }
  }

  if (resetFrom === -1) return; // all steps done — nothing to retry

  // Reset from the first non-done step forward
  for (let i = resetFrom; i < COMPILE_STEP_KEYS.length; i++) {
    steps[COMPILE_STEP_KEYS[i]] = { status: 'pending' };
  }

  openDb()
    .prepare(
      `UPDATE compile_progress
          SET status       = 'queued',
              current_step = NULL,
              error        = NULL,
              completed_at = NULL,
              steps        = ?
        WHERE session_id   = ?`
    )
    .run(JSON.stringify(steps), sessionId);
}

/** Fetch the progress record for a session. Returns null if not found. */
export function getCompileProgress(sessionId: string): CompileProgressRow | null {
  const row = openDb()
    .prepare(
      `SELECT session_id, status, current_step, steps, error,
              started_at, completed_at, created_at
         FROM compile_progress WHERE session_id = ?`
    )
    .get(sessionId) as CompileProgressRow | undefined;
  return row ?? null;
}

export interface CompileSessionSummary {
  session_id: string;
  status: string;
  current_step: string | null;
  source_count: number;
  done_count: number;
  total_steps: number;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

/**
 * List compile sessions newest-first for the /sessions page.
 * Ordered by the most recent activity timestamp (completed_at || started_at || created_at).
 */
export function listCompileSessions(limit: number, offset: number): { items: CompileSessionSummary[]; total: number } {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT session_id, status, current_step, source_count, steps,
              error, started_at, completed_at, created_at
         FROM compile_progress
        ORDER BY COALESCE(completed_at, started_at, created_at) DESC
        LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as Array<{
      session_id: string;
      status: string;
      current_step: string | null;
      source_count: number;
      steps: string;
      error: string | null;
      started_at: string | null;
      completed_at: string | null;
      created_at: string;
    }>;

  const total = (db.prepare('SELECT COUNT(*) AS c FROM compile_progress').get() as { c: number }).c;

  const items: CompileSessionSummary[] = rows.map((r) => {
    let doneCount = 0;
    let totalSteps = 0;
    try {
      const steps = JSON.parse(r.steps) as Record<string, { status: string }>;
      totalSteps = Object.keys(steps).length;
      doneCount = Object.values(steps).filter((s) => s.status === 'done').length;
    } catch { /* malformed steps — leave counts at 0 */ }
    return {
      session_id: r.session_id,
      status: r.status,
      current_step: r.current_step,
      source_count: r.source_count,
      done_count: doneCount,
      total_steps: totalSteps,
      error: r.error,
      started_at: r.started_at,
      completed_at: r.completed_at,
      created_at: r.created_at,
    };
  });

  return { items, total };
}

/**
 * Fetch all sources for a session that still need compilation
 * (compile_status NOT IN ('active', 'compiled')). Used by /api/compile/run
 * to determine which sources to extract. 'active' is the current terminal
 * state; 'compiled' is a retired legacy terminal state retained here so that
 * pre-existing rows are not re-processed.
 */
export function getSourcesBySession(sessionId: string): SourceRow[] {
  return openDb()
    .prepare(
      `SELECT source_id, title, source_type, source_url, content_hash,
              file_path, status, date_ingested, metadata, compile_status,
              compile_attempts, onboarding_session_id
         FROM sources
        WHERE onboarding_session_id = ?
          AND compile_status NOT IN ('active', 'compiled')
        ORDER BY date_ingested ASC`
    )
    .all(sessionId) as SourceRow[];
}

// ============================================================================
// Page helpers added for Part 2d (wiki-aware updates)
// ============================================================================

/**
 * Return all pages whose page_type is in the given list.
 * Used by /api/compile/match to build the TF-IDF candidate corpus.
 */
export function getPagesByType(types: string[]): PageRow[] {
  if (types.length === 0) return [];
  const placeholders = types.map(() => '?').join(', ');
  return openDb()
    .prepare(
      `SELECT page_id, title, page_type, category, summary, content_path,
              previous_content_path, last_updated, source_count, created_at
         FROM pages
        WHERE page_type IN (${placeholders})
        ORDER BY last_updated DESC`
    )
    .all(...types) as PageRow[];
}

/**
 * Recount a page's source_count from provenance, the ground truth. Distinct
 * sources: provenance may hold several rows for one source and page (a
 * 'created' and later 'updated' rows).
 */
export function recountPageSources(pageId: string): void {
  openDb()
    .prepare(
      `UPDATE pages SET source_count = (
         SELECT COUNT(DISTINCT source_id) FROM provenance WHERE page_id = ?
       ) WHERE page_id = ?`
    )
    .run(pageId, pageId);
}

/**
 * Link sources to a page without changing its text (a provenance-only plan:
 * match triage found the source adds nothing to the page). Each source not
 * yet recorded on the page gets one 'mentioned' row; a source already on it,
 * whatever its rows say, gets none, so a retry or a later 'skip' verdict
 * never adds a duplicate. Then recounts source_count. Returns the rows added.
 * Sync, no file I/O: runs inside the commit transaction.
 */
export function linkSourcesToPage(pageId: string, sourceIds: string[], contentHash: string): number {
  const db = openDb();
  const linked = db.prepare('SELECT 1 FROM provenance WHERE page_id = ? AND source_id = ? LIMIT 1');
  let added = 0;
  for (const source_id of new Set(sourceIds)) {
    if (linked.get(pageId, source_id)) continue;
    insertProvenance({ source_id, page_id: pageId, content_hash: contentHash, contribution_type: 'mentioned' });
    added++;
  }
  recountPageSources(pageId);
  return added;
}

/**
 * Validate a previous_content_path value against the only shape
 * file_store.py ever writes: {PAGES_DIR}/{page_id}.{YYYYMMDD-HHMMSS}[-usec].md.gz
 * for THIS page_id. The column round-trips through export/import zips, so
 * it is untrusted — a crafted zip could point it at /data/db/kompl.db or
 * any host file and the previous-version route would happily gunzip it.
 * Returns the resolved path when valid, null otherwise.
 */
export function safePreviousContentPath(pageId: string, p: string | null): string | null {
  if (!p || !isSafeId(pageId)) return null;
  const resolved = path.resolve(p);
  if (path.dirname(resolved) !== path.resolve(PAGES_DIR)) return null;
  // pageId is a safe id ([a-z0-9_-]) — no regex metacharacters to escape.
  const archiveRe = new RegExp(`^${pageId}\\.\\d{8}-\\d{6}(?:-\\d{6})?\\.md\\.gz$`);
  return archiveRe.test(path.basename(resolved)) ? resolved : null;
}

/**
 * SHA-256 of the page's decompressed markdown — same basis as commit/route.ts
 * content_hash. Uses readPageMarkdown (file + pending_content fallback).
 * Returns '' when no content exists (first-write / provenance-only path).
 * Sync filesystem read; call outside db.transaction().
 */
export function getCurrentPageHash(pageId: string): string {
  const markdown = readPageMarkdown(pageId);
  if (!markdown) return '';
  return createHash('sha256').update(markdown).digest('hex');
}

// ============================================================================
// Source management helpers (commit 8)
// ============================================================================

/**
 * Fetch all sources with optional filtering, sorting and pagination. Every
 * source unless `limit` is given: the backup and JSON exports read the whole
 * list (a default of 200 once cut larger wikis' backups short).
 */
export function getAllSources(options?: {
  status?: string;
  source_type?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  sort_by?: 'date_ingested' | 'title' | 'source_type';
  sort_order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}): SourceRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.status) {
    conditions.push('status = ?');
    params.push(options.status);
  }
  if (options?.source_type) {
    conditions.push('source_type = ?');
    params.push(options.source_type);
  }
  if (options?.dateFrom) {
    conditions.push('date_ingested >= ?');
    params.push(options.dateFrom);
  }
  if (options?.dateTo) {
    conditions.push('date_ingested <= ?');
    // If caller passed a full ISO timestamp, use it verbatim; else expand date-only to end-of-day.
    params.push(options.dateTo.includes('T') ? options.dateTo : options.dateTo + 'T23:59:59');
  }
  if (options?.search) {
    conditions.push('title LIKE ?');
    params.push(`%${options.search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  // Runtime allowlist guards against SQL injection — TypeScript types are compile-time only.
  const SORT_COLS: Record<string, string> = {
    date_ingested: 'date_ingested',
    title: 'title',
    source_type: 'source_type',
  };
  const SORT_DIRS: Record<string, string> = { asc: 'ASC', desc: 'DESC' };
  const sortCol = SORT_COLS[options?.sort_by ?? 'date_ingested'] ?? 'date_ingested';
  const sortDir = SORT_DIRS[options?.sort_order ?? 'desc'] ?? 'DESC';
  const limit = options?.limit ?? -1; // SQLite: LIMIT -1 is no limit
  const offset = options?.offset ?? 0;

  return openDb()
    .prepare(
      `SELECT source_id, title, source_type, source_url, content_hash,
              file_path, status, date_ingested, metadata, compile_status,
              compile_attempts, compile_next_eligible_at, onboarding_session_id,
              title_source, title_rescued_at,
              published_at, published_at_source
         FROM sources
         ${where}
         ORDER BY ${sortCol} ${sortDir}
         LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as SourceRow[];
}

export interface SourceWithPageCount extends SourceRow {
  page_count: number;
}

/**
 * Build the shared WHERE clause for sources list + count queries. Extracted so
 * getAllSourcesWithPageCounts and countSourcesWithPageCounts stay in lockstep —
 * a filter added to one without the other makes `total` silently wrong.
 */
function buildSourcesWhereSql(
  options?: Parameters<typeof getAllSources>[0]
): { where: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (options?.status) {
    conditions.push('s.status = ?');
    params.push(options.status);
  }
  if (options?.source_type) {
    conditions.push('s.source_type = ?');
    params.push(options.source_type);
  }
  if (options?.dateFrom) {
    conditions.push('s.date_ingested >= ?');
    params.push(options.dateFrom);
  }
  if (options?.dateTo) {
    conditions.push('s.date_ingested <= ?');
    params.push(options.dateTo.includes('T') ? options.dateTo : options.dateTo + 'T23:59:59');
  }
  if (options?.search) {
    // Title or address, so "did example.com make it in?" can be answered.
    // % and _ in the search text are matched literally, not as wildcards.
    const pattern = `%${options.search.replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(`(s.title LIKE ? ESCAPE '\\' OR s.source_url LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/**
 * Same as getAllSources but LEFT JOINs provenance to include page_count per source
 * in a single query, eliminating the N+1 pattern in GET /api/sources.
 */
export function getAllSourcesWithPageCounts(
  options?: Parameters<typeof getAllSources>[0]
): SourceWithPageCount[] {
  const { where, params } = buildSourcesWhereSql(options);

  const SORT_COLS: Record<string, string> = {
    date_ingested: 's.date_ingested',
    title: 's.title',
    source_type: 's.source_type',
  };
  const SORT_DIRS: Record<string, string> = { asc: 'ASC', desc: 'DESC' };
  const sortCol = SORT_COLS[options?.sort_by ?? 'date_ingested'] ?? 's.date_ingested';
  const sortDir = SORT_DIRS[options?.sort_order ?? 'desc'] ?? 'DESC';
  const limit = options?.limit ?? 200;
  const offset = options?.offset ?? 0;

  return openDb()
    .prepare(
      `SELECT s.source_id, s.title, s.source_type, s.source_url, s.content_hash,
              s.file_path, s.status, s.date_ingested, s.metadata, s.compile_status,
              s.compile_attempts, s.onboarding_session_id,
              COUNT(DISTINCT p.page_id) AS page_count
         FROM sources s
         LEFT JOIN provenance p ON p.source_id = s.source_id
         ${where}
         GROUP BY s.source_id
         ORDER BY ${sortCol} ${sortDir}
         LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as SourceWithPageCount[];
}

/**
 * Count of sources matching the given filter — ignores limit/offset/sort.
 * Used to populate the `total` field in GET /api/sources so the UI banner
 * reports the full filtered count, not the post-limit row count.
 */
export function countSourcesWithPageCounts(
  options?: Parameters<typeof getAllSources>[0]
): number {
  const { where, params } = buildSourcesWhereSql(options);
  const row = openDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM sources s ${where}`
    )
    .get(...params) as { n: number };
  return row.n;
}

/**
 * Return all pages that a given source contributed to (via provenance).
 * Used by the source detail page's provenance map section.
 */
export function getSourceProvenanceMap(sourceId: string): Array<{
  page_id: string;
  title: string;
  page_type: string;
  contribution_type: string;
  date_compiled: string;
}> {
  return openDb()
    .prepare(
      `SELECT p.page_id, p.title, p.page_type,
              pr.contribution_type, pr.date_compiled
         FROM provenance pr
         JOIN pages p ON p.page_id = pr.page_id
        WHERE pr.source_id = ?
        ORDER BY pr.date_compiled DESC`
    )
    .all(sourceId) as Array<{
      page_id: string;
      title: string;
      page_type: string;
      contribution_type: string;
      date_compiled: string;
    }>;
}

/**
 * Return pages that have at least one provenance link from the given source,
 * each once. Used by cascade delete to determine which pages are affected:
 * a source can hold several rows on one page ('mentioned' next to 'updated'),
 * and the delete must rewrite such a page once, not once per row.
 */
export function getPagesBySourceId(sourceId: string): Array<{
  page_id: string;
  title: string;
  source_count: number;
}> {
  return openDb()
    .prepare(
      `SELECT DISTINCT p.page_id, p.title, p.source_count
         FROM pages p
         JOIN provenance pr ON p.page_id = pr.page_id
        WHERE pr.source_id = ?`
    )
    .all(sourceId) as Array<{ page_id: string; title: string; source_count: number }>;
}

/**
 * Remove one source's provenance rows from one page. A source delete calls
 * it as it handles each page, so the pages it has not reached yet still
 * name the source if it stops halfway (lib/source-delete.ts).
 */
export function removeSourceFromPage(pageId: string, sourceId: string): void {
  openDb()
    .prepare('DELETE FROM provenance WHERE page_id = ? AND source_id = ?')
    .run(pageId, sourceId);
}

/**
 * Remove all provenance rows for a given source_id.
 * Called as part of source cascade delete.
 */
export function removeProvenanceForSource(sourceId: string): void {
  openDb()
    .prepare('DELETE FROM provenance WHERE source_id = ?')
    .run(sourceId);
}

/**
 * Legacy data hygiene: the in-app chat (since retired) could save answers as
 * pending_approval drafts, and installs may still hold some. Nothing creates
 * new ones, but this cleanup stays so those drafts can never be approved into
 * pages with broken [[wikilinks]].
 *
 * Strip a deleted page_id from every chat-save-draft's source_ids array
 * (chat drafts store cited page_ids in source_ids — known semantic quirk),
 * then drop any chat draft whose source_ids becomes empty. Run inside the
 * deletePage transaction so a deleted page can never be cited by a draft
 * that's later approved into a new page with broken [[wikilinks]].
 *
 * Mirrors cleanupPendingPlansForDeletedSource — same UPDATE-then-DELETE
 * pattern, restricted to chat sessions via session_id LIKE 'chat-%'.
 *
 * Compile-stage page_plans are NOT touched here: they store source UUIDs,
 * not page_ids, so the value compare would never match a real page_id even
 * if the LIKE filter were removed. The filter just makes intent explicit.
 *
 * Returns counts so deletePage's caller can emit a chat_drafts_cleaned
 * activity event when applicable.
 */
export function cleanupChatDraftsForDeletedPage(
  pageId: string,
): { rewritten: number; deleted: number } {
  const db = openDb();
  const rewritten = db
    .prepare(
      `UPDATE page_plans
          SET source_ids = (SELECT COALESCE(json_group_array(value), '[]')
                              FROM json_each(source_ids)
                             WHERE value != ?)
        WHERE draft_status = 'pending_approval'
          AND session_id LIKE 'chat-%'
          AND EXISTS (SELECT 1 FROM json_each(source_ids) WHERE value = ?)`
    )
    .run(pageId, pageId).changes;
  const deleted = db
    .prepare(
      `DELETE FROM page_plans
        WHERE draft_status = 'pending_approval'
          AND session_id LIKE 'chat-%'
          AND source_ids = '[]'`
    )
    .run().changes;
  return { rewritten, deleted };
}

/**
 * Find pages whose backing sources have all been deleted from the `sources` table.
 * A page is a "zombie" when:
 *   - it has no provenance rows at all (sources removed without proper cascade), OR
 *   - every provenance row points to a source_id that no longer exists in sources
 *
 * The 'saved-links' system page is exempt (it's user-curated, not source-derived).
 *
 * Used by /api/admin/cleanup/zombie-pages to recover from prior delete-cascade
 * gaps (e.g. plans that were committed after their backing sources were deleted).
 */
export function findZombiePages(): Array<{ page_id: string; title: string; page_type: string; source_count: number }> {
  return openDb()
    .prepare(
      `SELECT p.page_id, p.title, p.page_type, p.source_count
         FROM pages p
        WHERE p.page_id != 'saved-links'
          AND NOT EXISTS (
            SELECT 1 FROM provenance pr
             JOIN sources s ON s.source_id = pr.source_id
            WHERE pr.page_id = p.page_id
          )`
    )
    .all() as Array<{ page_id: string; title: string; page_type: string; source_count: number }>;
}

/**
 * Strip a deleted source_id from every pending_approval plan's source_ids array,
 * then drop any plan whose source_ids becomes empty. Run when a source is deleted
 * so leftover compile drafts can't later be approved and resurrect the deleted
 * source's pages (zombie resurrection via commitSinglePlan UPSERT).
 *
 * Multi-source entity plans (e.g. an "AI agents" page from 5 sources) survive
 * single-source deletion — their source_ids array shrinks instead of vanishing —
 * so user-curated drafts aren't lost when one of many sources is removed.
 *
 * Chat-save-draft plans (session_id LIKE 'chat-%') are unaffected: their
 * source_ids column actually stores page_ids (a known semantic quirk), so the
 * UUID compare against a real source_id never matches. Cleaning chat drafts on
 * page deletion is a separate concern (different code path, different fix).
 *
 * Returns counts so the caller can decide whether to emit an activity event.
 */
export function cleanupPendingPlansForDeletedSource(
  sourceId: string,
): { rewritten: number; deleted: number } {
  const db = openDb();
  return db.transaction(() => {
    const rewritten = db
      .prepare(
        `UPDATE page_plans
            SET source_ids = (SELECT COALESCE(json_group_array(value), '[]')
                                FROM json_each(source_ids)
                               WHERE value != ?)
          WHERE draft_status = 'pending_approval'
            AND EXISTS (SELECT 1 FROM json_each(source_ids) WHERE value = ?)`
      )
      .run(sourceId, sourceId).changes;
    const deleted = db
      .prepare(
        `DELETE FROM page_plans
          WHERE draft_status = 'pending_approval' AND source_ids = '[]'`
      )
      .run().changes;
    return { rewritten, deleted };
  })();
}

/**
 * Drop the ids of deleted sources from a plan about to be committed, and
 * return the ids that remain. A compile can start while a source is being
 * deleted (a delete is refused while a compile runs, not the other way
 * round: lib/source-delete.ts); an id left in the plan fails the provenance
 * foreign key and
 * rolls back the whole page update, new sources included. The shrunk list is
 * written back, so a draft queued for approval stays approvable. A plan left
 * with no sources is deleted, as cleanupPendingPlansForDeletedSource does for
 * queued drafts, so a deleted source's page is never created. Only a plan
 * still 'crossreffed' is touched; one another commit already took is left
 * as it is.
 */
export function pruneDeletedPlanSources(planId: string, sourceIds: string[]): string[] {
  if (sourceIds.length === 0) return sourceIds;
  const db = openDb();
  const existing = new Set(
    (
      db
        .prepare(
          `SELECT j.value AS source_id
             FROM json_each(?) j
             JOIN sources s ON s.source_id = j.value`
        )
        .all(JSON.stringify(sourceIds)) as Array<{ source_id: string }>
    ).map((r) => r.source_id)
  );
  const remaining = sourceIds.filter((id) => existing.has(id));
  if (remaining.length === sourceIds.length) return sourceIds;
  if (remaining.length === 0) {
    db.prepare(`DELETE FROM page_plans WHERE plan_id = ? AND draft_status = 'crossreffed'`).run(planId);
  } else {
    db.prepare(`UPDATE page_plans SET source_ids = ? WHERE plan_id = ? AND draft_status = 'crossreffed'`).run(
      JSON.stringify(remaining),
      planId
    );
  }
  return remaining;
}

/**
 * Return all provenance rows for a given page_id.
 * Used by recompilePage to discover remaining sources after one is deleted.
 */
export function getProvenanceForPage(pageId: string): Array<{ source_id: string; contribution_type: string }> {
  return openDb()
    .prepare('SELECT source_id, contribution_type FROM provenance WHERE page_id = ?')
    .all(pageId) as Array<{ source_id: string; contribution_type: string }>;
}

/**
 * Archive a page (page_type → 'archived') and remove it from the FTS index.
 *
 * Cascade-only: no user-facing "archive this page" UI exists, by design.
 * Kompl follows the Karpathy model — "you never write the wiki yourself; the LLM
 * writes and maintains all of it." Users own sources; pages are a derived view.
 * Giving users a direct archive-page button would also force a whole second UX
 * surface (re-draft on un-archive, provenance reconciliation, orphaned wikilinks,
 * graph-view state) that we don't want to carry.
 *
 * The only caller is recompilePage() when a source delete leaves a page with no
 * remaining provenance. If you're looking for the missing UI — it is intentionally
 * missing.
 *
 * That archive is for good, so it also ends a hold (lib/page-hold.ts): a page
 * with no sources left is never offered back for a rewrite.
 */
export function archivePage(pageId: string): void {
  const db = openDb();
  db.prepare(
    `UPDATE pages SET page_type = 'archived', restore_page_type = NULL, archive_reason = NULL WHERE page_id = ?`
  ).run(pageId);
  db.prepare(`DELETE FROM pages_fts WHERE page_id = ?`).run(pageId);
}

/**
 * Set source_count to an explicit value for a page.
 * Called after a short-source deletion where recompile is skipped.
 */
export function setPageSourceCount(pageId: string, count: number): void {
  openDb()
    .prepare('UPDATE pages SET source_count = ? WHERE page_id = ?')
    .run(Math.max(0, count), pageId);
}

/**
 * Decrement source_count by 1 (minimum 0) for a page.
 * Called when a source is deleted but the page has other sources remaining.
 */
export function decrementPageSourceCount(pageId: string): void {
  openDb()
    .prepare('UPDATE pages SET source_count = CASE WHEN source_count > 0 THEN source_count - 1 ELSE 0 END WHERE page_id = ?')
    .run(pageId);
}

/**
 * Permanently delete a page from the DB (pages, FTS, page_links, aliases, provenance,
 * orphaned pending_approval plans). Wrapped in a transaction so all child-table
 * cleanups are atomic — if any step fails, no partial state is left. Deletion order
 * respects FK constraints: page_links + pages_fts first (no FK to pages), then
 * aliases + provenance + orphaned plans (both REFERENCE pages), then the pages row.
 *
 * Pending plans cleanup: any pending_approval page_plans row whose existing_page_id
 * targets this page is dropped. Without this, an orphan plan can later be approved
 * and re-UPSERT the deleted page (zombie resurrection via commitSinglePlan).
 */
export function deletePage(pageId: string): { chatDraftsRewritten: number; chatDraftsDeleted: number } {
  const db = openDb();
  let chatCleanup = { rewritten: 0, deleted: 0 };
  db.transaction(() => {
    db.prepare(`DELETE FROM page_links WHERE source_page_id = ? OR target_page_id = ?`).run(pageId, pageId);
    db.prepare(`DELETE FROM pages_fts WHERE page_id = ?`).run(pageId);
    db.prepare(`DELETE FROM aliases WHERE canonical_page_id = ?`).run(pageId);
    db.prepare(`DELETE FROM provenance WHERE page_id = ?`).run(pageId);
    db.prepare(`DELETE FROM page_plans WHERE existing_page_id = ? AND draft_status = 'pending_approval'`).run(pageId);
    chatCleanup = cleanupChatDraftsForDeletedPage(pageId);
    db.prepare(`DELETE FROM pages WHERE page_id = ?`).run(pageId);
  })();
  return { chatDraftsRewritten: chatCleanup.rewritten, chatDraftsDeleted: chatCleanup.deleted };
}

/**
 * Return the set of page_ids where ALL backing sources have status='archived'.
 * Zero-provenance pages are NOT included (HAVING COUNT(*) > 0 guard prevents
 * the degenerate 0=0 case from hiding pages with no provenance at all).
 *
 * Result is cached for 30s — wiki listing, category and graph reads all call
 * this and the query is expensive (GROUP BY JOIN on provenance). Cache is
 * invalidated by setSourceStatus (archive/unarchive) and deleteSource
 * (source removal).
 */
let _archivedIdsCache: { ids: Set<string>; ts: number } | null = null;
const ARCHIVED_IDS_TTL = 30_000;

export function getAllArchivedPageIds(): Set<string> {
  const now = Date.now();
  if (_archivedIdsCache && now - _archivedIdsCache.ts < ARCHIVED_IDS_TTL) {
    return _archivedIdsCache.ids;
  }
  const rows = openDb()
    .prepare(
      `SELECT pr.page_id
         FROM provenance pr
         JOIN sources s ON s.source_id = pr.source_id
        GROUP BY pr.page_id
       HAVING COUNT(*) > 0
          AND COUNT(*) = SUM(CASE WHEN s.status = 'archived' THEN 1 ELSE 0 END)`
    )
    .all() as { page_id: string }[];
  const ids = new Set(rows.map((r) => r.page_id));
  _archivedIdsCache = { ids, ts: now };
  return ids;
}

/**
 * Set the status column on a source row (active / archived).
 * Invalidates the archived-page-ids cache so the next read reflects the change.
 */
export function setSourceStatus(sourceId: string, status: 'active' | 'archived'): void {
  _archivedIdsCache = null;
  openDb()
    .prepare('UPDATE sources SET status = ? WHERE source_id = ?')
    .run(status, sourceId);
}

// ============================================================================
// Settings helpers (commit 8)
// ============================================================================

/**
 * Whether AI agents may add sources through MCP add_source, which starts
 * compiles (LLM spend). Off unless the user turns it on in Settings, and
 * never carried in backups, so restoring one can't switch it on.
 */
export const AGENT_ADD_SOURCES_KEY = 'agent_add_sources_enabled';

export function getAgentAddSourcesEnabled(): boolean {
  return getSetting(AGENT_ADD_SOURCES_KEY) === '1';
}

export function setAgentAddSourcesEnabled(value: boolean): void {
  setSetting(AGENT_ADD_SOURCES_KEY, value ? '1' : '0');
}

/**
 * Get the auto-approve setting. Defaults to true (direct commit) if not set.
 */
export function getAutoApprove(): boolean {
  return getSetting('auto_approve') !== '0';
}

/**
 * Set the auto-approve toggle.
 */
export function setAutoApprove(value: boolean): void {
  setSetting('auto_approve', value ? '1' : '0');
}

/**
 * Minimum active source count before "related pages" panel is shown.
 * Defaults to 10 if not set.
 */
export function getRelatedPagesMinSources(): number {
  const v = getSetting('related_pages_min_sources');
  return v !== null ? Math.max(0, parseInt(v, 10)) : 10;
}

export function setRelatedPagesMinSources(value: number): void {
  setSetting('related_pages_min_sources', String(Math.max(0, Math.floor(value))));
}

/**
 * Number of days before a source is considered stale. Defaults to 90.
 * Set to 0 to disable stale source alerts.
 */
export function getStaleThresholdDays(): number {
  const v = getSetting('stale_threshold_days');
  return v !== null ? Math.max(0, parseInt(v, 10)) : 90;
}

export function setStaleThresholdDays(value: number): void {
  setSetting('stale_threshold_days', String(Math.max(0, Math.floor(value))));
}

/**
 * Minimum source content length (chars) for a source-summary wiki page to be
 * planned. Sources shorter than this still contribute to entity extraction and
 * provenance — they just don't get their own page. Default 500.
 * Set to 0 to disable (all sources get a page regardless of length).
 */
export function getMinSourceChars(): number {
  const v = getSetting('min_source_chars');
  return v !== null ? Math.max(0, parseInt(v, 10)) : 500;
}

export function setMinSourceChars(value: number): void {
  setSetting('min_source_chars', String(Math.max(0, Math.floor(value))));
}

/**
 * Minimum draft body length (chars, frontmatter excluded) for a draft to be
 * committed. Drafts shorter than this are skipped and logged as
 * 'draft_too_thin'. Default 800. Set to 0 to disable.
 */
export function getMinDraftChars(): number {
  const v = getSetting('min_draft_chars');
  return v !== null ? Math.max(0, parseInt(v, 10)) : 800;
}

export function setMinDraftChars(value: number): void {
  setSetting('min_draft_chars', String(Math.max(0, Math.floor(value))));
}

/**
 * Wiki-wide entity promotion threshold — minimum distinct sources that must
 * mention an entity (or concept) before it gets its own page. Counted across
 * the full corpus via entity_mentions, not just the current compile session,
 * so ingests compound over time (Karpathy compile-wiki thesis).
 *
 * Default 2: promote as soon as a second source corroborates the mention.
 * Set to 1 to promote on first sighting (noisy, burns LLM budget — a single
 * Wikipedia-style article can surface ~20 canonical entities, each becoming
 * its own draft call). Raise for a stricter anti-noise floor.
 */
export function getEntityPromotionThreshold(): number {
  const v = getSetting('entity_promotion_threshold');
  return v !== null ? Math.max(1, parseInt(v, 10)) : 2;
}

export function setEntityPromotionThreshold(value: number): void {
  setSetting('entity_promotion_threshold', String(Math.max(1, Math.floor(value))));
}

/**
 * Flag 3A — dossier capping settings.
 *
 * dossier_max_sources: top-N cap after TF-IDF ranking. 12 × ~300 tokens of
 * dossier lines ≈ 3.6k tokens; leaves headroom for existing page markdown
 * (update path) and the prompt scaffolding alongside Gemini's window.
 *
 * dossier_min_score: minimum TF-IDF cosine similarity for a source's dossier
 * block to be kept. 0.05 is a floor that excludes zero-match candidates
 * without being restrictive. 0 disables the min-score filter entirely.
 */
export function getDossierMaxSources(): number {
  const v = getSetting('dossier_max_sources');
  return v !== null ? Math.max(1, parseInt(v, 10)) : 12;
}

export function setDossierMaxSources(value: number): void {
  setSetting('dossier_max_sources', String(Math.max(1, Math.floor(value))));
}

export function getDossierMinScore(): number {
  const v = getSetting('dossier_min_score');
  const n = v !== null ? parseFloat(v) : 0.05;
  if (!Number.isFinite(n) || n < 0) return 0.05;
  return n;
}

export function setDossierMinScore(value: number): void {
  const clamped = Math.max(0, Number.isFinite(value) ? value : 0.05);
  setSetting('dossier_min_score', String(clamped));
}

// The 'chat_model' settings row may still exist on installs that used the
// retired in-app chat. Nothing reads it; it is left in place (and in exports)
// rather than deleted so old backups round-trip unchanged.

// Model used by every compile-pipeline LLM step (extract, resolve, draft,
// crossref, schema) plus lint and recompile. Validated against LLM_MODELS
// (lib/llm-models.ts). Migration v26 gives every install an explicit
// compile_model row, so DEFAULT_COMPILE_MODEL is only a last resort.
export function getCompileModel(): LlmModel {
  const v = getSetting('compile_model');
  return isLlmModel(v) ? v : DEFAULT_COMPILE_MODEL;
}

export function setCompileModel(value: string): void {
  if (!isLlmModel(value)) {
    throw new Error(`invalid compile_model: ${value}`);
  }
  setSetting('compile_model', value);
}

const LLM_CONFIG_PATH = path.join(DATA_ROOT, 'llm-config.json');
const DEFAULT_DAILY_CAP_USD = 5.00;

// Single read/write of /data/llm-config.json. setDailyCapUsd is the only
// caller today; merge semantics retained from when setThinkingBudgets
// (retired Phase 8) shared the file.
function readLlmConfig(): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(LLM_CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function writeLlmConfig(patch: Record<string, unknown>): void {
  const merged = { ...readLlmConfig(), ...patch };
  try {
    fs.writeFileSync(LLM_CONFIG_PATH, JSON.stringify(merged));
  } catch {
    // Non-fatal: NLP service falls back to its hardcoded defaults.
  }
}

export function getDailyCapUsd(): number {
  const v = getSetting('daily_cap_usd');
  if (v === null) return DEFAULT_DAILY_CAP_USD;
  const n = parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_CAP_USD;
}

export function setDailyCapUsd(value: number): void {
  const clamped = Math.max(0, Number.isFinite(value) ? value : DEFAULT_DAILY_CAP_USD);
  setSetting('daily_cap_usd', String(clamped));
  writeLlmConfig({ daily_cap_usd: clamped });
}

export function countPagePlansByStatus(sessionId: string): Record<string, number> {
  const rows = openDb()
    .prepare(
      `SELECT draft_status, COUNT(*) AS c
         FROM page_plans
        WHERE session_id = ?
        GROUP BY draft_status`
    )
    .all(sessionId) as Array<{ draft_status: string; c: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.draft_status] = r.c;
  return out;
}

export interface StaleSourceRow {
  source_id: string;
  title: string;
  source_type: string;
  date_ingested: string;
  days_old: number;
}

// ============================================================================
// Ingest Failures — persisted records for bookmarks/URLs that could not be
// scraped, so the user never loses a saved link.
// ============================================================================

export interface IngestFailureRow {
  failure_id: string;
  source_url: string | null;
  title_hint: string | null;
  date_saved: string | null;
  date_attempted: string;
  error: string;
  source_type: string;
  resolved_source_id: string | null;
}

export interface InsertIngestFailureArgs {
  failure_id: string;
  source_url: string | null;
  title_hint?: string | null;
  date_saved?: string | null;
  error: string;
  source_type?: string;
  metadata?: string | null;
  // v18: scope failures to the onboarding session so retry-failed can
  // filter per-session. Nullable for backward compat with legacy rows
  // and the n8n POST /api/activity path (which doesn't carry session).
  session_id?: string | null;
}

/**
 * One Saved Links row per link (issue #139): the same page however it is
 * written (host case, a trailing slash; lib/url-key.ts, as the agent
 * duplicate checks spell it). Anything that isn't a URL matches only itself.
 */
function savedLinkKey(url: string): string {
  return urlKey(url) ?? url;
}

/** The unresolved rows of the link `url` names, newest first. */
function unresolvedFailuresForLink(url: string): string[] {
  const key = savedLinkKey(url);
  const candidates = urlKey(url) ? urlKeyCandidates(key) : [url.toLowerCase()];
  const rows = openDb()
    .prepare(
      `SELECT failure_id, source_url FROM ingest_failures
        WHERE resolved_source_id IS NULL
          AND lower(source_url) IN (${candidates.map(() => '?').join(', ')})
        ORDER BY datetime(date_attempted) DESC, rowid DESC`
    )
    .all(...candidates) as Array<{ failure_id: string; source_url: string }>;
  return rows.filter((r) => savedLinkKey(r.source_url) === key).map((r) => r.failure_id);
}

/**
 * Record a link that could not be imported. A link that already has an
 * unresolved row updates it instead of adding one: the newest error, the
 * session that last tried (so retry-failed finds it), title and preview
 * kept when this attempt brings none, and one more attempt counted.
 */
export function insertIngestFailure(args: InsertIngestFailureArgs): void {
  const db = openDb();
  const values = {
    failure_id: args.failure_id,
    source_url: args.source_url ?? null,
    title_hint: args.title_hint ?? null,
    date_saved: args.date_saved ?? null,
    error: args.error,
    source_type: args.source_type ?? 'url',
    metadata: args.metadata ?? null,
    session_id: args.session_id ?? null,
  };
  db.transaction(() => {
    const [existing] = values.source_url ? unresolvedFailuresForLink(values.source_url) : [];
    if (existing) {
      db.prepare(
        `UPDATE ingest_failures
            SET error          = @error,
                date_attempted = CURRENT_TIMESTAMP,
                source_type    = @source_type,
                session_id     = COALESCE(@session_id, session_id),
                title_hint     = COALESCE(@title_hint, title_hint),
                metadata       = COALESCE(@metadata, metadata),
                date_saved     = COALESCE(date_saved, @date_saved),
                attempts       = attempts + 1
          WHERE failure_id = @existing`
      ).run({ ...values, existing });
      return;
    }
    db.prepare(
      `INSERT OR IGNORE INTO ingest_failures
         (failure_id, source_url, title_hint, date_saved, error, source_type, metadata, session_id)
       VALUES
         (@failure_id, @source_url, @title_hint, @date_saved, @error, @source_type, @metadata, @session_id)`
    ).run(values);
  })();
}

/**
 * The link was imported (in any session): its unresolved rows are marked
 * resolved by the new source, so it leaves Saved Links. The rows are kept.
 * Returns how many rows it resolved.
 */
export function resolveIngestFailuresForUrl(url: string, sourceId: string): number {
  const db = openDb();
  return db.transaction(() => {
    const ids = unresolvedFailuresForLink(url);
    const mark = db.prepare('UPDATE ingest_failures SET resolved_source_id = ? WHERE failure_id = ?');
    for (const id of ids) mark.run(sourceId, id);
    return ids.length;
  })();
}

/**
 * Return all ingest failures, unresolved first, then resolved, newest first.
 */
export function getIngestFailures(): IngestFailureRow[] {
  return openDb()
    .prepare(
      `SELECT failure_id, source_url, title_hint, date_saved,
              date_attempted, error, source_type, resolved_source_id
         FROM ingest_failures
        ORDER BY resolved_source_id IS NOT NULL ASC,
                 date_attempted DESC`
    )
    .all() as IngestFailureRow[];
}


/**
 * Unresolved saved links for the wiki page.
 * Only rows in ingest_failures that have not been resolved yet.
 * Once a link is successfully ingested it drops off.
 *
 * `metadata` is a JSON string captured at failure time (best-effort og-peek):
 * `{title, description, og_image}` — any field may be null.
 */
export interface SavedLinkRow {
  failure_id: string;
  source_url: string;
  title: string | null;
  date_saved: string | null;
  date_attempted: string;
  error: string;
  source_type: string;
  metadata: string | null;
  /** Failed attempts for this link, rows saved before one row per link included. */
  attempts: number;
}

/**
 * One row per link, newest attempt first (issue #139). Rows saved before
 * failures were merged read as one: the newest row's error and date, every
 * row's attempts, and the title, preview and saved date the newest row
 * lacks taken from older ones. A link already in the wiki (a source with
 * the same address, however it was written) is left out.
 */
export function getUnresolvedLinks(): SavedLinkRow[] {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT failure_id,
              source_url,
              title_hint  AS title,
              date_saved,
              date_attempted,
              error,
              source_type,
              metadata,
              attempts
         FROM ingest_failures
        WHERE resolved_source_id IS NULL
          AND source_url IS NOT NULL
        ORDER BY datetime(date_attempted) DESC, rowid DESC`
    )
    .all() as SavedLinkRow[];
  if (rows.length === 0) return [];
  const inWiki = new Set(
    (db
      .prepare(`SELECT source_url FROM sources WHERE source_url IS NOT NULL AND compile_status != 'collected'`)
      .all() as Array<{ source_url: string }>).map((r) => savedLinkKey(r.source_url))
  );
  const byLink = new Map<string, SavedLinkRow>();
  for (const row of rows) {
    const key = savedLinkKey(row.source_url);
    if (inWiki.has(key)) continue;
    const link = byLink.get(key);
    if (!link) {
      byLink.set(key, { ...row });
      continue;
    }
    link.attempts += row.attempts;
    link.title ??= row.title;
    link.metadata ??= row.metadata;
    link.date_saved = row.date_saved ?? link.date_saved; // older rows come later: the first save wins
  }
  return [...byLink.values()];
}

/**
 * Dismiss a saved link: the row, and every other unresolved row of the
 * same link (rows saved before one row per link), so none takes its place.
 */
export function deleteIngestFailure(failureId: string): boolean {
  const db = openDb();
  return db.transaction(() => {
    const row = db
      .prepare('SELECT source_url, resolved_source_id FROM ingest_failures WHERE failure_id = ?')
      .get(failureId) as { source_url: string | null; resolved_source_id: string | null } | undefined;
    if (!row) return false;
    const ids = row.source_url && row.resolved_source_id === null ? unresolvedFailuresForLink(row.source_url) : [];
    const drop = db.prepare('DELETE FROM ingest_failures WHERE failure_id = ?');
    for (const id of new Set([failureId, ...ids])) drop.run(id);
    return true;
  })();
}

/**
 * Count included staging rows in 'failed' state for a session.
 * Powers the "Retry N failed items" button on the progress page.
 */
export function countFailedStagingBySession(sessionId: string): number {
  const row = openDb()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM collect_staging
        WHERE session_id = ?
          AND status     = 'failed'
          AND included   = 1`
    )
    .get(sessionId) as { n: number };
  return row.n;
}

/**
 * Count page_plans rows with draft_status='failed' for a session.
 * Distinct from staging-failure count: these are wiki-page draft attempts
 * that hit a per-item LLM error after planning — the "Writing pages" step
 * marks itself 'done' regardless so commit can run on the drafts that
 * succeeded, which is why these failures don't trip the session-level
 * retry condition. Powers the "Retry N failed" button when failures live
 * in the draft stage rather than at intake.
 */
export function countFailedDraftPlansBySession(sessionId: string): number {
  const row = openDb()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM page_plans
        WHERE session_id   = ?
          AND draft_status = 'failed'`
    )
    .get(sessionId) as { n: number };
  return row.n;
}

/**
 * Count `sources` rows for a session that have no matching `extractions` row.
 * This is the per-source extract-failure shape: the orchestrator's extract
 * step tolerates per-item failures (only fails the session if EVERY source
 * fails extraction — see app/src/app/api/compile/run/route.ts:387). Sources
 * that failed extraction stay at compile_status='pending' (the initial
 * value) with no `extractions` row, even after compile_progress reaches
 * 'completed'. Powers the third arm of the "Retry N failed" button —
 * alongside countFailedStagingBySession (intake-stage) and
 * countFailedDraftPlansBySession (per-page LLM).
 */
export function countUnextractedSourcesBySession(sessionId: string): number {
  const row = openDb()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM sources s
         LEFT JOIN extractions e ON s.source_id = e.source_id
        WHERE s.onboarding_session_id = ?
          AND e.source_id IS NULL`
    )
    .get(sessionId) as { n: number };
  return row.n;
}

/**
 * Return active sources older than thresholdDays, ordered oldest-first.
 * Uses julianday() for correct date arithmetic — avoids the SQLite
 * lexicographic timestamp gotcha.
 */
export function getStaleSources(thresholdDays: number): StaleSourceRow[] {
  if (thresholdDays <= 0) return [];
  return openDb()
    .prepare(
      `SELECT source_id, title, source_type, date_ingested,
              CAST(julianday('now') - julianday(date_ingested) AS INTEGER) AS days_old
         FROM sources
        WHERE status = 'active'
          AND julianday('now') - julianday(date_ingested) > ?
        ORDER BY date_ingested ASC`
    )
    .all(thresholdDays) as StaleSourceRow[];
}

// ============================================================================
// Lint settings helpers
// ============================================================================

/**
 * Legacy setting for the scheduled lint pass that `kompl start` used to fire.
 * That schedule was retired in v0.4: lint-pass/route.ts runs only when the user
 * asks, whatever this says. Kept so the settings API, older clients and
 * backups that carry the row keep working.
 */
export function getLintEnabled(): boolean {
  return getSetting('lint_enabled') !== '0';
}

export function setLintEnabled(value: boolean): void {
  setSetting('lint_enabled', value ? '1' : '0');
}

// ---------------------------------------------------------------------------
// Startup task timestamps
// ---------------------------------------------------------------------------

export function getLastLintAt(): string | null {
  return getSetting('last_lint_at');
}

export function setLastLintAt(ts: string): void {
  setSetting('last_lint_at', ts);
}

export function getLastBackupAt(): string | null {
  return getSetting('last_backup_at');
}

export function setLastBackupAt(ts: string): void {
  setSetting('last_backup_at', ts);
}

/**
 * Fetch the details JSON from the most recent lint_complete activity row.
 * Returns null if no lint has ever run.
 */
export function getLastLintResult(): Record<string, unknown> | null {
  const row = openDb()
    .prepare(
      `SELECT details FROM activity_log
       WHERE action_type = 'lint_complete'
       ORDER BY id DESC LIMIT 1`
    )
    .get() as { details: string | null } | undefined;
  if (!row?.details) return null;
  try {
    return JSON.parse(row.details) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ============================================================================
// Wiki stats (commit 8) — served by GET /api/wiki/stats
// ============================================================================

export interface WikiStats {
  source_count: number;
  page_count: number;
  entity_count: number;
  concept_count: number;
  last_ingested: string | null;
  last_compiled: string | null;
}

/**
 * Quick stats snapshot (source/page/entity/concept counts, last ingest and
 * compile times). All reads are cheap index scans — no full table scans.
 */
export function getWikiStats(): WikiStats {
  const db = openDb();

  const sourceCount = (db.prepare('SELECT COUNT(*) AS n FROM sources WHERE status = ?').get('active') as { n: number }).n;
  const pageCount = (db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n;
  const entityCount = (db.prepare("SELECT COUNT(*) AS n FROM pages WHERE page_type = 'entity'").get() as { n: number }).n;
  const conceptCount = (db.prepare("SELECT COUNT(*) AS n FROM pages WHERE page_type = 'concept'").get() as { n: number }).n;

  const lastIngestedRow = db
    .prepare('SELECT date_ingested FROM sources ORDER BY date_ingested DESC LIMIT 1')
    .get() as { date_ingested: string } | undefined;

  const lastCompiledRow = db
    .prepare('SELECT last_updated FROM pages ORDER BY last_updated DESC LIMIT 1')
    .get() as { last_updated: string } | undefined;

  return {
    source_count: sourceCount,
    page_count: pageCount,
    entity_count: entityCount,
    concept_count: conceptCount,
    last_ingested: lastIngestedRow?.date_ingested ?? null,
    last_compiled: lastCompiledRow?.last_updated ?? null,
  };
}

// ============================================================================
// Draft approval helpers (commit 8)
// ============================================================================

/** Number of drafts waiting for approval, without loading their text. */
export function countPendingDrafts(): number {
  return (
    openDb().prepare(`SELECT COUNT(*) AS n FROM page_plans WHERE draft_status = 'pending_approval'`).get() as {
      n: number;
    }
  ).n;
}

/**
 * Fetch all page_plans with draft_status = 'pending_approval'.
 * Used by GET /api/drafts/pending and the dashboard draft section.
 */
export function getPendingDrafts(): PagePlanRow[] {
  return openDb()
    .prepare(
      `SELECT plan_id, session_id, title, page_type, action,
              source_ids, existing_page_id, related_plan_ids,
              draft_content, draft_status, draft_error, created_at
         FROM page_plans
        WHERE draft_status = 'pending_approval'
        ORDER BY created_at DESC`
    )
    .all() as PagePlanRow[];
}

/**
 * Update a page's file paths and source_count after a recompile.
 * Called inside a db.transaction() — no await.
 */
export function updatePageContent(
  pageId: string,
  contentPath: string,
  previousContentPath: string | null,
  sourceCount: number
): void {
  openDb()
    .prepare(
      `UPDATE pages
          SET content_path = ?,
              previous_content_path = ?,
              source_count = ?,
              last_updated = datetime('now')
        WHERE page_id = ?`
    )
    .run(contentPath, previousContentPath, sourceCount, pageId);
}

// ── Outbox helpers (crash-safe file writes, CLAUDE.md Gap 2) ─────────────────
//
// Phase 2 stores markdown in pending_content alongside the expected content_path.
// Phase 3a flushes to disk then calls clearPendingContent. If Phase 3a crashes,
// pending_content IS NOT NULL acts as a reconciler signal on next boot/request.

/** Mark a page as needing a file flush. Called inside db.transaction() in Phase 2. */
export function setPendingContent(pageId: string, content: string): void {
  openDb()
    .prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?')
    .run(content, pageId);
}

/**
 * Clear the outbox buffer after a successful file flush. Also stores the
 * previous_content_path returned by write_page (the archive path for the
 * prior version, determined at flush time).
 * Called OUTSIDE any transaction — it is a separate statement after Phase 3a.
 */
export function clearPendingContent(pageId: string, previousContentPath: string | null): void {
  openDb()
    .prepare(
      'UPDATE pages SET pending_content = NULL, previous_content_path = ? WHERE page_id = ?'
    )
    .run(previousContentPath, pageId);
}

/** A page's outbox text, or null when nothing is waiting to be flushed. */
export function getPendingContent(pageId: string): string | null {
  const row = openDb()
    .prepare('SELECT pending_content FROM pages WHERE page_id = ?')
    .get(pageId) as { pending_content: string | null } | undefined;
  return row?.pending_content ?? null;
}

/**
 * Compare-and-set clearPendingContent: clears the outbox only while it still
 * holds `writtenContent`, the text the flush just wrote. Another writer can
 * replace pending_content while a flush is in flight; clearing it anyway
 * would drop that newer text from the outbox while the file holds the older
 * one. Returns true when the row was cleared.
 */
export function clearPendingContentIfUnchanged(
  pageId: string,
  previousContentPath: string | null,
  writtenContent: string
): boolean {
  return (
    openDb()
      .prepare(
        `UPDATE pages SET pending_content = NULL, previous_content_path = ?
          WHERE page_id = ? AND pending_content = ?`
      )
      .run(previousContentPath, pageId, writtenContent).changes > 0
  );
}

/**
 * Return all pages that have a pending file flush. Used by the boot reconciler
 * and the /api/health endpoint to detect and recover unflushed pages.
 */
export function getPendingFlushPages(): Array<{
  page_id: string;
  content_path: string;
  pending_content: string;
}> {
  return openDb()
    .prepare(
      'SELECT page_id, content_path, pending_content FROM pages WHERE pending_content IS NOT NULL'
    )
    .all() as Array<{ page_id: string; content_path: string; pending_content: string }>;
}

/**
 * Return the page title → page_id map for wikilink expansion.
 * Used by the wiki page renderer to convert [[Title]] to clickable links.
 */
export function getPageTitleMap(): Map<string, string> {
  const rows = openDb()
    .prepare('SELECT page_id, title FROM pages')
    .all() as Array<{ page_id: string; title: string }>;
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.title.toLowerCase(), row.page_id);
  }
  return map;
}

// ============================================================================
// Staging helpers (schema v18)
// ============================================================================
//
// collect_staging holds pre-ingestion intent from onboarding connectors.
// Connectors write rows at user click-time (no scraping); the compile
// pipeline's new prelude steps (ingest_files / ingest_urls / ingest_texts)
// consume them and promote to `sources` rows via the existing NLP convert
// helpers. Status lifecycle:
//   pending   — just staged, awaiting finalize
//   ingesting — prelude step picked it up (lock window)
//   ingested  — source row created; resolved_source_id set
//   failed    — conversion or insert failed; error_* populated
//   discarded — user unchecked on review page; skipped by finalize

export type StagingConnector = 'url' | 'file-upload' | 'text' | 'saved-link' | 'paste';
export type StagingStatus =
  | 'pending'
  | 'ingesting'
  | 'ingested'
  | 'failed'
  | 'discarded';

export interface StagingRow {
  stage_id: string;
  session_id: string;
  connector: StagingConnector;
  payload: Record<string, unknown>; // parsed from JSON on read
  included: boolean;                // stored as 0/1 INTEGER
  status: StagingStatus;
  resolved_source_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  ingested_at: string | null;
}

interface StagingRowRaw {
  stage_id: string;
  session_id: string;
  connector: StagingConnector;
  payload: string;
  included: number;
  status: StagingStatus;
  resolved_source_id: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  ingested_at: string | null;
}

function parseStagingRow(r: StagingRowRaw): StagingRow {
  return {
    stage_id: r.stage_id,
    session_id: r.session_id,
    connector: r.connector,
    payload: JSON.parse(r.payload) as Record<string, unknown>,
    included: r.included === 1,
    status: r.status,
    resolved_source_id: r.resolved_source_id,
    error_code: r.error_code,
    error_message: r.error_message,
    created_at: r.created_at,
    ingested_at: r.ingested_at,
  };
}

export interface InsertCollectStagingArgs {
  stage_id: string;
  session_id: string;
  connector: StagingConnector;
  payload: Record<string, unknown>;
  included?: boolean; // defaults to true
}

export function insertCollectStaging(args: InsertCollectStagingArgs): void {
  openDb()
    .prepare(
      `INSERT INTO collect_staging
         (stage_id, session_id, connector, payload, included)
       VALUES
         (@stage_id, @session_id, @connector, @payload, @included)`
    )
    .run({
      stage_id: args.stage_id,
      session_id: args.session_id,
      connector: args.connector,
      payload: JSON.stringify(args.payload),
      included: args.included === false ? 0 : 1,
    });
}

export function getStagingBySession(session_id: string): StagingRow[] {
  const rows = openDb()
    .prepare(
      `SELECT stage_id, session_id, connector, payload, included, status,
              resolved_source_id, error_code, error_message,
              created_at, ingested_at
         FROM collect_staging
        WHERE session_id = ?
        ORDER BY created_at ASC`
    )
    .all(session_id) as StagingRowRaw[];
  return rows.map(parseStagingRow);
}

export function getStagingByStageId(stage_id: string): StagingRow | null {
  const row = openDb()
    .prepare(
      `SELECT stage_id, session_id, connector, payload, included, status,
              resolved_source_id, error_code, error_message,
              created_at, ingested_at
         FROM collect_staging
        WHERE stage_id = ?`
    )
    .get(stage_id) as StagingRowRaw | undefined;
  return row ? parseStagingRow(row) : null;
}

export function updateStagingIncluded(stage_id: string, included: boolean): void {
  openDb()
    .prepare(`UPDATE collect_staging SET included = ? WHERE stage_id = ?`)
    .run(included ? 1 : 0, stage_id);
}

export function markStagingIngesting(stage_id: string): void {
  openDb()
    .prepare(
      `UPDATE collect_staging
          SET status = 'ingesting'
        WHERE stage_id = ? AND status = 'pending'`
    )
    .run(stage_id);
}

export function markStagingIngested(
  stage_id: string,
  resolved_source_id: string
): void {
  openDb()
    .prepare(
      `UPDATE collect_staging
          SET status             = 'ingested',
              resolved_source_id = ?,
              ingested_at        = CURRENT_TIMESTAMP,
              error_code         = NULL,
              error_message      = NULL
        WHERE stage_id = ?`
    )
    .run(resolved_source_id, stage_id);
}

export function markStagingFailed(
  stage_id: string,
  error_code: string,
  error_message: string
): void {
  openDb()
    .prepare(
      `UPDATE collect_staging
          SET status        = 'failed',
              error_code    = ?,
              error_message = ?
        WHERE stage_id = ?`
    )
    .run(error_code, error_message, stage_id);
}

/**
 * Delete all staging rows for a session and return the file-upload
 * payload paths so the caller can unlink them post-transaction.
 * Staging is the source of truth for "files staged but not yet ingested,"
 * so the file is owned by the staging row until it gets promoted to a
 * source (whose own lifecycle then owns the raw gzip path).
 */
export function deleteStagingBySession(
  session_id: string
): { deleted: number; file_paths: string[] } {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT connector, payload FROM collect_staging WHERE session_id = ?`
    )
    .all(session_id) as Array<{ connector: StagingConnector; payload: string }>;

  const file_paths: string[] = [];
  for (const row of rows) {
    if (row.connector !== 'file-upload') continue;
    try {
      const payload = JSON.parse(row.payload) as { file_path?: unknown };
      if (typeof payload.file_path === 'string' && payload.file_path.length > 0) {
        file_paths.push(payload.file_path);
      }
    } catch {
      // Malformed payload — skip the unlink attempt rather than crash.
    }
  }

  const result = db
    .prepare(`DELETE FROM collect_staging WHERE session_id = ?`)
    .run(session_id);

  return { deleted: result.changes as number, file_paths };
}

// ============================================================================
// Source dedup helpers — called by the ingest_urls / ingest_files prelude steps
// ============================================================================
//
// Two queries, matching on source_url first then content_hash. The
// `compile_status != 'collected'` filter is vestigial: post-Phase-3 no TS
// writes 'collected' any more, but the filter stays defensively to ignore
// any stale legacy row that somehow survived the v18 migration.

export function findSourceByUrl(url: string): { source_id: string } | null {
  const row = openDb()
    .prepare(
      `SELECT source_id
         FROM sources
        WHERE source_url = ?
          AND compile_status != 'collected'
        LIMIT 1`
    )
    .get(url) as { source_id: string } | undefined;
  return row ?? null;
}

export function findSourceByContentHash(
  content_hash: string
): { source_id: string } | null {
  const row = openDb()
    .prepare(
      `SELECT source_id
         FROM sources
        WHERE content_hash = ?
          AND compile_status != 'collected'
        LIMIT 1`
    )
    .get(content_hash) as { source_id: string } | undefined;
  return row ?? null;
}

// ============================================================================
// Bulk export readers — used by /api/export (kompl format) to serialize
// every persistent user-visible or correctness-critical table so the
// /api/import round-trip restores the wiki in full. Autoincrement `id`
// columns are intentionally excluded so SQLite reassigns on re-insert.
// ============================================================================

export interface PageLinkRow {
  source_page_id: string;
  target_page_id: string;
  link_type: string;
  created_at: string;
}

export function getAllPageLinks(): PageLinkRow[] {
  return openDb()
    .prepare(
      `SELECT source_page_id, target_page_id, link_type, created_at
         FROM page_links
        ORDER BY id`
    )
    .all() as PageLinkRow[];
}

export interface EntityMentionRow {
  canonical_name: string;
  source_id: string;
  entity_type: string | null;
  first_seen_at: string;
}

export function getAllEntityMentions(): EntityMentionRow[] {
  return openDb()
    .prepare(
      `SELECT canonical_name, source_id, entity_type, first_seen_at
         FROM entity_mentions
        ORDER BY first_seen_at, canonical_name`
    )
    .all() as EntityMentionRow[];
}

export interface RelationshipMentionRow {
  from_canonical: string;
  to_canonical: string;
  relationship_type: string;
  source_id: string;
  first_seen_at: string;
  /** v28; null until filled (lib/relation-backfill.ts). */
  description: string | null;
  /** v30: the source's sentence; null for relations extracted before quotes. */
  quote: string | null;
  /** v30: 1 found in the source, 0 not found, null without a quote. */
  quote_verified: number | null;
}

export function getAllRelationshipMentions(): RelationshipMentionRow[] {
  return openDb()
    .prepare(
      `SELECT from_canonical, to_canonical, relationship_type, source_id, first_seen_at,
              description, quote, quote_verified
         FROM relationship_mentions
        ORDER BY first_seen_at`
    )
    .all() as RelationshipMentionRow[];
}

export interface DraftRow {
  draft_id: string;
  page_id: string | null;
  draft_content: string;
  draft_type: string;
  source_id: string | null;
  status: string;
  created_at: string;
}

export function getAllDrafts(): DraftRow[] {
  return openDb()
    .prepare(
      `SELECT draft_id, page_id, draft_content, draft_type, source_id, status, created_at
         FROM drafts
        ORDER BY created_at`
    )
    .all() as DraftRow[];
}

export interface ActivityLogRow {
  timestamp: string;
  action_type: string;
  source_id: string | null;
  details: string | null;
  /** v23: the compile session and step the event belongs to. */
  session_id: string | null;
  step_key: string | null;
}

/** In the order they were logged, so a restore keeps events that share a timestamp in order. */
export function getAllActivityLog(): ActivityLogRow[] {
  return openDb()
    .prepare(
      `SELECT timestamp, action_type, source_id, details, session_id, step_key
         FROM activity_log
        ORDER BY id`
    )
    .all() as ActivityLogRow[];
}

export interface CompileProgressExportRow {
  session_id: string;
  status: string;
  current_step: string | null;
  steps: string;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  source_count: number;
  /** v20: the model the session was locked to; null for older sessions. */
  compile_model: string | null;
}

export function getAllCompileProgress(): CompileProgressExportRow[] {
  return openDb()
    .prepare(
      `SELECT session_id, status, current_step, steps, error,
              started_at, completed_at, created_at, source_count, compile_model
         FROM compile_progress
        ORDER BY created_at`
    )
    .all() as CompileProgressExportRow[];
}

export interface IngestFailureExportRow {
  failure_id: string;
  source_url: string | null;
  title_hint: string | null;
  date_saved: string | null;
  date_attempted: string;
  error: string;
  source_type: string;
  resolved_source_id: string | null;
  metadata: string | null;
  session_id: string | null;
  attempts: number;
}

/** The links saved but not fetched (the Saved Links page), resolved ones too. */
export function getAllIngestFailures(): IngestFailureExportRow[] {
  return openDb()
    .prepare(
      `SELECT failure_id, source_url, title_hint, date_saved, date_attempted, error,
              source_type, resolved_source_id, metadata, session_id, attempts
         FROM ingest_failures
        ORDER BY date_attempted, failure_id`
    )
    .all() as IngestFailureExportRow[];
}

// chat_messages is legacy: the in-app chat was retired in favour of MCP, but
// the table and its rows are kept so existing history survives export →
// import round-trips (old backups carry db/chat_messages.json).
export interface ChatMessageExportRow {
  session_id: string;
  role: string;
  content: string;
  citations: string | null;
  pages_used: string | null;
  chat_model: string | null;
  created_at: string;
}

export function getAllChatMessages(): ChatMessageExportRow[] {
  return openDb()
    .prepare(
      `SELECT session_id, role, content, citations, pages_used, chat_model, created_at
         FROM chat_messages
        ORDER BY id`
    )
    .all() as ChatMessageExportRow[];
}

export interface PagePlanExportRow {
  plan_id: string;
  session_id: string;
  title: string;
  page_type: string;
  action: string;
  source_ids: string;
  existing_page_id: string | null;
  related_plan_ids: string | null;
  draft_content: string | null;
  draft_status: string;
  created_at: string;
  /** v27: writing rules the draft was made under; null for pre-v0.4 drafts. */
  draft_rules: string | null;
  /** v24: why the draft failed. */
  draft_error: string | null;
  /** v30: JSON list of the sources the draft's prompt carried; null credits every plan source. */
  used_source_ids: string | null;
}

/**
 * Plans for a backup. base_version (v30) is left out: it counts provenance
 * row ids, which an import renumbers, so a restored draft waiting for
 * approval is checked by date instead (lib/approve-plan.ts).
 */
export function getAllPagePlans(): PagePlanExportRow[] {
  return openDb()
    .prepare(
      `SELECT plan_id, session_id, title, page_type, action,
              source_ids, existing_page_id, related_plan_ids,
              draft_content, draft_status, created_at, draft_rules,
              draft_error, used_source_ids
         FROM page_plans
        ORDER BY created_at`
    )
    .all() as PagePlanExportRow[];
}
