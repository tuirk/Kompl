"""scripts/migrate.py v30 step: pages.restore_page_type and archive_reason
(a page archived until a failed rewrite succeeds, issue #8), added without
a new schema version.

Exercised against real SQLite files: a fresh install, an upgrade from v29,
a database already at v30 without the columns (they are added at boot), a
rerun, and the INSERTs an older image still makes.
"""

from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path

import pytest

MIGRATE_PY = Path(__file__).resolve().parents[2] / "scripts" / "migrate.py"

pytestmark = pytest.mark.skipif(not MIGRATE_PY.exists(), reason="scripts/migrate.py is not in this checkout")

PAGE_COLUMNS = {"restore_page_type", "archive_reason"}


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
    """The tables the step touches, as an install at `version` has them, with a row each."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(
        f"""
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO settings (key, value) VALUES ('schema_version', '{version}');
        CREATE TABLE pages (
          page_id TEXT PRIMARY KEY, title TEXT NOT NULL, page_type TEXT NOT NULL,
          category TEXT, summary TEXT, content_path TEXT NOT NULL, previous_content_path TEXT,
          last_updated DATETIME DEFAULT CURRENT_TIMESTAMP, source_count INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP, pending_content TEXT, draft_rules TEXT
        );
        CREATE TABLE page_plans (plan_id TEXT PRIMARY KEY, base_version TEXT, used_source_ids TEXT);
        INSERT INTO pages (page_id, title, page_type, content_path)
        VALUES ('bitcoin', 'Bitcoin', 'entity', '/data/pages/bitcoin.md.gz');
        """
    )
    conn.commit()
    conn.close()


def test_schema_version_stays_30(migrate):
    module, _ = migrate
    assert module.SCHEMA_VERSION == 30


def test_fresh_install_has_the_columns(migrate):
    module, db_path = migrate
    module.migrate()
    conn = sqlite3.connect(db_path)
    pages = _columns(conn, "pages")
    assert {c: pages[c][0] for c in PAGE_COLUMNS} == {"restore_page_type": 0, "archive_reason": 0}
    conn.close()


@pytest.mark.parametrize("version", [29, 30])
def test_an_old_database_gets_the_columns_and_keeps_its_rows(migrate, version):
    """v29 through the v30 step; a database already at v30 on the early path."""
    module, db_path = migrate
    _old_database(db_path, version)
    module.migrate()
    conn = sqlite3.connect(db_path)
    assert conn.execute("SELECT value FROM settings WHERE key = 'schema_version'").fetchone()[0] == "30"
    assert conn.execute("SELECT page_type, restore_page_type, archive_reason FROM pages").fetchall() == [
        ("entity", None, None)
    ]
    conn.close()

    module.migrate()  # a rerun changes nothing
    conn = sqlite3.connect(db_path)
    assert list(_columns(conn, "pages")).count("restore_page_type") == 1
    conn.close()


def test_an_older_image_still_writes_pages(migrate):
    module, db_path = migrate
    _old_database(db_path, 29)
    module.migrate()
    conn = sqlite3.connect(db_path)
    # The v29 app's own statements, which never name the new columns.
    conn.execute(
        """INSERT INTO pages (page_id, title, page_type, category, summary, content_path, previous_content_path, source_count)
           VALUES ('eth', 'Ethereum', 'entity', NULL, NULL, '/data/pages/eth.md.gz', NULL, 1)"""
    )
    conn.execute("UPDATE pages SET page_type = 'archived' WHERE page_id = 'eth'")
    conn.commit()
    assert conn.execute("SELECT restore_page_type, archive_reason FROM pages WHERE page_id = 'eth'").fetchone() == (
        None,
        None,
    )
    conn.close()
