"""Upgrading a database made by the last release (v0.3.2.1, schema v25).

The fixture is that release's own scripts/migrate.py, kept verbatim, so this
test builds exactly the database a user has today and runs the current
migrate.py on it once: every table and column the app needs must exist
afterwards, and a second run must change nothing.
"""

from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path

import pytest

HERE = Path(__file__).parent
RELEASE_MIGRATE = HERE / "fixtures" / "migrate_v0_3_2_1.py"
CURRENT_MIGRATE = HERE.parent.parent / "scripts" / "migrate.py"


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def _tables(conn: sqlite3.Connection) -> set[str]:
    return {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}


@pytest.fixture
def release_db(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_ROOT", str(tmp_path))
    db_path = tmp_path / "db" / "kompl.db"
    release = _load(RELEASE_MIGRATE, "kompl_migrate_release")
    monkeypatch.setattr(release, "DB_PATH", str(db_path))
    release.migrate()
    conn = sqlite3.connect(db_path)
    assert conn.execute("SELECT value FROM settings WHERE key='schema_version'").fetchone() == ("25",)
    # A user's data: one source, one page, one alias, one relation.
    conn.execute("INSERT INTO sources (source_id, title, source_type, content_hash, file_path) VALUES ('s1','S','url','h','raw/s1.md.gz')")
    conn.execute("INSERT INTO pages (page_id, title, page_type, content_path) VALUES ('p1','P','entity','pages/p1.md.gz')")
    conn.execute("INSERT INTO aliases (alias, canonical_name, canonical_page_id) VALUES ('ETH','P','p1')")
    conn.execute("INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id) VALUES ('P','Q','uses','s1')")
    conn.commit()
    conn.close()
    return db_path


def test_one_run_takes_a_release_database_to_the_current_schema(release_db, monkeypatch):
    current = _load(CURRENT_MIGRATE, "kompl_migrate_current")
    monkeypatch.setattr(current, "DB_PATH", str(release_db))
    current.migrate()

    conn = sqlite3.connect(release_db)
    assert conn.execute("SELECT value FROM settings WHERE key='schema_version'").fetchone() == (str(current.SCHEMA_VERSION),)
    assert {"triage_rechecks", "disagreements", "claim_verdicts"} <= _tables(conn)
    assert {"draft_rules"} <= _columns(conn, "pages")
    assert {"draft_rules", "base_version", "used_source_ids"} <= _columns(conn, "page_plans")
    assert {"description", "quote", "quote_verified"} <= _columns(conn, "relationship_mentions")
    assert {"method", "score", "session_id", "status", "status_reason", "status_at"} <= _columns(conn, "aliases")
    assert {"published_at", "published_at_source"} <= _columns(conn, "sources")
    # An existing install keeps the model it compiled on.
    assert conn.execute("SELECT value FROM settings WHERE key='compile_model'").fetchone() == ("gemini-2.5-flash",)
    # The user's rows are all still there; the old alias reads as active.
    assert conn.execute("SELECT status FROM aliases WHERE alias='ETH'").fetchone() == ("active",)
    assert conn.execute("SELECT COUNT(*) FROM relationship_mentions").fetchone() == (1,)
    conn.close()


def test_a_second_run_changes_nothing(release_db, monkeypatch, capsys):
    current = _load(CURRENT_MIGRATE, "kompl_migrate_current")
    monkeypatch.setattr(current, "DB_PATH", str(release_db))
    current.migrate()
    capsys.readouterr()
    current.migrate()
    assert "nothing to do" in capsys.readouterr().out
