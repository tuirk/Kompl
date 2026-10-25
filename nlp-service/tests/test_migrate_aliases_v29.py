"""scripts/migrate.py schema v29: alias records.

migrate.py runs in the app container, not here, but this is the suite CI
runs with Python, so its v29 step is exercised here against real SQLite
files: a fresh install, an upgrade from v28 (existing rows stay active, a
second run changes nothing), a half-applied step, and the INSERT an older
image still makes.
"""

from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path

import pytest

MIGRATE_PY = Path(__file__).resolve().parents[2] / "scripts" / "migrate.py"
NEW_COLUMNS = ["method", "score", "session_id", "status", "status_reason", "status_at"]

pytestmark = pytest.mark.skipif(not MIGRATE_PY.exists(), reason="scripts/migrate.py is not in this checkout")


@pytest.fixture
def migrate(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("kompl_migrate", MIGRATE_PY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    db_path = tmp_path / "db" / "kompl.db"
    monkeypatch.setattr(module, "DB_PATH", str(db_path))
    return module, db_path


def _columns(conn: sqlite3.Connection) -> dict[str, tuple[int, str | None]]:
    """name -> (notnull, default) for the aliases table."""
    return {row[1]: (row[3], row[4]) for row in conn.execute("PRAGMA table_info(aliases)")}


def _version(conn: sqlite3.Connection) -> str:
    return conn.execute("SELECT value FROM settings WHERE key = 'schema_version'").fetchone()[0]


def _v28_database(db_path: Path, *, extra_alias_columns: str = "") -> None:
    """The tables the v29 step reads, as a v28 install has them."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(
        f"""
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO settings (key, value) VALUES ('schema_version', '28');
        CREATE TABLE aliases (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          alias TEXT NOT NULL,
          canonical_name TEXT NOT NULL,
          canonical_page_id TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP{extra_alias_columns}
        );
        INSERT INTO aliases (alias, canonical_name) VALUES ('GPT 4', 'GPT-4');
        INSERT INTO aliases (alias, canonical_name, canonical_page_id) VALUES ('ETH', 'Ethereum', 'ethereum');
        """
    )
    conn.commit()
    conn.close()


def test_schema_version_is_29(migrate):
    module, _ = migrate
    assert module.SCHEMA_VERSION == 29


def test_fresh_install_has_the_alias_columns(migrate):
    module, db_path = migrate
    module.migrate()
    conn = sqlite3.connect(db_path)
    cols = _columns(conn)
    assert all(c in cols for c in NEW_COLUMNS)
    assert all(cols[c][0] == 0 for c in NEW_COLUMNS)  # all nullable
    assert cols["status"][1] == "'active'"
    assert _version(conn) == "29"
    conn.close()


def test_v28_upgrade_keeps_every_row_active_and_reruns_change_nothing(migrate):
    module, db_path = migrate
    _v28_database(db_path)

    module.migrate()
    conn = sqlite3.connect(db_path)
    assert _version(conn) == "29"
    rows = conn.execute(
        "SELECT alias, canonical_name, canonical_page_id, method, score, session_id, status, status_reason, status_at"
        " FROM aliases ORDER BY id"
    ).fetchall()
    assert rows == [
        ("GPT 4", "GPT-4", None, None, None, None, "active", None, None),
        ("ETH", "Ethereum", "ethereum", None, None, None, "active", None, None),
    ]
    conn.close()

    module.migrate()  # already at v29: nothing to do
    conn = sqlite3.connect(db_path)
    assert conn.execute("SELECT COUNT(*) FROM aliases WHERE status = 'active'").fetchone()[0] == 2
    conn.close()


def test_an_older_image_still_reads_and_writes_aliases(migrate):
    module, db_path = migrate
    _v28_database(db_path)
    module.migrate()
    conn = sqlite3.connect(db_path)
    # The v28 app's own statements, unchanged.
    conn.execute("INSERT INTO aliases (alias, canonical_name) VALUES (?, ?)", ("LLMs", "LLM"))
    conn.execute("INSERT OR IGNORE INTO aliases (alias, canonical_name, canonical_page_id) VALUES (?, ?, ?)",
                 ("BTC", "Bitcoin", None))
    read = conn.execute(
        "SELECT alias, canonical_name FROM aliases WHERE canonical_name IS NOT NULL ORDER BY id"
    ).fetchall()
    assert [a for a, _ in read] == ["GPT 4", "ETH", "LLMs", "BTC"]
    statuses = conn.execute("SELECT DISTINCT status FROM aliases").fetchall()
    assert statuses == [("active",)]
    conn.close()


def test_a_half_applied_step_completes(migrate):
    module, db_path = migrate
    _v28_database(db_path, extra_alias_columns=",\n          method TEXT,\n          score REAL")
    module.migrate()
    conn = sqlite3.connect(db_path)
    cols = _columns(conn)
    assert all(c in cols for c in NEW_COLUMNS)
    assert conn.execute("SELECT COUNT(*) FROM aliases WHERE status = 'active'").fetchone()[0] == 2
    conn.close()
