"""scripts/migrate.py v30 step: ingest_failures.attempts (one Saved Links
row per link, issue #139), added without a new schema version.

Exercised against real SQLite files: a fresh install, an upgrade from v29,
a database already at v30 without the column (it is added at boot), a
rerun, and the INSERT an older image still makes.
"""

from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path

import pytest

MIGRATE_PY = Path(__file__).resolve().parents[2] / "scripts" / "migrate.py"

pytestmark = pytest.mark.skipif(not MIGRATE_PY.exists(), reason="scripts/migrate.py is not in this checkout")


@pytest.fixture
def migrate(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("kompl_migrate", MIGRATE_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    db_path = tmp_path / "db" / "kompl.db"
    monkeypatch.setattr(module, "DB_PATH", str(db_path))
    return module, db_path


def _columns(conn: sqlite3.Connection, table: str) -> dict[str, tuple[int, object]]:
    """name -> (notnull, default)."""
    return {row[1]: (row[3], row[4]) for row in conn.execute(f"PRAGMA table_info({table})")}


def _old_database(db_path: Path, version: int) -> None:
    """The tables the step touches, as an install at `version` has them, with a failure row."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(
        f"""
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO settings (key, value) VALUES ('schema_version', '{version}');
        CREATE TABLE pages (page_id TEXT PRIMARY KEY, title TEXT NOT NULL);
        CREATE TABLE page_plans (plan_id TEXT PRIMARY KEY, base_version TEXT, used_source_ids TEXT);
        CREATE TABLE ingest_failures (
          failure_id TEXT PRIMARY KEY, source_url TEXT, title_hint TEXT, date_saved TEXT,
          date_attempted DATETIME DEFAULT CURRENT_TIMESTAMP, error TEXT NOT NULL,
          source_type TEXT NOT NULL DEFAULT 'url', resolved_source_id TEXT, metadata JSON, session_id TEXT
        );
        INSERT INTO ingest_failures (failure_id, source_url, error)
        VALUES ('f1', 'https://example.com/a', 'timeout');
        """
    )
    conn.commit()
    conn.close()


def test_fresh_install_counts_one_attempt_by_default(migrate):
    module, db_path = migrate
    module.migrate()
    conn = sqlite3.connect(db_path)
    assert _columns(conn, "ingest_failures")["attempts"] == (1, "1")
    conn.close()


@pytest.mark.parametrize("version", [29, 30])
def test_an_old_database_gets_the_column_and_keeps_its_rows(migrate, version):
    """v29 through the v30 step; a database already at v30 on the early path."""
    module, db_path = migrate
    _old_database(db_path, version)
    module.migrate()
    conn = sqlite3.connect(db_path)
    assert conn.execute("SELECT value FROM settings WHERE key = 'schema_version'").fetchone()[0] == "30"
    assert conn.execute("SELECT failure_id, attempts FROM ingest_failures").fetchall() == [("f1", 1)]
    conn.close()

    module.migrate()  # a rerun changes nothing
    conn = sqlite3.connect(db_path)
    assert list(_columns(conn, "ingest_failures")).count("attempts") == 1
    conn.close()


def test_an_older_image_still_writes_failures(migrate):
    module, db_path = migrate
    _old_database(db_path, 29)
    module.migrate()
    conn = sqlite3.connect(db_path)
    # The v29 app's own statement, which never names the column.
    conn.execute(
        """INSERT OR IGNORE INTO ingest_failures
             (failure_id, source_url, title_hint, date_saved, error, source_type, metadata, session_id)
           VALUES ('f2', 'https://example.com/a', NULL, NULL, 'blocked', 'url', NULL, 's1')"""
    )
    conn.commit()
    assert conn.execute("SELECT attempts FROM ingest_failures WHERE failure_id = 'f2'").fetchone() == (1,)
    conn.close()
