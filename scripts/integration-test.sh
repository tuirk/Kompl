#!/usr/bin/env bash
#
# Kompl v2 — End-to-end integration test
#
# This script is the merge gate. It runs after every milestone and must pass
# before any commit lands. Stages flip from TODO placeholder to real assertion
# one at a time as the v2 build order progresses (see plan at
# C:\Users\tuana\.claude\plans\snoopy-moseying-eagle.md).
#
# Usage:
#   bash scripts/integration-test.sh
#
# Exit codes:
#   0 = all stages passed
#   non-zero = the failing stage's number
#
# Stage state at commit 1: ALL TODO. Every stage echoes "[STAGE N] TODO: ..."
# and returns 0. The script exits 0. As real services land, each stage gets
# its real implementation in the same commit that brings the underlying code.
#
# This script must run under Windows Git Bash (MSYS2 bash) as well as Linux
# bash. Avoid bashisms that don't survive Git Bash. Use POSIX-friendly
# function definitions, [[ ]] for tests, set -euo pipefail.

set -euo pipefail

# ---------------------------------------------------------------------------
# Stage 0 — Cold start
# ---------------------------------------------------------------------------
# Real implementation will:
#   docker compose down -v && docker compose up -d --build
#   Wait up to 120s for /api/health, /health, /healthz, / on the 4 services
#   Fail fast if any container restart-loops
stage_0_cold_start() {
    echo "[STAGE 0] TODO: cold start (docker compose down -v + up -d --build, wait for healthchecks)"
    return 0
}

# ---------------------------------------------------------------------------
# Stage 1 — Migration & schema sanity
# ---------------------------------------------------------------------------
# Real implementation will:
#   Hit GET /api/health, assert db_writable=true, table_count=9
#   (8 user tables + sqlite_sequence)
#   No host-side DB opens — query sqlite_master from inside the app container
stage_1_migration_schema() {
    echo "[STAGE 1] TODO: migration & schema sanity (db_writable=true, table_count=9)"
    return 0
}

# ---------------------------------------------------------------------------
# Stage 2 — Single-writer enforcement canary
# ---------------------------------------------------------------------------
# Real implementation will:
#   Attempt host-side INSERT into settings via raw sqlite3
#   Then GET /api/settings?key=canary from outside the container
#   Expected: value visible (lock passed) OR host INSERT raised "database is
#   locked" (lock enforced). The bug we're guarding against is silent
#   divergence — value differs between host and app view. That MUST NOT happen.
#   Cleanup the canary regardless of outcome.
stage_2_single_writer_canary() {
    echo "[STAGE 2] TODO: single-writer enforcement canary (no silent divergence)"
    return 0
}

# ---------------------------------------------------------------------------
# Stage 3 — Demo seed via HTTP
# ---------------------------------------------------------------------------
# Real implementation will:
#   Run python scripts/demo-seed.py (rewritten to use HTTP, not sqlite3.connect)
#   Verify lsof data/db/kompl.db inside the app container shows ONLY Next.js
#   Assert seeded counts via API: sources=5, pages=8, vectors=8, provenance>=1/source
stage_3_demo_seed_http() {
    echo "[STAGE 3] TODO: demo seed via HTTP (no sqlite3.connect, vector count == page count)"
    return 0
}

# ---------------------------------------------------------------------------
# Stage 4 — Live ingest end-to-end
# ---------------------------------------------------------------------------
# Real implementation will:
#   POST 3 sources to /api/ingest (short article, long essay, PDF upload)
#   Poll /api/activity?since=... every 2s for up to 300s
#   For each source: assert ingested -> compiled -> wiki_rebuilt activity events
#   Assert provenance >=1 row, vector search returns matching page_id
stage_4_live_ingest() {
    echo "[STAGE 4] TODO: live ingest end-to-end (3 sources -> ingested -> compiled -> wiki_rebuilt)"
    return 0
}

# ---------------------------------------------------------------------------
# Stage 5 — Persistence across restart
# ---------------------------------------------------------------------------
# Real implementation will:
#   docker compose restart app nlp-service
#   Wait for healthcheck recovery
#   Re-run all assertions from Stage 3 + 4. Counts must be identical.
#   This is the test that historically failed with multi-writer SQLite.
stage_5_persistence() {
    echo "[STAGE 5] TODO: persistence across restart (counts identical after restart)"
    return 0
}

# ---------------------------------------------------------------------------
# Stage 6 — Chat with citations
# ---------------------------------------------------------------------------
# Real implementation will:
#   POST 5 questions to /webhook/query covering:
#     Q1 specific recall (1 source), Q2 synthesis (2 sources), Q3 no-coverage,
#     Q4 ambiguous/clarification, Q5 cross-reference
#   Assert Q1/Q2/Q5: citations >=1, all cited page_ids resolve
#   Assert Q3: no_coverage=true, citations empty
#   Assert ZERO no_coverage=true on Q1/Q2/Q5 (regression guard for v1 FIX-013)
stage_6_chat_citations() {
    echo "[STAGE 6] TODO: chat with citations (5 questions, regression guard for FIX-013)"
    return 0
}

# ---------------------------------------------------------------------------
# Stage 7 — Wiki rebuild
# ---------------------------------------------------------------------------
# Real implementation will:
#   POST /api/nlp/wiki/rebuild
#   Assert response: {success: true, pages_written: N, errors: []}
#   Assert files exist: data/wiki-content/entities/, /concepts/, /sources/ (PLURAL)
#   Assert singular variants do NOT exist (regression guard)
#   Spot-check 1 page: frontmatter present, [[wikilinks]] converted to [text](id)
stage_7_wiki_rebuild() {
    echo "[STAGE 7] TODO: wiki rebuild (plural directory names, frontmatter present, wikilinks converted)"
    return 0
}

# ---------------------------------------------------------------------------
# Stage 8 — Version history
# ---------------------------------------------------------------------------
# Real implementation will:
#   POST a 2nd ingest of one of the URLs from Stage 4 (force re-ingest)
#   After compile completes, assert pages.previous_content_path is non-null
#   Assert the previous version file exists on disk and differs from current
#   This is the regression guard for v1's file_store.py version-destroying bug.
stage_8_version_history() {
    echo "[STAGE 8] TODO: version history (previous_content_path non-null, files differ)"
    return 0
}

# ---------------------------------------------------------------------------
# Stage 9 — Contract drift canary
# ---------------------------------------------------------------------------
# Real implementation will:
#   Deliberately rename a Pydantic field in nlp-service/routers/vectors.py
#   (e.g. query_text -> query_text_renamed)
#   Run npm run build inside the app container
#   Assert build FAILS with a TypeScript error referencing the renamed field
#   Revert the rename, rebuild, assert build SUCCEEDS.
#   This proves the OpenAPI codegen + Zod boundary is wired and runtime
#   contract drift is impossible.
stage_9_contract_drift_canary() {
    echo "[STAGE 9] TODO: contract drift canary (Pydantic rename -> npm run build fails)"
    return 0
}

# ---------------------------------------------------------------------------
# Stage 10 — Concurrency / rate-limit
# ---------------------------------------------------------------------------
# Real implementation will:
#   Fire 7 ingest requests in parallel (the historical concurrency-bug count)
#   Assert all 7 reach compiled state within 600s
#   No task runner timeout, no Gemini rate-limit cascade, no silent loss
#   The shared llm_client.py token-bucket should serialize Gemini calls.
#   This is the test v1 would have failed.
stage_10_concurrency() {
    echo "[STAGE 10] TODO: concurrency / rate-limit (7 parallel ingests, all reach compiled)"
    return 0
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    echo "=== Kompl v2 integration test ==="
    echo "All stages currently TODO. As build steps land, stages flip to real assertions."
    echo

    stage_0_cold_start
    stage_1_migration_schema
    stage_2_single_writer_canary
    stage_3_demo_seed_http
    stage_4_live_ingest
    stage_5_persistence
    stage_6_chat_citations
    stage_7_wiki_rebuild
    stage_8_version_history
    stage_9_contract_drift_canary
    stage_10_concurrency

    echo
    echo "=== All 11 stages reported (commit 1: all TODO) ==="
    exit 0
}

main "$@"
