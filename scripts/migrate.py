#!/usr/bin/env python3
"""Database migration runner for Kompl (ISS-002)."""

import os
import sys
try:
    import sqlite3
except ImportError:
    print("ERROR: sqlite3 not available. Use full python3, not python3-minimal.", file=sys.stderr)
    sys.exit(1)

DB_PATH = os.environ.get("DB_PATH", os.path.join("data", "db", "kompl.db"))

SCHEMA_VERSION = 7

SCHEMA_SQL = """
-- Sources: raw ingested content metadata
CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT,
  content_hash TEXT NOT NULL,
  file_path TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  date_ingested DATETIME DEFAULT CURRENT_TIMESTAMP,
  metadata JSON
);

-- Pages: compiled wiki pages
CREATE TABLE IF NOT EXISTS pages (
  page_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  page_type TEXT NOT NULL,
  category TEXT,
  summary TEXT,
  content_path TEXT NOT NULL,
  previous_content_path TEXT,
  last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
  source_count INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Provenance: source → page relationships
CREATE TABLE IF NOT EXISTS provenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  page_id TEXT NOT NULL REFERENCES pages(page_id),
  content_hash TEXT NOT NULL,
  date_compiled DATETIME DEFAULT CURRENT_TIMESTAMP,
  contribution_type TEXT NOT NULL
);

-- Drafts: pending wiki page changes
CREATE TABLE IF NOT EXISTS drafts (
  draft_id TEXT PRIMARY KEY,
  page_id TEXT,
  draft_content TEXT NOT NULL,
  draft_type TEXT NOT NULL,
  source_id TEXT,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Activity log: chronological event history
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  action_type TEXT NOT NULL,
  source_id TEXT,
  details JSON
);

-- Aliases: entity name mappings for deduplication
CREATE TABLE IF NOT EXISTS aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias TEXT NOT NULL,
  canonical_page_id TEXT NOT NULL REFERENCES pages(page_id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Settings: key-value store
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sources_status ON sources(status);
CREATE INDEX IF NOT EXISTS idx_sources_type ON sources(source_type);
CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(page_type);
CREATE INDEX IF NOT EXISTS idx_pages_category ON pages(category);
CREATE INDEX IF NOT EXISTS idx_provenance_source ON provenance(source_id);
CREATE INDEX IF NOT EXISTS idx_provenance_page ON provenance(page_id);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);
CREATE INDEX IF NOT EXISTS idx_drafts_page ON drafts(page_id);
CREATE INDEX IF NOT EXISTS idx_activity_action ON activity_log(action_type);
CREATE INDEX IF NOT EXISTS idx_activity_source ON activity_log(source_id);
CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON activity_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);
CREATE INDEX IF NOT EXISTS idx_aliases_page ON aliases(canonical_page_id);
"""

FTS_SQL = """
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  page_id,
  title,
  content
);
"""


MIGRATION_V2_SQL = """
ALTER TABLE sources ADD COLUMN compile_status TEXT DEFAULT 'pending';
ALTER TABLE sources ADD COLUMN compile_attempts INTEGER DEFAULT 0;
ALTER TABLE sources ADD COLUMN compile_next_eligible_at DATETIME;
"""

MIGRATION_V2_INDEXES_SQL = """
DROP INDEX IF EXISTS idx_sources_compile_status;
CREATE INDEX IF NOT EXISTS idx_sources_compile_status_date ON sources(compile_status, date_ingested);
"""

MIGRATION_V3_SQL = """
CREATE TABLE IF NOT EXISTS page_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_page_id TEXT NOT NULL REFERENCES pages(page_id),
  target_page_id TEXT NOT NULL REFERENCES pages(page_id),
  link_type TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
"""

MIGRATION_V3_INDEXES_SQL = """
CREATE INDEX IF NOT EXISTS idx_page_links_source ON page_links(source_page_id);
CREATE INDEX IF NOT EXISTS idx_page_links_target ON page_links(target_page_id);
"""

MIGRATION_V4_SQL = "ALTER TABLE sources ADD COLUMN onboarding_session_id TEXT"

MIGRATION_V4_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_sources_session ON sources(onboarding_session_id);
"""

MIGRATION_V5_SQL = """
CREATE TABLE IF NOT EXISTS extractions (
  source_id TEXT PRIMARY KEY REFERENCES sources(source_id),
  ner_output JSON NOT NULL,
  profile TEXT NOT NULL,
  keyphrase_output JSON,
  tfidf_output JSON,
  llm_output JSON NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
"""

MIGRATION_V5_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_extractions_source ON extractions(source_id);
"""

MIGRATION_V6_SQL = """
DROP TABLE IF EXISTS aliases;
CREATE TABLE aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alias TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  canonical_page_id TEXT REFERENCES pages(page_id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);
CREATE INDEX IF NOT EXISTS idx_aliases_canonical ON aliases(canonical_name);
"""

MIGRATION_V7_SQL = """
CREATE TABLE IF NOT EXISTS page_plans (
  plan_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  page_type TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'create',
  source_ids JSON NOT NULL,
  existing_page_id TEXT,
  related_plan_ids JSON,
  draft_content TEXT,
  draft_status TEXT DEFAULT 'planned',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_page_plans_session ON page_plans(session_id);
CREATE INDEX IF NOT EXISTS idx_page_plans_status ON page_plans(draft_status);
"""


def migrate():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")

    # Check current version
    try:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = 'schema_version'"
        ).fetchone()
        current = int(row[0]) if row else 0
    except sqlite3.OperationalError:
        current = 0

    if current >= SCHEMA_VERSION:
        print(f"Database already at version {current}, nothing to do.")
        conn.close()
        return

    print(f"Migrating database to version {SCHEMA_VERSION}...")

    if current < 1:
        conn.executescript(SCHEMA_SQL)
        conn.executescript(FTS_SQL)

    if current < 2:
        print("  applying migration v2 (compile_status columns)...")
        # ALTER TABLE is not idempotent — check if columns already exist first.
        existing_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(sources)").fetchall()
        }
        for stmt in MIGRATION_V2_SQL.strip().split(";"):
            stmt = stmt.strip()
            if not stmt:
                continue
            # Extract column name from "ALTER TABLE sources ADD COLUMN <name> ..."
            col_name = stmt.split("ADD COLUMN")[1].strip().split()[0]
            if col_name not in existing_cols:
                conn.execute(stmt)
        conn.executescript(MIGRATION_V2_INDEXES_SQL)

    if current < 3:
        print("  applying migration v3 (page_links table)...")
        conn.executescript(MIGRATION_V3_SQL)
        conn.executescript(MIGRATION_V3_INDEXES_SQL)

    if current < 4:
        print("  applying migration v4 (onboarding_session_id column)...")
        existing_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(sources)").fetchall()
        }
        if "onboarding_session_id" not in existing_cols:
            conn.execute(MIGRATION_V4_SQL)
        conn.executescript(MIGRATION_V4_INDEX_SQL)

    if current < 5:
        print("  applying migration v5 (extractions table)...")
        conn.executescript(MIGRATION_V5_SQL)
        conn.executescript(MIGRATION_V5_INDEX_SQL)

    if current < 6:
        print("  applying migration v6 (rebuild aliases: add canonical_name, drop NOT NULL on canonical_page_id)...")
        conn.executescript(MIGRATION_V6_SQL)

    if current < 7:
        print("  applying migration v7 (page_plans table)...")
        conn.executescript(MIGRATION_V7_SQL)

    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
        ("schema_version", str(SCHEMA_VERSION)),
    )
    conn.commit()

    # Verify
    tables = [
        r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
    ]
    print(f"Tables: {', '.join(tables)}")
    print(f"Migration to version {SCHEMA_VERSION} complete.")

    conn.close()


if __name__ == "__main__":
    migrate()
