#!/usr/bin/env python3
"""Database migration runner for Kompl (ISS-002)."""

import os
import sqlite3
import sys

DB_PATH = os.environ.get("DB_PATH", os.path.join("data", "db", "kompl.db"))

SCHEMA_VERSION = 1

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

    conn.executescript(SCHEMA_SQL)
    conn.executescript(FTS_SQL)

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
