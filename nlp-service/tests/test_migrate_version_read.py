"""scripts/migrate.py reads the stored schema_version before anything else.

Only a database without a settings table is new. Any other error reading the
version (the database locked, a disk error, a damaged file) must stop the
migration: read as version 0 it ran every step again, and the v6 step drops
and recreates the aliases table on a populated database.
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


class _VersionReadFails:
    """A connection whose schema_version read fails the way a locked database does."""

    def __init__(self, conn: sqlite3.Connection, error: str) -> None:
        self._conn = conn
        self._error = error

    def execute(self, sql: str, *args):
        if "schema_version" in sql and sql.lstrip().upper().startswith("SELECT"):
            raise sqlite3.OperationalError(self._error)
        return self._conn.execute(sql, *args)

    def __getattr__(self, name: str):
        return getattr(self._conn, name)


def _aliases(db_path: Path) -> list[tuple[str, str]]:
    conn = sqlite3.connect(db_path)
    try:
        return conn.execute("SELECT alias, canonical_name FROM aliases").fetchall()
    finally:
        conn.close()


def test_an_error_reading_the_version_stops_the_migration_and_keeps_the_aliases(migrate, monkeypatch):
    module, db_path = migrate
    module.migrate()
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT INTO aliases (alias, canonical_name) VALUES ('BTC', 'Bitcoin')")
    conn.commit()
    conn.close()

    real_connect = sqlite3.connect
    monkeypatch.setattr(
        module.sqlite3, "connect", lambda *a, **kw: _VersionReadFails(real_connect(*a, **kw), "database is locked")
    )
    with pytest.raises(sqlite3.OperationalError, match="database is locked"):
        module.migrate()
    monkeypatch.undo()

    assert _aliases(db_path) == [("BTC", "Bitcoin")]


def test_a_database_without_a_settings_table_is_new(migrate):
    module, db_path = migrate
    db_path.parent.mkdir(parents=True, exist_ok=True)
    sqlite3.connect(db_path).close()  # an empty database file

    module.migrate()

    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute("SELECT value FROM settings WHERE key = 'schema_version'").fetchone()
    finally:
        conn.close()
    assert row == (str(module.SCHEMA_VERSION),)
