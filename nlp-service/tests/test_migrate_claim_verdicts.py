"""scripts/migrate.py schema v30: the claim_verdicts table (plan 3.3, 3.6).

The claim check judges each pair of claims once and keeps the verdict here,
so neither a later compile nor the whole-wiki check asks again. The table
joined the v30 step after v30 shipped, so a database already at v30 gets it
on its next boot. Exercised against real SQLite files: a fresh install, an
upgrade from v29, a v30 database without the table, reruns, one verdict per
pair and the cascades.
"""

from __future__ import annotations

import importlib.util
import sqlite3
from pathlib import Path

import pytest

MIGRATE_PY = Path(__file__).resolve().parents[2] / "scripts" / "migrate.py"

pytestmark = pytest.mark.skipif(not MIGRATE_PY.exists(), reason="scripts/migrate.py is not in this checkout")

COLUMNS = {
    "pair_key", "source_a", "claim_a", "source_b", "claim_b", "subject", "verdict", "topic",
    "reason", "newer", "found_by", "model", "session_id", "judged_at",
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
    return {row[1] for row in conn.execute("PRAGMA table_info(claim_verdicts)")}


def _old_database(db_path: Path, version: int) -> None:
    """The tables claim_verdicts refers to, as an install at `version` has them."""
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
        INSERT INTO sources VALUES ('src-3', 'A third article');
        """
    )
    conn.commit()
    conn.close()


def _insert(conn: sqlite3.Connection, key: str = "k1|k2", a: str = "src-1", b: str = "src-2") -> None:
    conn.execute(
        "INSERT INTO claim_verdicts (pair_key, source_a, claim_a, source_b, claim_b, verdict, found_by)"
        " VALUES (?, ?, 'Launched in 2008.', ?, 'Launched in 2009.', 'disputed', 'claim_check')",
        (key, a, b),
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


def test_reruns_keep_saved_verdicts(migrate):
    module, db_path = migrate
    _old_database(db_path, 30)
    module.migrate()
    conn = _connect(db_path)
    _insert(conn)
    conn.close()

    module.migrate()
    module.migrate()
    conn = _connect(db_path)
    assert conn.execute("SELECT pair_key, verdict FROM claim_verdicts").fetchall() == [("k1|k2", "disputed")]
    conn.close()


def test_new_rows_get_defaults(migrate):
    module, db_path = migrate
    _old_database(db_path, 29)
    module.migrate()
    conn = _connect(db_path)
    _insert(conn)
    row = conn.execute(
        "SELECT subject, topic, reason, newer, model, session_id, judged_at IS NOT NULL FROM claim_verdicts"
    ).fetchone()
    assert row == ("", "", None, None, None, None, 1)
    conn.close()


def test_one_verdict_per_pair(migrate):
    module, db_path = migrate
    _old_database(db_path, 29)
    module.migrate()
    conn = _connect(db_path)
    _insert(conn)
    with pytest.raises(sqlite3.IntegrityError):
        _insert(conn, a="src-2", b="src-1")
    conn.close()


@pytest.mark.parametrize("source", ["src-1", "src-2"])
def test_deleting_either_source_removes_the_verdict(migrate, source):
    module, db_path = migrate
    _old_database(db_path, 29)
    module.migrate()
    conn = _connect(db_path)
    _insert(conn)
    _insert(conn, key="k3|k4", a="src-2", b="src-3")
    conn.execute("DELETE FROM sources WHERE source_id = ?", (source,))
    conn.commit()
    left = {row[0] for row in conn.execute("SELECT pair_key FROM claim_verdicts")}
    # src-2 is a side of both pairs; src-1 only of the first.
    assert left == (set() if source == "src-2" else {"k3|k4"})
    conn.close()


def test_the_table_is_counted_in_the_create_table_statements(migrate):
    """scripts/check-schema-sync.sh counts CREATE TABLE in migrate.py against
    EXPECTED_TABLES in app/src/lib/db.ts; the boot-time create must not add a
    second statement."""
    text = MIGRATE_PY.read_text(encoding="utf-8")
    assert text.count("CREATE TABLE IF NOT EXISTS claim_verdicts") == 1
