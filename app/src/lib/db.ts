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
  'page_links',
  'extractions',
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
  onboarding_session_id: string | null;
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
              file_path, status, date_ingested, metadata, onboarding_session_id
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
  db.prepare('DELETE FROM sources WHERE source_id = ?').run(sourceId);
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

export interface InsertEntityStubArgs {
  page_id: string;
  title: string;
  page_type: string;
  category: string;
  summary: string;
  content_path: string;
}

/**
 * Insert an entity/concept stub page created by Phase 3 entity expansion.
 *
 * Differs from insertPage():
 *   - Uses ON CONFLICT DO NOTHING (never overwrites a real compiled page).
 *   - Does NOT increment source_count (entity stubs start at 0; source_count
 *     rises when the full pipeline compiles a dedicated entity page later).
 *   - Also upserts pages_fts for the stub title so search finds it immediately.
 *
 * Safe to call outside a db.transaction() — Phase 3 is fire-and-forget.
 */
export function insertEntityStubPage(args: InsertEntityStubArgs): void {
  const db = openDb();
  db.prepare(
    `INSERT INTO pages (page_id, title, page_type, category, summary, content_path, source_count)
     VALUES (@page_id, @title, @page_type, @category, @summary, @content_path, 0)
     ON CONFLICT(page_id) DO NOTHING`
  ).run(args);

  // FTS index — only index if the row was actually inserted (changes() > 0).
  // Avoids overwriting a richer FTS entry if a real compiled page already existed.
  const changesRow = db.prepare('SELECT changes() AS n').get() as { n: number } | null;
  if ((changesRow?.n ?? 0) > 0) {
    db.prepare(`DELETE FROM pages_fts WHERE page_id = ?`).run(args.page_id);
    db.prepare(`INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)`).run(
      args.page_id, args.title, args.summary
    );
  }
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
  const claimFn = db.transaction(() => {
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

    const result = db
      .prepare(
        `UPDATE sources
           SET compile_status = 'in_progress'
           WHERE source_id = ? AND compile_status = 'pending'`
      )
      .run(row.source_id);

    return result.changes > 0 ? row.source_id : null;
  });
  return claimFn();
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

// ============================================================================
// Wiki index helpers (commit 11)
// ============================================================================

/** All compiled pages, newest first. Used by /wiki index and /api/pages. */
export function getAllPages(): PageRow[] {
  return openDb()
    .prepare(
      `SELECT page_id, title, page_type, category, summary, content_path,
              previous_content_path, last_updated, source_count, created_at
         FROM pages
         ORDER BY last_updated DESC`
    )
    .all() as PageRow[];
}

export interface CategoryGroup {
  category: string;
  pages: PageRow[];
}

/** Pages grouped by category, each group sorted newest-first. */
export function getCategoryGroups(): CategoryGroup[] {
  const rows = getAllPages();
  const map = new Map<string, PageRow[]>();
  for (const row of rows) {
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
 */
export function searchPages(query: string, limit = 20): PageRow[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  // Strip FTS5 special characters per word, then append * for prefix match.
  const ftsQuery = words
    .map((w) => w.replace(/['"*^():.,-]/g, '').trim())
    .filter(Boolean)
    .map((w) => `${w}*`)
    .join(' ');
  if (!ftsQuery.trim()) return [];
  return openDb()
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
}

/** Pages that link TO the given page_id (backlinks). */
export function getBacklinks(pageId: string): PageRow[] {
  return openDb()
    .prepare(
      `SELECT p.page_id, p.title, p.page_type, p.category, p.summary,
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

export function getWikiGraph(): GraphData {
  const db = openDb();
  const nodes = db
    .prepare(
      `SELECT page_id AS id, title AS label, page_type AS "group",
              COALESCE(category, 'Uncategorized') AS category, source_count
         FROM pages`
    )
    .all() as GraphNode[];

  const links = db
    .prepare(
      `SELECT source_page_id AS source, target_page_id AS target, link_type AS type
         FROM page_links`
    )
    .all() as GraphLink[];

  return { nodes, links };
}

/** Count of compiled wiki pages. Used by /api/compile/extract to determine wiki_exists. */
export function getPageCount(): number {
  const row = openDb()
    .prepare('SELECT COUNT(*) AS n FROM pages')
    .get() as { n: number };
  return row.n;
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

/**
 * Set compile_status = 'extracted' for a source after successful extraction.
 * Only updates rows that are in 'pending' or 'in_progress' status — safe to
 * call idempotently.
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

/**
 * Look up the canonical name for a given alias string (case-insensitive).
 * Returns null if the alias is not known.
 */
export function findAliasByName(name: string): string | null {
  const row = openDb()
    .prepare(
      'SELECT canonical_name FROM aliases WHERE alias = ? COLLATE NOCASE LIMIT 1'
    )
    .get(name) as { canonical_name: string } | undefined;
  return row?.canonical_name ?? null;
}
