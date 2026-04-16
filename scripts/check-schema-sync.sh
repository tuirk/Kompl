#!/usr/bin/env bash
# scripts/check-schema-sync.sh
#
# Validates schema version consistency across three sources of truth before push:
#   1. SCHEMA_VERSION in scripts/migrate.py
#   2. schemaVersion === N in app/src/app/api/health/route.ts  (must equal #1)
#   3. EXPECTED_TABLES count in app/src/lib/db.ts             (must equal CREATE TABLE count in migrate.py)
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

if [ "$fail" -eq 1 ]; then
    echo ""
    echo "Run 'bash scripts/check-schema-sync.sh' after fixing to verify."
    exit 1
fi

echo "Schema sync OK — v${migrate_ver}, ${expected_count} tables."
exit 0
