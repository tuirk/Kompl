#!/usr/bin/env bash
#
# Smoke test for migration V21 (purge of deployment_mode settings row).
#
# Asserts:
#   1. A V20-shaped DB containing a deployment_mode row, after running
#      migrate.py, ends up with the row removed and schema_version=21.
#   2. Idempotency — running migrate again on the V21 DB is a no-op (early
#      return because current >= SCHEMA_VERSION).
#
# Uses Python's stdlib sqlite3 instead of the sqlite3 CLI so it works on
# Windows shells (Git Bash / MSYS) without an extra dependency.
#
# Run from repo root: bash scripts/test_migrate_v21.sh
set -euo pipefail

# Pick a working Python 3 interpreter. On Windows, plain `python3` may resolve
# to a Microsoft Store stub that errors when invoked; prefer `python` if so.
detect_python() {
  for cand in python3 python py; do
    if command -v "$cand" >/dev/null 2>&1; then
      out=$("$cand" -c "import sys; print(sys.version_info[0])" 2>/dev/null || true)
      if [[ "$out" == "3" ]]; then
        echo "$cand"
        return 0
      fi
    fi
  done
  echo "ERROR: no working Python 3 interpreter found (tried python3, python, py)" >&2
  exit 2
}
PY=$(detect_python)

# Workdir + cleanup
WORKDIR=$(mktemp -d -t kompl-migrate-test-XXXXXX)
trap "rm -rf $WORKDIR" EXIT

DB_DIR="$WORKDIR/data/db"
DB_FILE="$DB_DIR/kompl.db"
mkdir -p "$DB_DIR"

# On Git Bash / MSYS, the POSIX-style /tmp/... path is meaningless to a
# native-Windows Python. Translate to a Windows path Python can open.
if command -v cygpath >/dev/null 2>&1; then
  DB_FILE_PY=$(cygpath -w "$DB_FILE")
else
  DB_FILE_PY="$DB_FILE"
fi

# Helper: run a sqlite query and print the scalar result.
# Pass DB path + SQL as argv to avoid heredoc / quote collisions.
sql() {
  "$PY" - "$DB_FILE_PY" "$1" <<'PY'
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
row = conn.execute(sys.argv[2]).fetchone()
print(row[0] if row else "")
conn.close()
PY
}

# ── Build a V20-shaped DB ──────────────────────────────────────────────────
"$PY" - <<PY
import sqlite3
conn = sqlite3.connect(r'''$DB_FILE_PY''')
conn.executescript("""
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('schema_version', '20');
INSERT INTO settings (key, value) VALUES ('deployment_mode', 'always-on');
""")
conn.commit()
conn.close()
PY

# Sanity-check the fixture
PRE_DEPLOY=$(sql "SELECT count(*) FROM settings WHERE key='deployment_mode'")
PRE_VER=$(sql "SELECT value FROM settings WHERE key='schema_version'")
[[ "$PRE_DEPLOY" == "1" ]] || { echo "FIXTURE-FAIL: expected 1 deployment_mode row pre-migration, got $PRE_DEPLOY"; exit 1; }
[[ "$PRE_VER" == "20" ]] || { echo "FIXTURE-FAIL: expected schema_version=20 pre-migration, got $PRE_VER"; exit 1; }

# ── Run migrate ────────────────────────────────────────────────────────────
DB_PATH="$DB_FILE_PY" "$PY" scripts/migrate.py >"$WORKDIR/migrate.log" 2>&1 || {
  echo "FAIL: migrate.py exited non-zero. Log:"
  cat "$WORKDIR/migrate.log"
  exit 1
}

# ── Assertions ─────────────────────────────────────────────────────────────
POST_DEPLOY=$(sql "SELECT count(*) FROM settings WHERE key='deployment_mode'")
POST_VER=$(sql "SELECT value FROM settings WHERE key='schema_version'")

[[ "$POST_DEPLOY" == "0" ]] || {
  echo "FAIL: deployment_mode row still present after migration (count=$POST_DEPLOY)"
  cat "$WORKDIR/migrate.log"
  exit 1
}
[[ "$POST_VER" == "21" ]] || {
  echo "FAIL: schema_version is $POST_VER after migration, expected 21"
  cat "$WORKDIR/migrate.log"
  exit 1
}

# ── Idempotency: re-run on a V21 DB is a no-op ─────────────────────────────
DB_PATH="$DB_FILE_PY" "$PY" scripts/migrate.py >"$WORKDIR/migrate2.log" 2>&1 || {
  echo "FAIL: second migrate.py run exited non-zero. Log:"
  cat "$WORKDIR/migrate2.log"
  exit 1
}
grep -qE "already at version 21" "$WORKDIR/migrate2.log" || {
  echo "FAIL: second migrate.py run did not print early-return message. Log:"
  cat "$WORKDIR/migrate2.log"
  exit 1
}

echo "PASS: migration v21 purges deployment_mode row, bumps schema_version to 21, idempotent on re-run"
