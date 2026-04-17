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
 * The Pass-5 three-phase commit pattern used by /api/onboarding/collect (and
 * /api/compile/commit) is:
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
 * tables). Used by /api/health to verify migration completed. The
 * integration test asserts this returns exactly 14 names.
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
  onboarding_session_id: string | null;
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
  compile_status?: 'pending' | 'collected';
  onboarding_session_id?: string | null;
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
          file_path, status, metadata, compile_status, onboarding_session_id)
       VALUES
         (@source_id, @title, @source_type, @source_url, @content_hash,
          @file_path, 'active', @metadata, @compile_status, @onboarding_session_id)`
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
              compile_status, compile_attempts, onboarding_session_id
         FROM sources
         WHERE source_id = ?`
    )
    .get(sourceId) as SourceRow | undefined;
  return row ?? null;
}


// ============================================================================
// Onboarding helpers (Part 1a)
// ============================================================================

/**
 * Fetch all sources in a given onboarding session that are still in the
 * 'collected' state. Used by /api/onboarding/review.
 */
export function getCollectedSources(sessionId: string): SourceRow[] {
  return openDb()
    .prepare(
      `SELECT source_id, title, source_type, source_url, content_hash,
              file_path, status, date_ingested, metadata, onboarding_session_id,
              compile_status, compile_attempts
         FROM sources
        WHERE onboarding_session_id = ?
          AND compile_status = 'collected'
        ORDER BY date_ingested ASC`
    )
    .all(sessionId) as SourceRow[];
}

/**
 * Transition collected sources to 'pending' so the compile drain picks them up.
 * Only updates rows that are still 'collected' — safe to call idempotently.
 */
export function markSourcesPending(sourceIds: string[]): void {
  if (sourceIds.length === 0) return;
  const placeholders = sourceIds.map(() => '?').join(', ');
  openDb()
    .prepare(
      `UPDATE sources SET compile_status = 'pending'
        WHERE source_id IN (${placeholders})
          AND compile_status = 'collected'`
    )
    .run(...sourceIds);
}

/**
 * Delete a source row and return its file_path for cleanup by the caller.
 * Returns null if the source does not exist.
 * Intended to be called INSIDE a db.transaction() callback (sync only).
 */
export function deleteSource(sourceId: string): string | null {
  const db = openDb();
  const row = db
    .prepare('SELECT file_path FROM sources WHERE source_id = ?')
    .get(sourceId) as { file_path: string } | null;
  if (!row) return null;
  // Must delete child rows before parent — foreign_keys = ON enforces this.
  db.prepare('DELETE FROM extractions WHERE source_id = ?').run(sourceId);
  db.prepare('DELETE FROM sources WHERE source_id = ?').run(sourceId);
  // Invalidate archived-page-ids cache — the deleted source's provenance rows
  // have been removed, which may change which pages are "all-archived".
  _archivedIdsCache = null;
  return row.file_path;
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
  contribution_type: string;
  date_compiled: string;
}

export function getAllProvenance(): ProvenanceRow[] {
  return openDb()
    .prepare('SELECT source_id, page_id, contribution_type, date_compiled FROM provenance')
    .all() as ProvenanceRow[];
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
 * Read and decompress a compiled wiki page. Used by /wiki/[page_id] server
 * component. Returns null if both the file and pending_content are missing.
 *
 * Falls back to pages.pending_content (raw TEXT) when the gzip file has not yet
 * been flushed to disk — covers the Phase 2→3a window and boot-reconciler lag.
 */
export function readPageMarkdown(pageId: string): string | null {
  const filePath = pagesFilePath(pageId);
  if (fs.existsSync(filePath)) {
    const gzipped = fs.readFileSync(filePath);
    return zlib.gunzipSync(gzipped).toString('utf-8');
  }
  // File not yet flushed — return in-flight content if available.
  const page = getPage(pageId);
  return page?.pending_content ?? null;
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
 * Each word in the query gets a trailing * for prefix matching so that
 * partial input like "cryp" matches "cryptocurrency". Uses parameterized
 * binding (no string interpolation) to eliminate SQL injection risk.
 *
 * Pass excludePageIds (e.g. getAllArchivedPageIds()) to post-filter results.
 * Post-filtering keeps FTS5 rank ordering intact — no subquery in the SQL.
 */
export function searchPages(query: string, limit = 20, excludePageIds?: Set<string>): PageRow[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  // Strip FTS5 special characters per word, then append * for prefix match.
  const ftsQuery = words
    .map((w) => w.replace(/['"*^():.,-]/g, '').trim())
    .filter(Boolean)
    .map((w) => `${w}*`)
    .join(' ');
  if (!ftsQuery.trim()) return [];
  const rows = openDb()
    .prepare(
      `SELECT p.page_id, p.title, p.page_type, p.category, p.summary,
              p.content_path, p.previous_content_path, p.last_updated,
              p.source_count, p.created_at
         FROM pages_fts f
         JOIN pages p ON p.page_id = f.page_id
        WHERE pages_fts MATCH ?
        ORDER BY rank
        LIMIT ?`
    )
    .all(ftsQuery, limit) as PageRow[];
  if (!excludePageIds || excludePageIds.size === 0) return rows;
  return rows.filter((r) => !excludePageIds.has(r.page_id));
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

/** Insert a page_links row (called from compile commit when wikilinks are parsed). */
export function insertPageLink(sourcePageId: string, targetPageId: string, linkType: 'wikilink' | 'provenance' | 'entity-ref'): void {
  openDb()
    .prepare(
      `INSERT OR IGNORE INTO page_links (source_page_id, target_page_id, link_type)
       VALUES (?, ?, ?)`
    )
    .run(sourcePageId, targetPageId, linkType);
}

/** Graph data for /api/wiki/graph — all pages as nodes, provenance as edges. */
export interface GraphNode {
  id: string;
  label: string;
  group: string;    // page_type
  category: string;
  source_count: number;
  summary?: string | null;
  last_updated?: string;
  archived?: boolean;  // true when all backing sources are archived (muted styling)
}

export interface GraphLink {
  source: string;
  target: string;
  type: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

export function getWikiGraph(includeArchived = false): GraphData {
  const db = openDb();
  const allNodes = db
    .prepare(
      `SELECT page_id AS id, title AS label, page_type AS "group",
              COALESCE(category, 'Uncategorized') AS category,
              source_count, summary, last_updated
         FROM pages
        ${includeArchived ? '' : "WHERE page_type != 'archived'"}`
    )
    .all() as GraphNode[];

  const archivedIds = getAllArchivedPageIds();
  let nodes: GraphNode[];
  if (includeArchived) {
    // Mark archived nodes for muted styling; include all
    nodes = allNodes.map((n) => archivedIds.has(n.id) ? { ...n, archived: true } : n);
  } else {
    nodes = allNodes.filter((n) => !archivedIds.has(n.id));
  }

  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const allLinks = db
    .prepare(
      `SELECT source_page_id AS source, target_page_id AS target, link_type AS type
         FROM page_links`
    )
    .all() as GraphLink[];
  // Only include links where both endpoints are visible nodes
  const links = allLinks.filter((l) => nodeIdSet.has(l.source) && nodeIdSet.has(l.target));

  return { nodes, links };
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

/** All settings rows except sensitive keys (Telegram token/chat_id). */
export function getExportableSettings(): Array<{ key: string; value: string }> {
  return openDb()
    .prepare(
      `SELECT key, value FROM settings
        WHERE key NOT IN ('digest_telegram_token', 'digest_telegram_chat_id')`
    )
    .all() as Array<{ key: string; value: string }>;
}

/**
 * Set compile_status = 'extracted' for a source after successful extraction.
 * Includes 'collected' so onboarding-path sources (which enter with that
 * status) actually transition — without it the UPDATE is a silent no-op for
 * every onboarding source.
 */
export function markSourceExtracted(sourceId: string): void {
  openDb()
    .prepare(
      `UPDATE sources
          SET compile_status = 'extracted'
        WHERE source_id = ?
          AND compile_status IN ('pending', 'in_progress', 'collected')`
    )
    .run(sourceId);
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
 * Batch-insert alias → canonical_name mappings in a single transaction.
 * The aliases table has no UNIQUE constraint on alias, so we load existing
 * aliases into a Set first and skip duplicates rather than relying on
 * INSERT OR IGNORE.
 */
export function bulkInsertAliases(
  aliases: Array<{ alias: string; canonical: string }>
): void {
  if (aliases.length === 0) return;
  const db = openDb();
  const existing = new Set(
    (db.prepare('SELECT alias FROM aliases').all() as { alias: string }[]).map(
      (r) => r.alias.toLowerCase()
    )
  );
  const insert = db.prepare(
    'INSERT INTO aliases (alias, canonical_name) VALUES (?, ?)'
  );
  db.transaction((rows: typeof aliases) => {
    for (const { alias, canonical } of rows) {
      if (!existing.has(alias.toLowerCase())) {
        insert.run(alias, canonical);
        existing.add(alias.toLowerCase());
      }
    }
  })(aliases);
}

/**
 * Return all known alias → canonical_name pairs (for passing to Layer 1
 * fuzzy resolution as existing_aliases).
 */
export function getAliases(): Array<{ alias: string; canonical_name: string }> {
  return openDb()
    .prepare(
      'SELECT alias, canonical_name FROM aliases WHERE canonical_name IS NOT NULL'
    )
    .all() as Array<{ alias: string; canonical_name: string }>;
}

/** All alias rows including canonical_page_id — used for kompl backup export. */
export function getAllAliases(): Array<{ alias: string; canonical_name: string; canonical_page_id: string | null }> {
  return openDb()
    .prepare('SELECT alias, canonical_name, canonical_page_id FROM aliases')
    .all() as Array<{ alias: string; canonical_name: string; canonical_page_id: string | null }>;
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
  created_at: string;
}

export function insertPagePlan(plan: {
  plan_id: string;
  session_id: string;
  title: string;
  page_type: string;
  action: string;
  source_ids: string[];
  existing_page_id?: string | null;
  related_plan_ids?: string[];
}): void {
  openDb()
    .prepare(
      `INSERT INTO page_plans
         (plan_id, session_id, title, page_type, action,
          source_ids, existing_page_id, related_plan_ids)
       VALUES
         (@plan_id, @session_id, @title, @page_type, @action,
          @source_ids, @existing_page_id, @related_plan_ids)`
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
    });
}

/**
 * Deletes all non-committed page_plans for a session before re-planning.
 * Makes the plan step idempotent on retry: stale 'planned', 'drafted',
 * 'crossreffed', and 'failed' rows from a prior failed run are cleared so
 * the draft step only sees plans from the current run.
 * Preserves 'committed' (already written to pages table),
 * 'pending_approval' (query-generated chat plans, separate lifecycle),
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
              draft_content, draft_status, created_at
         FROM page_plans
        WHERE session_id = ? AND draft_status = ?
        ORDER BY created_at ASC`
    )
    .all(sessionId, status) as PagePlanRow[];
}

export function updatePlanDraft(planId: string, draftContent: string): void {
  openDb()
    .prepare(
      `UPDATE page_plans
          SET draft_content = ?, draft_status = 'drafted'
        WHERE plan_id = ?`
    )
    .run(draftContent, planId);
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

const COMPILE_STEPS = ['extract', 'resolve', 'match', 'plan', 'draft', 'crossref', 'commit', 'schema'] as const;
type CompileStep = (typeof COMPILE_STEPS)[number];

const DEFAULT_STEPS = () =>
  Object.fromEntries(COMPILE_STEPS.map((s) => [s, { status: 'pending' }]));

export interface CompileProgressRow {
  session_id: string;
  status: string;
  current_step: string | null;
  steps: string; // JSON TEXT — parse to get step states
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

/**
 * Insert a compile_progress row for a session, or reset it if one already
 * exists (for retry). All steps start as 'pending', status as 'queued'.
 */
export function createCompileProgress(sessionId: string, sourceCount = 0): void {
  openDb()
    .prepare(
      `INSERT INTO compile_progress
         (session_id, status, current_step, steps, error, started_at, completed_at, source_count)
       VALUES (?, 'queued', NULL, ?, NULL, NULL, NULL, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         status       = 'queued',
         current_step = NULL,
         steps        = excluded.steps,
         error        = NULL,
         started_at   = NULL,
         completed_at = NULL,
         source_count = CASE WHEN excluded.source_count > 0 THEN excluded.source_count ELSE compile_progress.source_count END`
    )
    .run(sessionId, JSON.stringify(DEFAULT_STEPS()), sourceCount);
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
  step: string,
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
  if (status === 'running' && row.status === 'queued') {
    overallStatus = 'running';
    setStartedAt = ", started_at = CURRENT_TIMESTAMP";
  }
  if (status === 'failed') {
    overallStatus = 'failed';
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

/**
 * Mark all 'running' sessions older than olderThanMinutes as failed.
 * Called on server startup (health check) to recover from mid-pipeline crashes.
 * Uses datetime() wrapper on both sides per the SQLite timestamp comparison gotcha.
 * Returns the number of rows cleaned up.
 */
export function markStaleSessionsFailed(olderThanMinutes: number): number {
  const result = openDb()
    .prepare(
      `UPDATE compile_progress
          SET status = 'failed',
              error  = ?
        WHERE status = 'running'
          AND datetime(started_at) < datetime('now', ? || ' minutes')`
    )
    .run(
      `Pipeline interrupted — timed out after ${olderThanMinutes} minutes. Click Retry to rerun.`,
      `-${olderThanMinutes}`
    );
  return result.changes as number;
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
  const stepOrder = ['extract', 'resolve', 'match', 'plan', 'draft', 'crossref', 'commit', 'schema'];

  // Find the first non-done step
  let resetFrom = -1;
  for (let i = 0; i < stepOrder.length; i++) {
    if (steps[stepOrder[i]]?.status !== 'done') {
      resetFrom = i;
      break;
    }
  }

  if (resetFrom === -1) return; // all steps done — nothing to retry

  // Reset from the first non-done step forward
  for (let i = resetFrom; i < stepOrder.length; i++) {
    steps[stepOrder[i]] = { status: 'pending' };
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
 * Increment the source_count column of a page by the given amount.
 * Called after a provenance-only commit so source_count stays accurate.
 */
export function incrementPageSourceCount(pageId: string, increment: number): void {
  openDb()
    .prepare('UPDATE pages SET source_count = source_count + ? WHERE page_id = ?')
    .run(increment, pageId);
}

/**
 * Read the current gzipped page file and return its SHA-256 hex hash.
 * Returns '' if the file does not exist (first-write path — caller handles).
 * Synchronous so it can be called inside a db.transaction() callback.
 */
export function getCurrentPageHash(pageId: string): string {
  const filePath = path.join(PAGES_DIR, `${pageId}.md.gz`);
  if (!fs.existsSync(filePath)) return '';
  const data = fs.readFileSync(filePath);
  return createHash('sha256').update(data).digest('hex');
}

// ============================================================================
// Chat messages (commit 7)
// ============================================================================

export interface ChatMessageRow {
  id: number;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: string | null;   // JSON: Array<{page_id, page_title}>
  pages_used: string | null;  // JSON: string[]
  created_at: string;
}

export function insertChatMessage(data: {
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Array<{ page_id: string; page_title: string }>;
  pages_used?: string[];
}): void {
  openDb()
    .prepare(
      `INSERT INTO chat_messages (session_id, role, content, citations, pages_used)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      data.session_id,
      data.role,
      data.content,
      data.citations ? JSON.stringify(data.citations) : null,
      data.pages_used ? JSON.stringify(data.pages_used) : null,
    );
}

export function getChatHistory(sessionId: string, limit = 20): ChatMessageRow[] {
  return openDb()
    .prepare(
      `SELECT * FROM chat_messages
       WHERE session_id = ?
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(sessionId, limit) as ChatMessageRow[];
}

/**
 * Return all pages as a lightweight index for chat retrieval.
 * Sorted by source_count DESC so most-sourced pages appear first.
 * Excludes page_type='archived' and all-archived-sources pages by default.
 */
export function getPageIndex(): Array<{
  page_id: string;
  title: string;
  page_type: string;
  summary: string | null;
  category: string | null;
  source_count: number;
}> {
  type Row = { page_id: string; title: string; page_type: string; summary: string | null; category: string | null; source_count: number };
  const rows = openDb()
    .prepare(
      `SELECT page_id, title, page_type, summary, category, source_count
       FROM pages
       WHERE page_type != 'archived'
       ORDER BY source_count DESC`
    )
    .all() as Row[];
  const archivedIds = getAllArchivedPageIds();
  if (archivedIds.size === 0) return rows;
  return rows.filter((r) => !archivedIds.has(r.page_id));
}

/**
 * Insert a chat-compounding draft directly into page_plans.
 * Used when a chat answer synthesises 3+ pages — creates a
 * pending_approval draft for the user to review.
 */
export function insertChatDraft(data: {
  plan_id: string;
  session_id: string;
  title: string;
  draft_content: string;
  pages_used?: string[]; // page_ids that contributed to the answer
}): void {
  openDb()
    .prepare(
      `INSERT INTO page_plans
         (plan_id, session_id, title, page_type, action,
          source_ids, existing_page_id, related_plan_ids,
          draft_content, draft_status)
       VALUES (?, ?, ?, 'query-generated', 'create', ?, NULL, '[]', ?, 'pending_approval')`
    )
    .run(data.plan_id, data.session_id, data.title, JSON.stringify(data.pages_used ?? []), data.draft_content);
}

// ============================================================================
// Source management helpers (commit 8)
// ============================================================================

/**
 * Fetch all sources with optional filtering, sorting and pagination.
 * Used by GET /api/sources and the /sources list page.
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
    params.push(options.dateTo + 'T23:59:59');
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
  const limit = options?.limit ?? 200;
  const offset = options?.offset ?? 0;

  return openDb()
    .prepare(
      `SELECT source_id, title, source_type, source_url, content_hash,
              file_path, status, date_ingested, metadata, compile_status,
              compile_attempts, onboarding_session_id
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
 * Same as getAllSources but LEFT JOINs provenance to include page_count per source
 * in a single query, eliminating the N+1 pattern in GET /api/sources.
 */
export function getAllSourcesWithPageCounts(
  options?: Parameters<typeof getAllSources>[0]
): SourceWithPageCount[] {
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
    params.push(options.dateTo + 'T23:59:59');
  }
  if (options?.search) {
    conditions.push('s.title LIKE ?');
    params.push(`%${options.search}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
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
 * Return pages that have at least one provenance link from the given source.
 * Used by cascade delete to determine which pages are affected.
 */
export function getPagesBySourceId(sourceId: string): Array<{
  page_id: string;
  title: string;
  source_count: number;
}> {
  return openDb()
    .prepare(
      `SELECT p.page_id, p.title, p.source_count
         FROM pages p
         JOIN provenance pr ON p.page_id = pr.page_id
        WHERE pr.source_id = ?`
    )
    .all(sourceId) as Array<{ page_id: string; title: string; source_count: number }>;
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
 * Called when a delete cascade leaves a page with no remaining sources.
 */
export function archivePage(pageId: string): void {
  const db = openDb();
  db.prepare(`UPDATE pages SET page_type = 'archived' WHERE page_id = ?`).run(pageId);
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
 * Permanently delete a page from the DB (pages, FTS, page_links, aliases, provenance).
 * Wrapped in a transaction so all child-table cleanups are atomic — if any step
 * fails, no partial state is left. Deletion order respects FK constraints:
 * page_links + pages_fts first (no FK to pages), then aliases + provenance
 * (both REFERENCE pages), then the pages row itself.
 */
export function deletePage(pageId: string): void {
  const db = openDb();
  db.transaction(() => {
    db.prepare(`DELETE FROM page_links WHERE source_page_id = ? OR target_page_id = ?`).run(pageId, pageId);
    db.prepare(`DELETE FROM pages_fts WHERE page_id = ?`).run(pageId);
    db.prepare(`DELETE FROM aliases WHERE canonical_page_id = ?`).run(pageId);
    db.prepare(`DELETE FROM provenance WHERE page_id = ?`).run(pageId);
    db.prepare(`DELETE FROM pages WHERE page_id = ?`).run(pageId);
  })();
}

/**
 * Return the set of page_ids where ALL backing sources have status='archived'.
 * Zero-provenance pages are NOT included (HAVING COUNT(*) > 0 guard prevents
 * the degenerate 0=0 case from hiding pages with no provenance at all).
 *
 * Result is cached for 30s — this query runs on every chat message in hybrid
 * mode and is expensive (GROUP BY JOIN on provenance). Cache is invalidated by
 * setSourceStatus (archive/unarchive) and deleteSource (source removal).
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
 * Defaults to 100 if not set.
 */
export function getRelatedPagesMinSources(): number {
  const v = getSetting('related_pages_min_sources');
  return v !== null ? Math.max(0, parseInt(v, 10)) : 100;
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
}

export function insertIngestFailure(args: InsertIngestFailureArgs): void {
  openDb()
    .prepare(
      `INSERT OR IGNORE INTO ingest_failures
         (failure_id, source_url, title_hint, date_saved, error, source_type)
       VALUES
         (@failure_id, @source_url, @title_hint, @date_saved, @error, @source_type)`
    )
    .run({
      failure_id: args.failure_id,
      source_url: args.source_url ?? null,
      title_hint: args.title_hint ?? null,
      date_saved: args.date_saved ?? null,
      error: args.error,
      source_type: args.source_type ?? 'url',
    });
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
 */
export interface SavedLinkRow {
  source_url: string;
  title: string | null;
  date_saved: string | null;
  date_attempted: string;
  error: string;
  source_type: string;
}

export function getUnresolvedLinks(): SavedLinkRow[] {
  return openDb()
    .prepare(
      `SELECT source_url,
              title_hint  AS title,
              date_saved,
              date_attempted,
              error,
              source_type
         FROM ingest_failures
        WHERE resolved_source_id IS NULL
          AND source_url IS NOT NULL
        ORDER BY date_attempted DESC`
    )
    .all() as SavedLinkRow[];
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
 * Whether the scheduled lint pass (n8n every 6h) is enabled.
 * Defaults to true. When false, lint-pass/route.ts returns early immediately.
 * Manual trigger in settings bypasses this flag.
 */
export function getLintEnabled(): boolean {
  return getSetting('lint_enabled') !== '0';
}

export function setLintEnabled(value: boolean): void {
  setSetting('lint_enabled', value ? '1' : '0');
}

// ---------------------------------------------------------------------------
// Deployment mode
// ---------------------------------------------------------------------------

export function getDeploymentMode(): 'personal-device' | 'always-on' {
  const v = getSetting('deployment_mode');
  return v === 'always-on' ? 'always-on' : 'personal-device';
}

export function setDeploymentMode(v: 'personal-device' | 'always-on'): void {
  setSetting('deployment_mode', v);
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
// Weekly Digest settings helpers
// ============================================================================

export function getDigestSettings(): {
  enabled: boolean;
  telegram_token: string | null;
  telegram_chat_id: string | null;
} {
  return {
    enabled: getSetting('digest_enabled') === '1',
    telegram_token: getSetting('digest_telegram_token'),
    telegram_chat_id: getSetting('digest_telegram_chat_id'),
  };
}

export function setDigestSettings(data: {
  enabled?: boolean;
  telegram_token?: string;
  telegram_chat_id?: string;
}): void {
  if (data.enabled !== undefined) {
    setSetting('digest_enabled', data.enabled ? '1' : '0');
  }
  if (data.telegram_token !== undefined) {
    setSetting('digest_telegram_token', data.telegram_token);
  }
  if (data.telegram_chat_id !== undefined) {
    setSetting('digest_telegram_chat_id', data.telegram_chat_id);
  }
}

export interface ActivityRow {
  action_type: string;
  source_id: string | null;
  details: string | null;
  timestamp: string;
}

/**
 * Fetch all activity_log rows newer than `since` (ISO 8601 string).
 * Uses datetime() wrapping to avoid the SQLite lexicographic timestamp gotcha
 * (CURRENT_TIMESTAMP stores 'YYYY-MM-DD HH:MM:SS', not ISO 8601).
 */
export function getActivitySince(since: string): ActivityRow[] {
  return openDb()
    .prepare(
      `SELECT action_type, source_id, details, timestamp
       FROM activity_log
       WHERE datetime(timestamp) > datetime(?)
       ORDER BY timestamp DESC`
    )
    .all(since) as ActivityRow[];
}

// ============================================================================
// Wiki stats (commit 8 — meta query support in chat)
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
 * Quick stats snapshot for answering meta queries in chat ("how many sources?").
 * All reads are cheap index scans — no full table scans.
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

/**
 * Return a summary of what topics/categories are in the wiki.
 * Used by detectMetaQuery for "what topics does my wiki cover" questions.
 */
export function getPageCategories(): Array<{ category: string; page_type: string; count: number }> {
  return openDb()
    .prepare(
      `SELECT COALESCE(category, 'General') AS category, page_type, COUNT(*) AS count
         FROM pages
        GROUP BY category, page_type
        ORDER BY count DESC`
    )
    .all() as Array<{ category: string; page_type: string; count: number }>;
}

// ============================================================================
// Draft approval helpers (commit 8)
// ============================================================================

/**
 * Fetch all page_plans with draft_status = 'pending_approval'.
 * Used by GET /api/drafts/pending and the dashboard draft section.
 */
export function getPendingDrafts(): PagePlanRow[] {
  return openDb()
    .prepare(
      `SELECT plan_id, session_id, title, page_type, action,
              source_ids, existing_page_id, related_plan_ids,
              draft_content, draft_status, created_at
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
