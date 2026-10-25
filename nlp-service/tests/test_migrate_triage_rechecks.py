"""scripts/migrate.py schema v30: the triage_rechecks table.

A match triage that gave no verdict (rate limit, daily cost ceiling, error)
is kept as a (source, page) pair so a later compile can check it again. The
table joined the v30 step after v30 shipped, so a database already at v30
gets it on its next boot. Exercised here against real SQLite files: a fresh
install, an upgrade from v29, a v30 database without the table, reruns, and
the cascade that removes a pair with its source or page.
"""

from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path

import pytest

MIGRATE_PY = Path(__file__).resolve().parents[2] / "scripts" / "migrate.py"

pytestmark = pytest.mark.skipif(not MIGRATE_PY.exists(), reason="scripts/migrate.py is not in this checkout")

COLUMNS = {
    "source_id", "page_id", "reason", "attempts", "first_failed_at", "last_failed_at",
    "session_id", "verdict", "verdict_reason", "verdict_session_id",
}


@pytest.fixture
def migrate(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("kompl_migrate", MIGRATE_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    db_path = tmp_path / "db" / "kompl.db"
    monkeypatch.setattr(module, "DB_PATH", str(db_path))
    return module, db_path


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _columns(conn: sqlite3.Connection) -> set[str]:
    return {row[1] for row in conn.execute("PRAGMA table_info(triage_rechecks)")}


def _has_table(conn: sqlite3.Connection) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'triage_rechecks'"
    ).fetchone() is not None


def _old_database(db_path: Path, version: int) -> None:
    """The tables triage_rechecks refers to, as an install at `version` has them."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(
        f"""
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO settings (key, value) VALUES ('schema_version', '{version}');
        CREATE TABLE sources (source_id TEXT PRIMARY KEY, title TEXT NOT NULL);
        CREATE TABLE pages (page_id TEXT PRIMARY KEY, title TEXT NOT NULL);
        CREATE TABLE page_plans (plan_id TEXT PRIMARY KEY, base_version TEXT);
        INSERT INTO sources VALUES ('src-1', 'An article');
        INSERT INTO pages VALUES ('page-1', 'Bitcoin');
        """
    )
    conn.commit()
    conn.close()


def _insert_pair(conn: sqlite3.Connection, source_id: str = "src-1", page_id: str = "page-1") -> None:
    conn.execute(
        "INSERT INTO triage_rechecks (source_id, page_id, reason, attempts, session_id) VALUES (?, ?, ?, ?, ?)",
        (source_id, page_id, "triage_error", 1, "sess-1"),
    )
    conn.commit()


def test_fresh_install_has_the_table(migrate):
    module, db_path = migrate
    module.migrate()
    conn = _connect(db_path)
    assert _columns(conn) == COLUMNS
    conn.close()


def test_v29_upgrade_adds_the_table(migrate):
    module, db_path = migrate
    _old_database(db_path, 29)
    module.migrate()
    conn = _connect(db_path)
    assert conn.execute("SELECT value FROM settings WHERE key = 'schema_version'").fetchone()[0] == "30"
    assert _columns(conn) == COLUMNS
    conn.close()


def test_a_v30_database_without_the_table_gets_it_at_boot(migrate):
    module, db_path = migrate
    _old_database(db_path, 30)
    module.migrate()
    conn = _connect(db_path)
    assert _has_table(conn)
    assert conn.execute("SELECT value FROM settings WHERE key = 'schema_version'").fetchone()[0] == "30"
    conn.close()


def test_reruns_keep_stored_pairs(migrate):
    module, db_path = migrate
    _old_database(db_path, 30)
    module.migrate()
    conn = _connect(db_path)
    _insert_pair(conn)
    conn.close()

    module.migrate()
    module.migrate()
    conn = _connect(db_path)
    assert conn.execute("SELECT source_id, page_id, attempts FROM triage_rechecks").fetchall() == [("src-1", "page-1", 1)]
    conn.close()


def test_new_pairs_default_their_times_and_attempts(migrate):
    module, db_path = migrate
    _old_database(db_path, 29)
    module.migrate()
    conn = _connect(db_path)
    conn.execute(
        "INSERT INTO triage_rechecks (source_id, page_id, reason, session_id) VALUES ('src-1', 'page-1', 'triage_error', 's')"
    )
    row = conn.execute(
        "SELECT attempts, first_failed_at IS NOT NULL, last_failed_at IS NOT NULL, verdict FROM triage_rechecks"
    ).fetchone()
    assert row == (1, 1, 1, None)
    conn.close()


@pytest.mark.parametrize("table, key, value", [("sources", "source_id", "src-1"), ("pages", "page_id", "page-1")])
def test_deleting_the_source_or_the_page_removes_the_pair(migrate, table, key, value):
    module, db_path = migrate
    _old_database(db_path, 29)
    module.migrate()
    conn = _connect(db_path)
    _insert_pair(conn)
    conn.execute(f"DELETE FROM {table} WHERE {key} = ?", (value,))
    conn.commit()
    assert conn.execute("SELECT COUNT(*) FROM triage_rechecks").fetchone()[0] == 0
    conn.close()


def test_the_table_is_counted_in_the_create_table_statements(migrate):
    """scripts/check-schema-sync.sh counts CREATE TABLE in migrate.py against
    EXPECTED_TABLES in app/src/lib/db.ts; the boot-time create must not add a
    second statement."""
    text = MIGRATE_PY.read_text(encoding="utf-8")
    assert text.count("CREATE TABLE IF NOT EXISTS triage_rechecks") == 1
