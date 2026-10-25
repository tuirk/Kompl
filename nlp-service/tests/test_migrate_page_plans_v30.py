"""scripts/migrate.py schema v30: page_plans.base_version.

An update draft waiting for approval records the version of the page it
read, so approving it can refuse when the page changed since. Exercised
here against real SQLite files: a fresh install, an upgrade from v29
(existing drafts get NULL, a second run changes nothing), a half-applied
step, and the INSERT an older image still makes.
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


def _plan_columns(conn: sqlite3.Connection) -> dict[str, int]:
    """name -> notnull for the page_plans table."""
    return {row[1]: row[3] for row in conn.execute("PRAGMA table_info(page_plans)")}


def _v29_database(db_path: Path, *, extra_plan_columns: str = "") -> None:
    """The tables the v30 step reads, as a v29 install has them, with a pending draft."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(
        f"""
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO settings (key, value) VALUES ('schema_version', '29');
        CREATE TABLE page_plans (
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
          draft_error TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          draft_rules TEXT{extra_plan_columns}
        );
        INSERT INTO page_plans (plan_id, session_id, title, page_type, action, source_ids, existing_page_id,
                                draft_content, draft_status)
        VALUES ('p1', 's1', 'APCA', 'entity', 'update', '["src-1"]', 'apca', 'text', 'pending_approval');
        """
    )
    conn.commit()
    conn.close()


def test_schema_version_is_30(migrate):
    module, _ = migrate
    assert module.SCHEMA_VERSION == 30


def test_fresh_install_has_a_nullable_base_version(migrate):
    module, db_path = migrate
    module.migrate()
    conn = sqlite3.connect(db_path)
    assert _plan_columns(conn).get("base_version") == 0
    conn.close()


def test_v29_upgrade_leaves_pending_drafts_null_and_reruns_change_nothing(migrate):
    module, db_path = migrate
    _v29_database(db_path)

    module.migrate()
    conn = sqlite3.connect(db_path)
    assert conn.execute("SELECT value FROM settings WHERE key = 'schema_version'").fetchone()[0] == "30"
    assert conn.execute("SELECT draft_status, base_version FROM page_plans").fetchall() == [("pending_approval", None)]
    conn.close()

    module.migrate()  # already at v30: nothing to do
    conn = sqlite3.connect(db_path)
    assert list(_plan_columns(conn)).count("base_version") == 1
    conn.close()


def test_a_half_applied_step_completes(migrate):
    module, db_path = migrate
    _v29_database(db_path, extra_plan_columns=",\n          base_version TEXT")
    module.migrate()
    conn = sqlite3.connect(db_path)
    assert "base_version" in _plan_columns(conn)
    conn.close()


def test_an_older_image_still_writes_drafts(migrate):
    module, db_path = migrate
    _v29_database(db_path)
    module.migrate()
    conn = sqlite3.connect(db_path)
    # The v29 app's own statements, unchanged.
    conn.execute(
        "INSERT INTO page_plans (plan_id, session_id, title, page_type, action, source_ids) VALUES (?, ?, ?, ?, ?, ?)",
        ("p2", "s2", "Gemini", "entity", "create", "[]"),
    )
    conn.execute(
        "UPDATE page_plans SET draft_content = ?, draft_status = 'drafted', draft_rules = ? WHERE plan_id = ?",
        ("draft", "v0.4", "p2"),
    )
    assert conn.execute("SELECT base_version FROM page_plans WHERE plan_id = 'p2'").fetchone() == (None,)
    conn.close()
