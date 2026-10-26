"""scripts/migrate.py schema v30: the disagreements table (plan 3.4).

One record of the disagreements Kompl knows about on each page, whoever
found them (the page's own Disputed/Changed sections, the match triage, the
claim check, the whole-wiki check), with the owner's verdict. The table joined
the v30 step after v30 shipped, so a database already at v30 gets it on its
next boot. Exercised against real SQLite files: a fresh install, an upgrade
from v29, a v30 database without the table, reruns, the one-finding-per-key
rule and the cascades.
"""

from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path

import pytest

MIGRATE_PY = Path(__file__).resolve().parents[2] / "scripts" / "migrate.py"

pytestmark = pytest.mark.skipif(not MIGRATE_PY.exists(), reason="scripts/migrate.py is not in this checkout")

COLUMNS = {
    "disagreement_id", "page_id", "found_by", "kind", "status", "owner_verdict", "owner_verdict_at",
    "topic", "reason", "anchor", "source_a", "quote_a", "source_b", "quote_b", "source_ids",
    "match_key", "session_id", "created_at", "updated_at", "cleared_at",
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
    return {row[1] for row in conn.execute("PRAGMA table_info(disagreements)")}


def _old_database(db_path: Path, version: int) -> None:
    """The tables disagreements refers to, as an install at `version` has them."""
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
        INSERT INTO sources VALUES ('src-2', 'Another article');
        INSERT INTO pages VALUES ('page-1', 'Bitcoin');
        """
    )
    conn.commit()
    conn.close()


def _insert(conn: sqlite3.Connection, key: str = "src-2", found_by: str = "triage", source_b: str | None = "src-2") -> None:
    conn.execute(
        "INSERT INTO disagreements (disagreement_id, page_id, found_by, kind, match_key, source_b)"
        " VALUES (?, 'page-1', ?, 'contradiction', ?, ?)",
        (f"d-{key}-{found_by}", found_by, key, source_b),
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
    assert _columns(conn) == COLUMNS
    assert conn.execute("SELECT value FROM settings WHERE key = 'schema_version'").fetchone()[0] == "30"
    conn.close()


def test_reruns_keep_stored_rows_and_verdicts(migrate):
    module, db_path = migrate
    _old_database(db_path, 30)
    module.migrate()
    conn = _connect(db_path)
    _insert(conn)
    conn.execute("UPDATE disagreements SET status = 'dismissed', owner_verdict = 'dismissed'")
    conn.commit()
    conn.close()

    module.migrate()
    module.migrate()
    conn = _connect(db_path)
    assert conn.execute("SELECT status, owner_verdict FROM disagreements").fetchall() == [("dismissed", "dismissed")]
    conn.close()


def test_new_rows_default_to_possible_with_times(migrate):
    module, db_path = migrate
    _old_database(db_path, 29)
    module.migrate()
    conn = _connect(db_path)
    _insert(conn)
    row = conn.execute(
        "SELECT status, owner_verdict, source_ids, topic, created_at IS NOT NULL, updated_at IS NOT NULL, cleared_at"
        " FROM disagreements"
    ).fetchone()
    assert row == ("possible", None, "[]", "", 1, 1, None)
    conn.close()


def test_one_finding_per_page_finder_and_key(migrate):
    module, db_path = migrate
    _old_database(db_path, 29)
    module.migrate()
    conn = _connect(db_path)
    _insert(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO disagreements (disagreement_id, page_id, found_by, kind, match_key)"
            " VALUES ('other', 'page-1', 'triage', 'contradiction', 'src-2')"
        )
    # The same key from another finder is another finding.
    _insert(conn, found_by="claim_check")
    assert conn.execute("SELECT COUNT(*) FROM disagreements").fetchone()[0] == 2
    conn.close()


@pytest.mark.parametrize("table, key, value", [("sources", "source_id", "src-2"), ("pages", "page_id", "page-1")])
def test_deleting_the_page_or_a_side_removes_the_finding(migrate, table, key, value):
    module, db_path = migrate
    _old_database(db_path, 29)
    module.migrate()
    conn = _connect(db_path)
    _insert(conn)
    conn.execute(f"DELETE FROM {table} WHERE {key} = ?", (value,))
    conn.commit()
    assert conn.execute("SELECT COUNT(*) FROM disagreements").fetchone()[0] == 0
    conn.close()


def test_deleting_an_unrelated_source_keeps_page_text_findings(migrate):
    module, db_path = migrate
    _old_database(db_path, 29)
    module.migrate()
    conn = _connect(db_path)
    _insert(conn, key="d-1", found_by="page_text", source_b=None)
    conn.execute("DELETE FROM sources WHERE source_id = 'src-1'")
    conn.commit()
    assert conn.execute("SELECT COUNT(*) FROM disagreements").fetchone()[0] == 1
    conn.close()


def test_the_table_is_counted_in_the_create_table_statements(migrate):
    """scripts/check-schema-sync.sh counts CREATE TABLE in migrate.py against
    EXPECTED_TABLES in app/src/lib/db.ts; the boot-time create must not add a
    second statement."""
    text = MIGRATE_PY.read_text(encoding="utf-8")
    assert text.count("CREATE TABLE IF NOT EXISTS disagreements") == 1
