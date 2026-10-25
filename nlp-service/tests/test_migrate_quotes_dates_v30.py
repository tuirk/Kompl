"""scripts/migrate.py v30 step: relationship_mentions.quote and
quote_verified, and sources.published_at and published_at_source (plan
3.2), added without a new schema version.

Exercised against real SQLite files: a fresh install, an upgrade from v29,
a database already at v30 without the columns (they are added at boot), a
rerun, and the INSERT an older image still makes.
"""

from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path

import pytest

MIGRATE_PY = Path(__file__).resolve().parents[2] / "scripts" / "migrate.py"

pytestmark = pytest.mark.skipif(not MIGRATE_PY.exists(), reason="scripts/migrate.py is not in this checkout")

RELATION_COLUMNS = {"quote", "quote_verified"}
SOURCE_COLUMNS = {"published_at", "published_at_source"}


@pytest.fixture
def migrate(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("kompl_migrate", MIGRATE_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    db_path = tmp_path / "db" / "kompl.db"
    monkeypatch.setattr(module, "DB_PATH", str(db_path))
    return module, db_path


def _columns(conn: sqlite3.Connection, table: str) -> dict[str, int]:
    """name -> notnull."""
    return {row[1]: row[3] for row in conn.execute(f"PRAGMA table_info({table})")}


def _old_database(db_path: Path, version: int) -> None:
    """The tables the step touches, as an install at `version` has them, with a row each."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(
        f"""
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO settings (key, value) VALUES ('schema_version', '{version}');
        CREATE TABLE sources (
          source_id TEXT PRIMARY KEY, title TEXT NOT NULL, source_type TEXT NOT NULL,
          source_url TEXT, content_hash TEXT NOT NULL, file_path TEXT NOT NULL,
          status TEXT DEFAULT 'active', date_ingested DATETIME DEFAULT CURRENT_TIMESTAMP,
          metadata JSON, title_source TEXT, title_rescued_at TIMESTAMP
        );
        CREATE TABLE pages (page_id TEXT PRIMARY KEY, title TEXT NOT NULL);
        CREATE TABLE page_plans (plan_id TEXT PRIMARY KEY, base_version TEXT, used_source_ids TEXT);
        CREATE TABLE relationship_mentions (
          from_canonical TEXT NOT NULL COLLATE NOCASE,
          to_canonical TEXT NOT NULL COLLATE NOCASE,
          relationship_type TEXT NOT NULL,
          source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
          first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          description TEXT,
          PRIMARY KEY (from_canonical, to_canonical, relationship_type, source_id)
        );
        INSERT INTO sources (source_id, title, source_type, content_hash, file_path)
        VALUES ('src-1', 'An article', 'url', 'h', '/data/raw/src-1.md.gz');
        INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id, description)
        VALUES ('Bitcoin', 'Proof of work', 'uses', 'src-1', 'Bitcoin uses proof of work.');
        """
    )
    conn.commit()
    conn.close()


def test_schema_version_stays_30(migrate):
    module, _ = migrate
    assert module.SCHEMA_VERSION == 30


def test_fresh_install_has_nullable_relation_quotes(migrate):
    module, db_path = migrate
    module.migrate()
    conn = sqlite3.connect(db_path)
    cols = _columns(conn, "relationship_mentions")
    assert {c: cols.get(c) for c in RELATION_COLUMNS} == {"quote": 0, "quote_verified": 0}
    cols = _columns(conn, "sources")
    assert {c: cols.get(c) for c in SOURCE_COLUMNS} == {"published_at": 0, "published_at_source": 0}
    conn.close()


@pytest.mark.parametrize("version", [29, 30])
def test_an_old_database_gets_the_columns_and_keeps_its_rows(migrate, version):
    """v29 through the v30 step; a database already at v30 on the early path."""
    module, db_path = migrate
    _old_database(db_path, version)
    module.migrate()
    conn = sqlite3.connect(db_path)
    assert conn.execute("SELECT value FROM settings WHERE key = 'schema_version'").fetchone()[0] == "30"
    assert RELATION_COLUMNS <= set(_columns(conn, "relationship_mentions"))
    assert conn.execute("SELECT description, quote, quote_verified FROM relationship_mentions").fetchall() == [
        ("Bitcoin uses proof of work.", None, None)
    ]
    assert SOURCE_COLUMNS <= set(_columns(conn, "sources"))
    assert conn.execute("SELECT title, published_at, published_at_source FROM sources").fetchall() == [
        ("An article", None, None)
    ]
    conn.close()

    module.migrate()  # a rerun changes nothing
    conn = sqlite3.connect(db_path)
    assert list(_columns(conn, "relationship_mentions")).count("quote") == 1
    assert list(_columns(conn, "sources")).count("published_at") == 1
    conn.close()


def test_an_older_image_still_writes_relations(migrate):
    module, db_path = migrate
    _old_database(db_path, 29)
    module.migrate()
    conn = sqlite3.connect(db_path)
    # The v29 app's own statement, which never names the new columns.
    conn.execute(
        """INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id, description)
           VALUES ('Bitcoin', 'Satoshi', 'created_by', 'src-1', 'Satoshi made it.')"""
    )
    conn.commit()
    assert conn.execute(
        "SELECT quote, quote_verified FROM relationship_mentions WHERE to_canonical = 'Satoshi'"
    ).fetchone() == (None, None)
    conn.execute(
        """INSERT INTO sources (source_id, title, source_type, source_url, content_hash, file_path, status, metadata)
           VALUES ('src-2', 'A note', 'text', NULL, 'h2', '/data/raw/src-2.md.gz', 'active', NULL)"""
    )
    conn.commit()
    assert conn.execute(
        "SELECT published_at, published_at_source FROM sources WHERE source_id = 'src-2'"
    ).fetchone() == (None, None)
    conn.close()
