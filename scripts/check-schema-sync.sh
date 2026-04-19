#!/usr/bin/env bash
# scripts/check-schema-sync.sh
#
# Validates schema version consistency across four sources of truth before push:
#   1. SCHEMA_VERSION in scripts/migrate.py
#   2. schemaVersion === N in app/src/app/api/health/route.ts  (must equal #1)
#   3. EXPECTED_TABLES count in app/src/lib/db.ts             (must equal CREATE TABLE count in migrate.py)
#   4. schema_version INSERT in app/src/__tests__/helpers/schema.sql (must equal #1)
#
# Install as a git pre-push hook (one-time per clone):
#   cp scripts/check-schema-sync.sh .git/hooks/pre-push
#   chmod +x .git/hooks/pre-push
#
# Or run manually:
#   bash scripts/check-schema-sync.sh

set -euo pipefail

MIGRATE_PY="scripts/migrate.py"
HEALTH_ROUTE="app/src/app/api/health/route.ts"
DB_TS="app/src/lib/db.ts"
TEST_SCHEMA_SQL="app/src/__tests__/helpers/schema.sql"

fail=0

# 1. SCHEMA_VERSION from migrate.py
migrate_ver=$(grep -E '^SCHEMA_VERSION\s*=' "$MIGRATE_PY" | grep -oE '[0-9]+' | head -1)
if [ -z "$migrate_ver" ]; then
    echo "ERROR: could not parse SCHEMA_VERSION from $MIGRATE_PY"
    exit 1
fi

# 2. Version from health/route.ts: "schemaVersion === N"
health_ver=$(grep -oE 'schemaVersion === [0-9]+' "$HEALTH_ROUTE" | grep -oE '[0-9]+' | head -1)
if [ -z "$health_ver" ]; then
    echo "ERROR: could not parse 'schemaVersion === N' from $HEALTH_ROUTE"
    exit 1
fi

if [ "$migrate_ver" != "$health_ver" ]; then
    echo "SCHEMA VERSION MISMATCH — push blocked:"
    echo "  $MIGRATE_PY:    SCHEMA_VERSION = $migrate_ver"
    echo "  $HEALTH_ROUTE:  schemaVersion === $health_ver"
    echo "  Fix: update health/route.ts to match migrate.py."
    fail=1
fi

# 3. EXPECTED_TABLES count in db.ts vs CREATE TABLE count in migrate.py
expected_count=$(awk '/const EXPECTED_TABLES = \[/{found=1} found && /\] as const/{found=0} found{print}' "$DB_TS" \
    | grep -cE "^\s+'[a-z_]+'")
migrate_table_count=$(grep -cE 'CREATE TABLE\b' "$MIGRATE_PY")

if [ "$expected_count" != "$migrate_table_count" ]; then
    echo "TABLE COUNT MISMATCH — push blocked:"
    echo "  EXPECTED_TABLES in $DB_TS:    $expected_count entries"
    echo "  CREATE TABLE in $MIGRATE_PY:  $migrate_table_count statements"
    echo "  Fix: add the new table to EXPECTED_TABLES in db.ts, or add the migration."
    fail=1
fi

# 4. schema_version INSERT in the test fixture schema.sql
# This fixture is the second source of truth for the DB schema — unit tests
# seed an in-memory DB from it. Drift here doesn't block Docker-based
# integration tests (they run the real migrate.py) but silently breaks
# vitest. Guard equality on the version number.
if [ -f "$TEST_SCHEMA_SQL" ]; then
    # Match the schema_version INSERT line; capture the trailing '<N>' value.
    # The row shape is: INSERT INTO settings (key, value) VALUES ('schema_version', '18');
    test_schema_ver=$(grep -E "INSERT INTO settings.*'schema_version'" "$TEST_SCHEMA_SQL" \
        | grep -oE "'[0-9]+'" | tr -d "'" | tail -1)
    if [ -z "$test_schema_ver" ]; then
        echo "ERROR: could not parse schema_version from $TEST_SCHEMA_SQL"
        echo "  Expected: INSERT INTO settings (key, value) VALUES ('schema_version', 'N');"
        fail=1
    elif [ "$migrate_ver" != "$test_schema_ver" ]; then
        echo "TEST-FIXTURE SCHEMA VERSION MISMATCH — push blocked:"
        echo "  $MIGRATE_PY:        SCHEMA_VERSION = $migrate_ver"
        echo "  $TEST_SCHEMA_SQL:   schema_version = $test_schema_ver"
        echo "  Fix: bump $TEST_SCHEMA_SQL and mirror any new CREATE TABLE / ALTER TABLE statements."
        fail=1
    fi
fi

if [ "$fail" -eq 1 ]; then
    echo ""
    echo "Run 'bash scripts/check-schema-sync.sh' after fixing to verify."
    exit 1
fi

echo "Schema sync OK — v${migrate_ver}, ${expected_count} tables."
exit 0
