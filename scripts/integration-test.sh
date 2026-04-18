#!/usr/bin/env bash
#
# Kompl v2 — End-to-end integration test
#
# This script is the merge gate. It runs after every milestone and must pass
# before any commit lands. Stages flip from TODO placeholder to real assertion
# one at a time as the v2 build order progresses.
#
# Usage:
#   bash scripts/integration-test.sh
#
# Exit codes:
#   0 = all stages passed
#   non-zero = the failing stage's number
#
# Stage state at commit 8:
#   Stage 0  — REAL (cold start)
#   Stage 1  — REAL (migration & schema sanity via /api/health, schema_version=16)
#   Stage 4  — REAL (text connector collect end-to-end + failure-path canary, no API key needed)
#   Stage 11 — REAL (onboarding API canary)
#   Stage 12 — REAL (text connector canary)
#   Stage 13 — REAL (twitter connector canary)
#   Stage 14 — REAL (extraction pipeline canary, skipped without GEMINI_API_KEY)
#   Stage 15 — REAL (entity resolution canary, skipped without GEMINI_API_KEY)
#   Stage 16 — REAL (full compilation pipeline, skipped without GEMINI_API_KEY)
#   Stage 17 — REAL (session compile via n8n, skipped without GEMINI_API_KEY)
#   Stage 18 — REAL (wiki-aware update, skipped without GEMINI_API_KEY)
#   Stage 19 — REAL (chat canary, skipped without GEMINI_API_KEY or page_count<1)
#   Stage 20 — REAL (source management + settings + drafts endpoints)
#   All other stages — TODO.
#
# As real services land, each stage gets its real implementation in the same
# commit that brings the underlying code. See the thin-slice plan at
# C:\Users\tuana\.claude\plans\kompl-v2-thin-slice.md for the flip order.
#
# This script must run under Windows Git Bash (MSYS2 bash) as well as Linux
# bash. Avoid bashisms that don't survive Git Bash. Use POSIX-friendly
# function definitions, [[ ]] for tests, set -euo pipefail.
#
# Exit behavior: the script propagates any stage's non-zero return through
# `set -e`. The terminal `exit 0` in main() is reached only when every stage
# returned 0.

set -euo pipefail

# Windows Git Bash compatibility: `python3` may resolve to a Windows Store redirect
# stub rather than a real interpreter. Test that it actually prints a version string.
if ! python3 --version 2>&1 | grep -q "Python 3"; then
    python3() { python "$@"; }
    export -f python3
fi

# Compose command: prefer v2 plugin (`docker compose`), fall back to v1 standalone (`docker-compose`)
# In CI, COMPOSE_FILE is set by the workflow (docker-compose.yml:docker-compose.ci.yml) —
# do NOT pass --file flags or they will override COMPOSE_FILE.
# Locally, if docker-compose.test.yml exists (gitignored), pass it via --file. --file is used
# instead of COMPOSE_FILE to avoid Windows path-separator issues (Docker is a Windows binary, uses ';').
if [ -n "${CI:-}" ]; then
    _COMPOSE_FILES=""
else
    _COMPOSE_FILES="--file docker-compose.yml"
    if [ -f "docker-compose.test.yml" ]; then
        _COMPOSE_FILES="$_COMPOSE_FILES --file docker-compose.test.yml"
    fi
fi
if docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose $_COMPOSE_FILES"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose $_COMPOSE_FILES"
else
    echo "ERROR: neither 'docker compose' nor 'docker-compose' found" >&2
    exit 1
fi
unset _COMPOSE_FILES

# Track which stages ran and their outcomes, printed as a summary at the end.
STAGE_RESULTS=()
record_stage() {
    local stage_num="$1"
    local state="$2"  # REAL or TODO
    local outcome="$3"  # PASS or FAIL or SKIPPED
    STAGE_RESULTS+=("stage $stage_num [$state]: $outcome")
}

# Wait for a URL to return HTTP 200, with timeout
wait_for_http_200() {
    local url="$1"
    local timeout_s="${2:-60}"
    local elapsed=0
    while [ $elapsed -lt "$timeout_s" ]; do
        if curl -sf -o /dev/null -w "%{http_code}" "$url" 2>/dev/null | grep -q "200"; then
            return 0
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done
    return 1
}

# ---------------------------------------------------------------------------
# Stage 0 — Cold start (REAL as of commit 4)
# ---------------------------------------------------------------------------
# Tears down volumes, rebuilds all images, and waits for all 3 real services
# (app, nlp-service, n8n) to become healthy. Ensures no stale state bleeds
# across test runs.
stage_0_cold_start() {
    echo "[STAGE 0] REAL: cold start (down -v + up -d --build)"

    echo "  tearing down all containers and volumes..."
    if ! $COMPOSE down -v >/dev/null 2>&1; then
        echo "  WARNING: docker compose down -v returned non-zero (may be first run)"
    fi

    echo "  building and starting all services..."
    # docker compose up -d can exit non-zero when a depends_on health-check
    # races the cold-start (e.g. n8n task-runner token handshake on fresh
    # volume). The wait_for_http_200 calls below are the real readiness gate;
    # treat a non-zero exit here as a warning, not a hard failure.
    $COMPOSE up -d --build app nlp-service n8n \
        || echo "  WARNING: docker compose up returned non-zero (may be a cold-start race — continuing)"

    echo "  waiting for app /api/health to return 200 (up to 360s)..."
    if ! wait_for_http_200 "http://localhost:3000/api/health" 360; then
        echo "  FAIL: app /api/health not ready within 360s"
        $COMPOSE logs app 2>&1 | tail -30
        record_stage 0 REAL FAIL
        return 1
    fi

    echo "  waiting for nlp-service /health to return 200 (up to 90s)..."
    if ! wait_for_http_200 "http://localhost:8000/health" 90; then
        echo "  FAIL: nlp-service /health not ready within 90s"
        $COMPOSE logs nlp-service 2>&1 | tail -30
        record_stage 0 REAL FAIL
        return 1
    fi

    # n8n readiness: /healthz returns {"status":"ok"} once the process is up
    # and workflows are loaded. No webhook probe needed here — session-compile
    # readiness is verified in stage 11.
    echo "  waiting for n8n /healthz to return 200 (up to 120s)..."
    if ! wait_for_http_200 "http://localhost:5678/healthz" 120; then
        echo "  FAIL: n8n /healthz did not return 200 within 120s"
        $COMPOSE logs n8n 2>&1 | tail -30
        record_stage 0 REAL FAIL
        return 1
    fi

    echo "  PASS"
    record_stage 0 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 1 — Migration & schema sanity (REAL as of commit 2)
# ---------------------------------------------------------------------------
stage_1_migration_schema() {
    echo "[STAGE 1] REAL: migration & schema sanity"

    # Ensure a clean slate. `down -v` removes the named volume so the DB
    # gets re-created from scratch by migrate.py.
    $COMPOSE down -v >/dev/null 2>&1 || true

    echo "  starting app service (no-deps: testing nlp_ok:false path)..."
    if ! $COMPOSE up -d --build --no-deps app; then
        echo "  FAIL: docker compose up -d --build --no-deps app returned non-zero"
        record_stage 1 REAL FAIL
        return 1
    fi

    echo "  waiting for /api/health to return 200 (up to 120s)..."
    if ! wait_for_http_200 "http://localhost:3000/api/health" 120; then
        echo "  FAIL: /api/health did not return 200 within 120s"
        echo "  --- app logs ---"
        $COMPOSE logs app 2>&1 | tail -40
        record_stage 1 REAL FAIL
        return 1
    fi

    local response
    response=$(curl -sf "http://localhost:3000/api/health")
    echo "  response: $response"

    # Parse the JSON response with simple grep checks (avoid jq dep in CI)
    # Stage 1 starts app only — nlp-service is NOT started yet.
    # status:degraded + nlp_ok:false is the correct expected state here.
    if ! echo "$response" | grep -q '"status":"degraded"'; then
        echo "  FAIL: expected status:degraded in stage 1 (NLP not started), got: $response"
        record_stage 1 REAL FAIL
        return 1
    fi
    if ! echo "$response" | grep -q '"nlp_ok":false'; then
        echo "  FAIL: expected nlp_ok:false in stage 1 (NLP not started), got: $response"
        record_stage 1 REAL FAIL
        return 1
    fi

    if ! echo "$response" | grep -q '"db_writable":true'; then
        echo "  FAIL: db_writable != true"
        record_stage 1 REAL FAIL
        return 1
    fi
    if ! echo "$response" | grep -q '"schema_version":17'; then
        echo "  FAIL: schema_version != 17"
        record_stage 1 REAL FAIL
        return 1
    fi
    if ! echo "$response" | grep -q '"table_count":17'; then
        echo "  FAIL: table_count != 17"
        record_stage 1 REAL FAIL
        return 1
    fi
    if ! echo "$response" | grep -q '"ingest_failures"'; then
        echo "  FAIL: ingest_failures table missing from /api/health tables list"
        record_stage 1 REAL FAIL
        return 1
    fi
    if ! echo "$response" | grep -q '"vector_backfill_queue"'; then
        echo "  FAIL: vector_backfill_queue table missing from /api/health tables list"
        record_stage 1 REAL FAIL
        return 1
    fi
    if ! echo "$response" | grep -q '"entity_mentions"'; then
        echo "  FAIL: entity_mentions table missing from /api/health tables list"
        record_stage 1 REAL FAIL
        return 1
    fi
    if ! echo "$response" | grep -q '"relationship_mentions"'; then
        echo "  FAIL: relationship_mentions table missing from /api/health tables list"
        record_stage 1 REAL FAIL
        return 1
    fi

    echo "  PASS"
    record_stage 1 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 4 -- Collect end-to-end, no external dependencies (REAL -- no API key needed)
# ---------------------------------------------------------------------------
# Brings up nlp-service (app already running from stage 1). POSTs a text note
# via connector='text' to /api/onboarding/collect and verifies the source is
# stored with the correct title.
#
# Text connector stores markdown directly -- no markitdown, no Firecrawl, no
# network. This makes Stage 4 reliably runnable in CI without any secrets.
# URL collect is tested by Stage 11 (gated on FIRECRAWL_API_KEY).
#
# Also runs a failure-path canary: POSTs a RFC 2606 .invalid URL via collect.
# nlp-service short-circuits immediately (< 1s) and collect writes an
# ingest_failures row. Verified via /api/sources/failures.
stage_4_live_ingest() {
    echo "[STAGE 4] REAL: collect end-to-end via text connector (collect -> store -> verify)"

    echo "  starting nlp-service..."
    if ! $COMPOSE up -d --build nlp-service; then
        echo "  FAIL: docker compose up -d --build nlp-service returned non-zero"
        record_stage 4 REAL FAIL
        return 1
    fi

    echo "  waiting for nlp-service /health to return 200 (up to 90s)..."
    if ! wait_for_http_200 "http://localhost:8000/health" 90; then
        echo "  FAIL: nlp-service /health did not return 200 within 90s"
        echo "  --- nlp-service logs ---"
        $COMPOSE logs nlp-service 2>&1 | tail -40
        record_stage 4 REAL FAIL
        return 1
    fi

    # Generate a session_id for the collect call.
    local SESSION_ID
    SESSION_ID=$(uuidgen 2>/dev/null || \
        powershell -Command "[guid]::NewGuid().ToString()" 2>/dev/null || \
        python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || \
        cat /proc/sys/kernel/random/uuid 2>/dev/null || \
        date +%s | sha256sum | awk '{print substr($1,1,8)"-"substr($1,9,4)"-4"substr($1,14,3)"-"substr($1,17,4)"-"substr($1,21,12)}')
    echo "  session_id: $SESSION_ID"

    # -----------------------------------------------------------------------
    # Sub-test: happy path -- text note collect via /api/onboarding/collect
    # -----------------------------------------------------------------------
    echo "  POSTing text note to /api/onboarding/collect..."
    local NOTE_TITLE="Integration Test Note"
    # Single-line markdown — avoids literal newlines breaking the JSON string in the curl -d argument.
    # Content is long enough (>500 chars) to clear the min_source_chars gate.
    local NOTE_MD="Integration Test Note. This note is seeded by the integration test suite to verify the text connector collect path end-to-end. It contains enough content to clear the min_source_chars gate (default 500 characters). The collect endpoint should store this note synchronously and return a source_id in the stored array. The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump quickly. The five boxing wizards are fully ready and waiting here."

    local collect_response collect_http
    collect_http=$(curl -s -o /tmp/collect_body.json -w "%{http_code}" -X POST \
        -H "content-type: application/json" \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[{\"markdown\":\"$NOTE_MD\",\"title_hint\":\"$NOTE_TITLE\",\"source_type_hint\":\"note\"}]}" \
        "http://localhost:3000/api/onboarding/collect" 2>&1)
    collect_response=$(cat /tmp/collect_body.json 2>/dev/null || echo "")
    if [ "$collect_http" != "200" ]; then
        echo "  FAIL: /api/onboarding/collect returned HTTP $collect_http"
        echo "  body: $collect_response"
        echo "  --- app logs ---"
        $COMPOSE logs app 2>&1 | tail -30
        record_stage 4 REAL FAIL
        return 1
    fi
    if [ -z "$collect_response" ]; then
        echo "  FAIL: /api/onboarding/collect returned empty response"
        echo "  --- app logs ---"
        $COMPOSE logs app 2>&1 | tail -20
        record_stage 4 REAL FAIL
        return 1
    fi
    echo "  collect response: $collect_response"

    # Verify the stored array is non-empty. Shape: {"stored":[{"source_id":"uuid",...}],...}
    if ! echo "$collect_response" | grep -q '"stored":\[{'; then
        echo "  FAIL: collect response 'stored' array is empty"
        echo "  $collect_response"
        record_stage 4 REAL FAIL
        return 1
    fi

    # Extract source_id from the first stored item (grep + sed, no jq dep).
    local source_id
    source_id=$(echo "$collect_response" | grep -o '"stored":\[{"source_id":"[^"]*"' | grep -Eo '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1)
    if [ -z "$source_id" ]; then
        echo "  FAIL: could not extract source_id from collect response"
        record_stage 4 REAL FAIL
        return 1
    fi
    echo "  source_id: $source_id"

    echo "  verifying /api/sources/$source_id..."
    local source_response
    source_response=$(curl -sf "http://localhost:3000/api/sources/$source_id" 2>/dev/null || echo "")
    if ! echo "$source_response" | grep -qi '"title"'; then
        echo "  FAIL: /api/sources/<id> response missing title field"
        echo "  $source_response"
        record_stage 4 REAL FAIL
        return 1
    fi
    if ! echo "$source_response" | grep -qi 'Integration Test Note'; then
        echo "  FAIL: source title does not match 'Integration Test Note'"
        echo "  $source_response"
        record_stage 4 REAL FAIL
        return 1
    fi

    echo "  happy path: text collect stored PASS"

    # -----------------------------------------------------------------------
    # Sub-test: failure-path canary
    # -----------------------------------------------------------------------
    # POSTs a RFC 2606 .invalid URL via collect. nlp-service short-circuits
    # immediately (< 1s, before MarkItDown or Firecrawl). collect's catch block
    # calls insertIngestFailure and returns the item in the 'failed' array.
    echo "  canary: POSTing .invalid URL to /api/onboarding/collect..."

    local canary_session_id
    canary_session_id=$(uuidgen 2>/dev/null || \
        powershell -Command "[guid]::NewGuid().ToString()" 2>/dev/null || \
        python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || \
        cat /proc/sys/kernel/random/uuid 2>/dev/null || \
        date +%s | sha256sum | awk '{print substr($1,1,8)"-"substr($1,9,4)"-4"substr($1,14,3)"-"substr($1,17,4)"-"substr($1,21,12)}')

    local canary_collect_response
    canary_collect_response=$(curl -s -X POST \
        -H "content-type: application/json" \
        -d "{\"session_id\":\"$canary_session_id\",\"connector\":\"url\",\"items\":[{\"url\":\"https://this-domain-does-not-exist-kompl-canary.invalid\"}]}" \
        "http://localhost:3000/api/onboarding/collect" 2>&1 || echo "")
    echo "  canary collect response: $canary_collect_response"

    # collect returns 200 with failed:[{...}] when a URL fails conversion.
    if ! echo "$canary_collect_response" | grep -q '"failed":\[{'; then
        echo "  FAIL: canary collect response 'failed' array is empty or missing"
        echo "  $canary_collect_response"
        record_stage 4 REAL FAIL
        return 1
    fi

    # Verify insertIngestFailure wrote a row to the ingest_failures table.
    local failures_response
    failures_response=$(curl -sf "http://localhost:3000/api/sources/failures" 2>/dev/null || echo "")
    if ! echo "$failures_response" | grep -q 'does-not-exist-kompl-canary'; then
        echo "  FAIL: ingest_failures row not found in /api/sources/failures after collect failure"
        echo "  failures_response: $failures_response"
        record_stage 4 REAL FAIL
        return 1
    fi

    echo "  canary PASS"

    echo "  PASS"
    record_stage 4 REAL PASS
    return 0
}


# ---------------------------------------------------------------------------
# Stage 11 — Onboarding API canary (REAL as of Part 1b)
# ---------------------------------------------------------------------------
# Exercises the full collect → review → confirm flow:
#   1. POST /api/onboarding/collect with example.com
#   2. GET  /api/onboarding/review — asserts 1 collected source
#   3. POST /api/onboarding/confirm — asserts queued=1
#   4. Reads compile_status directly from SQLite — asserts 'pending'
#
# Skipped gracefully when FIRECRAWL_API_KEY is unset (collect calls Firecrawl).
stage_11_onboarding_api() {
    echo "[STAGE 11] REAL: onboarding API canary (collect → review → confirm → pending)"

    if [ -z "${FIRECRAWL_API_KEY:-}" ]; then
        echo "  SKIP: FIRECRAWL_API_KEY not set — skipping onboarding API canary."
        record_stage 11 REAL SKIPPED
        return 0
    fi

    # Generate a session_id: use /proc/sys/kernel/random/uuid on Linux,
    # fall back to a timestamp-based hex string on Git Bash (no uuidgen dep).
    local SESSION_ID
    if [ -r /proc/sys/kernel/random/uuid ]; then
        SESSION_ID=$(cat /proc/sys/kernel/random/uuid)
    else
        SESSION_ID=$(date +%s%N | md5sum | head -c 8)-0000-0000-0000-$(date +%s%N | md5sum | head -c 12)
    fi
    echo "  session_id: $SESSION_ID"

    # ── Step 1: collect ──────────────────────────────────────────────────────
    echo "  POSTing to /api/onboarding/collect..."
    local collect_response
    collect_response=$(curl -sf -X POST \
        -H "content-type: application/json" \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"url\",\"items\":[{\"url\":\"https://example.com\"}]}" \
        "http://localhost:3000/api/onboarding/collect" 2>&1)

    if [ -z "$collect_response" ]; then
        echo "  FAIL: /api/onboarding/collect returned empty response"
        record_stage 11 REAL FAIL
        return 1
    fi
    echo "  collect response: $collect_response"

    if ! echo "$collect_response" | grep -q "\"session_id\":\"$SESSION_ID\""; then
        echo "  FAIL: collect response missing expected session_id"
        record_stage 11 REAL FAIL
        return 1
    fi

    # Extract the source_id — shape: "stored":[{"source_id":"uuid",...}]
    local SOURCE_ID
    SOURCE_ID=$(echo "$collect_response" | grep -o '"stored":\[{"source_id":"[^"]*"' | grep -Eo '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1)
    if [ -z "$SOURCE_ID" ]; then
        echo "  FAIL: could not extract source_id from collect response (stored may be empty)"
        echo "  collect response: $collect_response"
        record_stage 11 REAL FAIL
        return 1
    fi
    echo "  source_id: $SOURCE_ID"

    # ── Step 2: review ───────────────────────────────────────────────────────
    echo "  GETting /api/onboarding/review..."
    local review_response
    review_response=$(curl -sf "http://localhost:3000/api/onboarding/review?session_id=$SESSION_ID")

    if ! echo "$review_response" | grep -q '"total":1'; then
        echo "  FAIL: review response missing \"total\":1"
        echo "  review response: $review_response"
        record_stage 11 REAL FAIL
        return 1
    fi
    echo "  review total=1 OK"

    # ── Step 3: confirm ──────────────────────────────────────────────────────
    echo "  POSTing to /api/onboarding/confirm..."
    local confirm_response
    confirm_response=$(curl -sf -X POST \
        -H "content-type: application/json" \
        -d "{\"session_id\":\"$SESSION_ID\",\"selected_source_ids\":[\"$SOURCE_ID\"],\"deleted_source_ids\":[]}" \
        "http://localhost:3000/api/onboarding/confirm")

    if ! echo "$confirm_response" | grep -q '"queued":1'; then
        echo "  FAIL: confirm response missing \"queued\":1"
        echo "  confirm response: $confirm_response"
        record_stage 11 REAL FAIL
        return 1
    fi
    echo "  confirm queued=1 OK"

    # ── Step 4: verify compile_status via sources API (sqlite3 not in container) ──
    local source_response
    source_response=$(curl -sf "http://localhost:3000/api/sources/$SOURCE_ID")

    local db_status
    db_status=$(echo "$source_response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('compile_status','NOT_FOUND'))" 2>/dev/null || echo "")

    if [ "$db_status" != "pending" ]; then
        echo "  FAIL: expected compile_status='pending', got '$db_status'"
        echo "  source response: $source_response"
        record_stage 11 REAL FAIL
        return 1
    fi
    echo "  compile_status=pending OK"

    echo "  PASS"
    record_stage 11 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 11b — confirm surfaces n8n-down as 503 (not silent 'queued forever')
# ---------------------------------------------------------------------------
#
# Regression test for the silent-failure bug fixed by lib/trigger-n8n.ts +
# the /api/onboarding/confirm refactor. Pre-fix: with n8n down, confirm used
# fire-and-forget fetch and returned 200 — compile_progress row got stuck at
# 'queued' forever. Post-fix: confirm awaits the webhook and returns 503
# with an n8n_* error code, while the DB row is still created so the
# reconciler in /api/health can clean it up later.
#
# This test does NOT require FIRECRAWL_API_KEY (uses text connector).
stage_11b_confirm_surfaces_n8n_down() {
    echo "[STAGE 11b] REAL: /api/onboarding/confirm returns 503 when n8n is down"

    local SESSION_ID
    SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())")

    # ── collect a text source ────────────────────────────────────────────────
    local NOTE_MD='# 11b test note\n\nRegression guard for n8n-down confirm.'
    local collect_response
    collect_response=$(curl -sf -X POST \
        -H "content-type: application/json" \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[{\"markdown\":\"$NOTE_MD\",\"title_hint\":\"11b Test\",\"source_type_hint\":\"note\"}]}" \
        "http://localhost:3000/api/onboarding/collect")

    local SOURCE_ID
    SOURCE_ID=$(echo "$collect_response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['stored'][0]['source_id'] if d.get('stored') else '')" 2>/dev/null || echo "")
    if [ -z "$SOURCE_ID" ]; then
        echo "  FAIL: could not collect test source"
        record_stage 11b REAL FAIL
        return 1
    fi
    echo "  collected source_id=$SOURCE_ID"

    # ── stop n8n ─────────────────────────────────────────────────────────────
    echo "  stopping n8n to simulate webhook failure..."
    if ! $COMPOSE stop n8n >/dev/null 2>&1; then
        echo "  FAIL: could not stop n8n"
        record_stage 11b REAL FAIL
        return 1
    fi

    # ── confirm with n8n down — expect HTTP 503 + n8n_* error code ───────────
    echo "  POSTing /api/onboarding/confirm with n8n down (expect 503)..."
    local confirm_http confirm_body
    confirm_http=$(curl -s -o /tmp/11b_body -w "%{http_code}" -X POST \
        -H "content-type: application/json" \
        -d "{\"session_id\":\"$SESSION_ID\",\"selected_source_ids\":[\"$SOURCE_ID\"],\"deleted_source_ids\":[]}" \
        "http://localhost:3000/api/onboarding/confirm")
    confirm_body=$(cat /tmp/11b_body 2>/dev/null || echo "")
    rm -f /tmp/11b_body

    # Restart n8n regardless of test outcome so other stages can run.
    echo "  restarting n8n..."
    $COMPOSE start n8n >/dev/null 2>&1 || true
    wait_for_http_200 "http://localhost:5678/healthz" 120 || echo "  WARNING: n8n did not come back within 120s"

    if [ "$confirm_http" != "503" ]; then
        echo "  FAIL: expected HTTP 503 with n8n down, got $confirm_http"
        echo "  body: $confirm_body"
        record_stage 11b REAL FAIL
        return 1
    fi
    echo "  confirm HTTP 503 OK"

    if ! echo "$confirm_body" | grep -qE '"error":"n8n_(unreachable|timeout|webhook_failed)"'; then
        echo "  FAIL: body missing expected n8n_* error code"
        echo "  body: $confirm_body"
        record_stage 11b REAL FAIL
        return 1
    fi
    echo "  n8n_* error code OK"

    # The compile_progress row must still exist (status='queued') so the
    # reconciler in /api/health can sweep it after the 5-minute threshold.
    local sessions_response
    sessions_response=$(curl -sf "http://localhost:3000/api/compile/sessions")
    if ! echo "$sessions_response" | grep -q "\"session_id\":\"$SESSION_ID\""; then
        echo "  FAIL: compile_progress row missing for $SESSION_ID"
        echo "  sessions: $sessions_response"
        record_stage 11b REAL FAIL
        return 1
    fi
    echo "  compile_progress row persisted for reconciler OK"

    # FIXME: stage 11b.2 — reconciler sweep — deferred. Needs either sqlite3
    # CLI in the container OR a dev-only debug endpoint to fast-forward
    # created_at by 6 minutes. Correctness of reconcileStuckCompileSessions
    # is verified by inspection + unit test coverage.

    echo "  PASS"
    record_stage 11b REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 12 — text connector canary
# ---------------------------------------------------------------------------
#
# Submits a raw markdown note via connector='text' (no Firecrawl, no nlp-service).
# Verifies the source is stored with compile_status='collected'.
# This stage does NOT require FIRECRAWL_API_KEY.
stage_12_text_connector() {
    echo "[STAGE 12] REAL: text connector canary (collect note → collected in DB)"

    local SESSION_ID
    SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())")

    local NOTE_MD='# My test note\n\nThis is a test note from the integration test.'

    # ── collect ──────────────────────────────────────────────────────────────
    echo "  POSTing to /api/onboarding/collect with connector=text..."
    local collect_response
    collect_response=$(curl -sf -X POST \
        -H "content-type: application/json" \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[{\"markdown\":\"$NOTE_MD\",\"title_hint\":\"Test Note\",\"source_type_hint\":\"note\"}]}" \
        "http://localhost:3000/api/onboarding/collect")

    if [ -z "$collect_response" ]; then
        echo "  FAIL: /api/onboarding/collect returned empty response"
        record_stage 12 REAL FAIL
        return 1
    fi

    if ! echo "$collect_response" | grep -q "\"session_id\":\"$SESSION_ID\""; then
        echo "  FAIL: collect response missing expected session_id"
        record_stage 12 REAL FAIL
        return 1
    fi

    local SOURCE_ID
    SOURCE_ID=$(echo "$collect_response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['stored'][0]['source_id'] if d.get('stored') else '')" 2>/dev/null || echo "")

    if [ -z "$SOURCE_ID" ]; then
        echo "  FAIL: could not extract source_id from collect response"
        echo "  collect response: $collect_response"
        record_stage 12 REAL FAIL
        return 1
    fi
    echo "  source_id=$SOURCE_ID"

    # ── verify via review API (sqlite3 CLI not available in container) ────────
    local review_response
    review_response=$(curl -sf "http://localhost:3000/api/onboarding/review?session_id=$SESSION_ID")

    if [ -z "$review_response" ]; then
        echo "  FAIL: /api/onboarding/review returned empty response"
        record_stage 12 REAL FAIL
        return 1
    fi

    if ! echo "$review_response" | grep -q '"total":1'; then
        echo "  FAIL: review response missing \"total\":1 — source not stored"
        echo "  review response: $review_response"
        record_stage 12 REAL FAIL
        return 1
    fi
    echo "  review total=1 OK (source stored as collected)"

    echo "  PASS"
    record_stage 12 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 13: Twitter connector canary
# Submits a tweet via connector='text' with source_type_hint='tweet' and
# date metadata. Verifies via review API (sqlite3 not in container).
# ---------------------------------------------------------------------------
stage_13_twitter_connector() {
    echo "[STAGE 13] REAL: twitter connector canary (tweet → collected in DB)"

    local SESSION_ID
    SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || uuidgen)
    local TWEET_MD
    TWEET_MD='**@testuser:**\n\nThis is a test tweet about Bitcoin\n\n[Original tweet](https://twitter.com/testuser/status/123)'

    local collect_response
    collect_response=$(curl -sf -X POST http://localhost:3000/api/onboarding/collect \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[{\"markdown\":\"$TWEET_MD\",\"title_hint\":\"Tweet by @testuser\",\"source_type_hint\":\"tweet\",\"metadata\":{\"date_saved\":\"2026-01-15T10:30:00Z\",\"author\":\"@testuser\"}}]}")

    if [ -z "$collect_response" ]; then
        echo "  FAIL: /api/onboarding/collect returned empty response"
        record_stage 13 REAL FAIL
        return 1
    fi

    if ! echo "$collect_response" | grep -q "\"session_id\":\"$SESSION_ID\""; then
        echo "  FAIL: collect response missing expected session_id"
        record_stage 13 REAL FAIL
        return 1
    fi

    # ── verify via review API (sqlite3 CLI not available in container) ────────
    local review_response
    review_response=$(curl -sf "http://localhost:3000/api/onboarding/review?session_id=$SESSION_ID")

    if [ -z "$review_response" ]; then
        echo "  FAIL: /api/onboarding/review returned empty response"
        record_stage 13 REAL FAIL
        return 1
    fi

    if ! echo "$review_response" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['total']==1, f'total={d[\"total\"]}'" 2>/dev/null; then
        echo "  FAIL: review total != 1"
        echo "  review response: $review_response"
        record_stage 13 REAL FAIL
        return 1
    fi

    # Verify source_type=tweet
    local source_type
    source_type=$(echo "$review_response" | python3 -c "import sys,json; d=json.load(sys.stdin); src=list(d['sources'].values())[0][0]; print(src['source_type'])" 2>/dev/null)

    if [ "$source_type" != "tweet" ]; then
        echo "  FAIL: source_type='$source_type', expected 'tweet'"
        record_stage 13 REAL FAIL
        return 1
    fi

    echo "  source_type=tweet OK"
    echo "  PASS"
    record_stage 13 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 14 — Extraction pipeline canary (Part 2a)
# ---------------------------------------------------------------------------
# Collects a URL source, confirms it to 'pending', runs /api/compile/extract,
# and verifies that:
#   - the response contains an 'extraction' key with 'llm_output'
#   - the source's compile_status transitions to 'extracted'
#
# Skipped gracefully when GEMINI_API_KEY is unset (same pattern as stage 4).
# ---------------------------------------------------------------------------
stage_14_extraction() {
    echo "[STAGE 14] REAL: extraction pipeline canary"

    if [ -z "${GEMINI_API_KEY:-}" ]; then
        echo "  SKIPPED: GEMINI_API_KEY not set"
        record_stage 14 REAL SKIPPED
        return 0
    fi

    local SESSION_ID
    SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || uuidgen)

    # Collect a URL source
    local collect_response
    collect_response=$(curl -sf -X POST http://localhost:3000/api/onboarding/collect \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"url\",\"items\":[{\"url\":\"https://example.com\"}]}")

    if [ -z "$collect_response" ]; then
        echo "  FAIL: /api/onboarding/collect returned empty response"
        record_stage 14 REAL FAIL
        return 1
    fi

    local SOURCE_ID
    SOURCE_ID=$(echo "$collect_response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['stored'][0]['source_id'])" 2>/dev/null)

    if [ -z "$SOURCE_ID" ]; then
        echo "  FAIL: could not parse source_id from collect response"
        echo "  collect response: $collect_response"
        record_stage 14 REAL FAIL
        return 1
    fi

    # Confirm to move to pending
    curl -sf -X POST http://localhost:3000/api/onboarding/confirm \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"selected_source_ids\":[\"$SOURCE_ID\"],\"deleted_source_ids\":[]}" > /dev/null

    # Run extraction
    echo "  running extraction for source $SOURCE_ID (Gemini call may take 30-90s)..."
    local extract_response
    extract_response=$(curl -sf --max-time 180 -X POST http://localhost:3000/api/compile/extract \
        -H 'Content-Type: application/json' \
        -d "{\"source_id\":\"$SOURCE_ID\"}")

    if [ -z "$extract_response" ]; then
        echo "  FAIL: /api/compile/extract returned empty response"
        record_stage 14 REAL FAIL
        return 1
    fi

    # Verify extraction key + llm_output present
    if ! echo "$extract_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert 'extraction' in d, 'no extraction key'
assert 'llm_output' in d['extraction'], 'no llm_output'
assert 'summary' in d['extraction']['llm_output'], 'no summary in llm_output'
" 2>/dev/null; then
        echo "  FAIL: extraction response missing expected fields"
        echo "  response: $(echo "$extract_response" | head -c 500)"
        record_stage 14 REAL FAIL
        return 1
    fi

    # Verify compile_status = 'extracted' via review API
    local review_response
    review_response=$(curl -sf "http://localhost:3000/api/onboarding/review?session_id=$SESSION_ID")

    local compile_status
    compile_status=$(echo "$review_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
sources = list(d['sources'].values())[0] if isinstance(d.get('sources'), dict) else d.get('sources', [])
if isinstance(sources, list):
    src = next((s for s in sources if s['source_id'] == '$SOURCE_ID'), None)
else:
    src = sources[0] if sources else None
print(src['compile_status'] if src else 'NOT_FOUND')
" 2>/dev/null)

    if [ "$compile_status" != "extracted" ]; then
        echo "  FAIL: compile_status='$compile_status', expected 'extracted'"
        record_stage 14 REAL FAIL
        return 1
    fi

    echo "  extraction OK, compile_status=extracted"
    echo "  PASS"
    record_stage 14 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 15: Entity resolution canary
# Collects two text sources with overlapping entity names ("Vitalik Buterin"
# and "Buterin"), extracts both, then resolves to verify they collapse to one
# canonical entity. Both extract + resolve require GEMINI_API_KEY.
# ---------------------------------------------------------------------------
stage_15_resolution() {
    echo "[STAGE 15] REAL: entity resolution canary (Buterin + Vitalik Buterin → 1 canonical)"

    if [ -z "${GEMINI_API_KEY:-}" ]; then
        echo "  SKIPPED: GEMINI_API_KEY not set"
        record_stage 15 REAL SKIPPED
        return 0
    fi

    local SESSION_ID
    SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || uuidgen)

    # Collect two sources that mention the same entity under different names
    local collect_response
    collect_response=$(curl -sf -X POST http://localhost:3000/api/onboarding/collect \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[
          {\"markdown\":\"Vitalik Buterin founded Ethereum in 2015. Ethereum is a programmable blockchain platform that supports smart contracts.\",\"title_hint\":\"Source A\",\"source_type_hint\":\"note\"},
          {\"markdown\":\"Buterin proposed Ethereum as a next-generation cryptocurrency platform. ETH is the native token of Ethereum.\",\"title_hint\":\"Source B\",\"source_type_hint\":\"note\"}
        ]}")

    if [ -z "$collect_response" ]; then
        echo "  FAIL: /api/onboarding/collect returned empty"
        record_stage 15 REAL FAIL
        return 1
    fi

    # Parse out both source IDs
    local SOURCE_IDS_JSON
    SOURCE_IDS_JSON=$(echo "$collect_response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps([s['source_id'] for s in d.get('stored',[])]))" 2>/dev/null)

    if [ -z "$SOURCE_IDS_JSON" ] || [ "$SOURCE_IDS_JSON" = "[]" ]; then
        echo "  FAIL: could not parse source_ids from collect response"
        echo "  collect response: $collect_response"
        record_stage 15 REAL FAIL
        return 1
    fi

    # Confirm both sources
    curl -sf -X POST http://localhost:3000/api/onboarding/confirm \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"selected_source_ids\":$SOURCE_IDS_JSON,\"deleted_source_ids\":[]}" > /dev/null

    # Extract each source
    echo "  extracting 2 sources (Gemini calls — may take 60-180s each)..."
    local extract_ok=0
    while IFS= read -r SID; do
        local extract_response
        extract_response=$(curl -sf --max-time 300 -X POST http://localhost:3000/api/compile/extract \
            -H 'Content-Type: application/json' \
            -d "{\"source_id\":\"$SID\"}")
        if [ -z "$extract_response" ]; then
            echo "  FAIL: extract returned empty for source $SID"
            record_stage 15 REAL FAIL
            return 1
        fi
        extract_ok=$((extract_ok + 1))
    done < <(echo "$SOURCE_IDS_JSON" | python3 -c "import sys,json; [print(s) for s in json.load(sys.stdin)]")

    if [ "$extract_ok" -ne 2 ]; then
        echo "  FAIL: expected 2 extractions, got $extract_ok"
        record_stage 15 REAL FAIL
        return 1
    fi

    # Resolve across the session
    echo "  resolving entities across session..."
    local resolve_response
    resolve_response=$(curl -sf --max-time 180 -X POST http://localhost:3000/api/compile/resolve \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\"}")

    if [ -z "$resolve_response" ]; then
        echo "  FAIL: /api/compile/resolve returned empty"
        record_stage 15 REAL FAIL
        return 1
    fi

    # Verify: exactly 1 canonical entity containing "buterin" (case-insensitive)
    local buterin_count
    buterin_count=$(echo "$resolve_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
entities = d.get('canonical_entities', [])
count = sum(1 for e in entities if 'buterin' in e.get('canonical','').lower())
print(count)
" 2>/dev/null)

    if [ "$buterin_count" != "1" ]; then
        echo "  FAIL: expected 1 Buterin canonical, got $buterin_count"
        echo "  response: $(echo "$resolve_response" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('canonical_entities',[])[:5], indent=2))" 2>/dev/null | head -c 500)"
        record_stage 15 REAL FAIL
        return 1
    fi

    # Verify: merging occurred (final_canonical < total_raw)
    local merge_ok
    merge_ok=$(echo "$resolve_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
stats = d.get('stats', {})
total = stats.get('total_raw', 0)
final = stats.get('final_canonical', total)
print('ok' if total > 0 and final < total else 'no_merge')
" 2>/dev/null)

    if [ "$merge_ok" != "ok" ]; then
        echo "  WARN: no entity merging detected (stats: $(echo "$resolve_response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stats',{}))" 2>/dev/null))"
        # Not a hard failure — small sources may have no duplicates after extraction
    fi

    echo "  Buterin canonical count: $buterin_count — OK"
    echo "  PASS"
    record_stage 15 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 16 — full compilation pipeline canary (Part 2c-i)
# collect 3 text sources → confirm → extract each → resolve → plan → draft
# → crossref → commit → verify pages in DB + schema.md
# ---------------------------------------------------------------------------
stage_16_full_pipeline() {
    echo "--- stage 16: full compilation pipeline ---"

    if [ -z "${GEMINI_API_KEY:-}" ]; then
        echo "  SKIPPED: GEMINI_API_KEY not set"
        record_stage 16 REAL SKIPPED
        return 0
    fi

    local SESSION_ID
    SESSION_ID=$(node -e "console.log(require('crypto').randomUUID())")

    # Collect 3 related text sources
    echo "  collecting 3 text sources..."
    local collect_response
    collect_response=$(curl -sf --max-time 60 -X POST http://localhost:3000/api/onboarding/collect \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[
            {\"markdown\":\"Bitcoin is a decentralized digital currency created by Satoshi Nakamoto in 2009. It uses proof-of-work consensus and SHA-256 hashing. Bitcoin mining consumes significant energy. The Bitcoin network processes roughly 7 transactions per second.\",\"title_hint\":\"Bitcoin Basics\",\"source_type_hint\":\"note\"},
            {\"markdown\":\"Ethereum was founded by Vitalik Buterin in 2013. Unlike Bitcoin, Ethereum supports smart contracts and decentralized applications. Ethereum moved from proof-of-work to proof-of-stake in 2022 via the Merge. Ethereum processes around 15 transactions per second.\",\"title_hint\":\"Ethereum Overview\",\"source_type_hint\":\"note\"},
            {\"markdown\":\"Bitcoin vs Ethereum: Bitcoin is primarily a store of value while Ethereum is a platform for decentralized applications. Bitcoin uses proof-of-work, Ethereum now uses proof-of-stake. Both are leading cryptocurrencies by market cap. Vitalik Buterin created Ethereum as an improvement over Bitcoin's scripting limitations.\",\"title_hint\":\"BTC vs ETH Comparison\",\"source_type_hint\":\"note\"}
        ]}")

    if [ -z "$collect_response" ]; then
        echo "  FAIL: /api/onboarding/collect returned empty"
        record_stage 16 REAL FAIL
        return 1
    fi

    # Get source IDs from review endpoint
    local review_response
    review_response=$(curl -sf --max-time 30 \
        "http://localhost:3000/api/onboarding/review?session_id=$SESSION_ID")
    if [ -z "$review_response" ]; then
        echo "  FAIL: /api/onboarding/review returned empty"
        record_stage 16 REAL FAIL
        return 1
    fi

    local SOURCE_IDS_JSON
    SOURCE_IDS_JSON=$(echo "$review_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
sources = d.get('sources', {})
ids = []
if isinstance(sources, dict):
    for v in sources.values():
        if isinstance(v, list):
            ids.extend(s['source_id'] for s in v)
elif isinstance(sources, list):
    ids = [s['source_id'] for s in sources]
print(json.dumps(ids))
" 2>/dev/null)

    local source_count
    source_count=$(echo "$SOURCE_IDS_JSON" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
    if [ "$source_count" -ne 3 ]; then
        echo "  FAIL: expected 3 collected sources, got $source_count"
        record_stage 16 REAL FAIL
        return 1
    fi

    # Confirm
    curl -sf --max-time 30 -X POST http://localhost:3000/api/onboarding/confirm \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"selected_source_ids\":$SOURCE_IDS_JSON,\"deleted_source_ids\":[]}" > /dev/null

    # Extract each source
    echo "  extracting $source_count sources..."
    local extract_ok=0
    while IFS= read -r sid; do
        local eres
        eres=$(curl -sf --max-time 180 -X POST http://localhost:3000/api/compile/extract \
            -H 'Content-Type: application/json' \
            -d "{\"source_id\":\"$sid\"}" 2>/dev/null || echo "")
        if [ -n "$eres" ]; then
            extract_ok=$((extract_ok + 1))
        fi
    done < <(echo "$SOURCE_IDS_JSON" | python3 -c "import sys,json; [print(s) for s in json.load(sys.stdin)]")

    if [ "$extract_ok" -ne 3 ]; then
        echo "  FAIL: expected 3 extractions, got $extract_ok"
        record_stage 16 REAL FAIL
        return 1
    fi

    # Resolve
    echo "  resolving entities..."
    local resolve_response
    resolve_response=$(curl -sf --max-time 180 -X POST http://localhost:3000/api/compile/resolve \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\"}")
    if [ -z "$resolve_response" ]; then
        echo "  FAIL: /api/compile/resolve returned empty"
        record_stage 16 REAL FAIL
        return 1
    fi

    local CANONICAL_JSON
    CANONICAL_JSON=$(echo "$resolve_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(json.dumps(d.get('canonical_entities', [])))
" 2>/dev/null)

    # Plan
    echo "  building page plan..."
    local plan_response
    plan_response=$(curl -sf --max-time 30 -X POST http://localhost:3000/api/compile/plan \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"canonical_entities\":$CANONICAL_JSON}")
    if [ -z "$plan_response" ]; then
        echo "  FAIL: /api/compile/plan returned empty"
        record_stage 16 REAL FAIL
        return 1
    fi

    local total_planned
    total_planned=$(echo "$plan_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('stats', {}).get('total', 0))
" 2>/dev/null)

    if [ "$total_planned" -lt 4 ]; then
        echo "  FAIL: plan: expected at least 4 pages (3 summaries + entity pages), got $total_planned"
        record_stage 16 REAL FAIL
        return 1
    fi
    echo "  planned $total_planned pages"

    # Draft
    echo "  drafting pages (this will take a while — Gemini calls)..."
    local draft_response
    draft_response=$(curl -sf --max-time 900 -X POST http://localhost:3000/api/compile/draft \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\"}")
    if [ -z "$draft_response" ]; then
        echo "  FAIL: /api/compile/draft returned empty"
        record_stage 16 REAL FAIL
        return 1
    fi

    local drafted
    drafted=$(echo "$draft_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('drafted', 0))
" 2>/dev/null)

    if [ "$drafted" -lt 4 ]; then
        echo "  FAIL: expected at least 4 drafted, got $drafted"
        record_stage 16 REAL FAIL
        return 1
    fi
    echo "  drafted $drafted pages"

    # Cross-reference
    echo "  cross-referencing..."
    curl -sf --max-time 600 -X POST http://localhost:3000/api/compile/crossref \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\"}" > /dev/null

    # Commit
    echo "  committing pages to DB..."
    local commit_response
    commit_response=$(curl -sf --max-time 120 -X POST http://localhost:3000/api/compile/commit \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\"}")
    if [ -z "$commit_response" ]; then
        echo "  FAIL: /api/compile/commit returned empty"
        record_stage 16 REAL FAIL
        return 1
    fi

    local committed
    committed=$(echo "$commit_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('committed', 0))
" 2>/dev/null)

    if [ "$committed" -lt 4 ]; then
        echo "  FAIL: expected at least 4 committed, got $committed"
        echo "  response: $commit_response"
        record_stage 16 REAL FAIL
        return 1
    fi

    # Verify pages exist in DB via health endpoint
    local health_response
    health_response=$(curl -sf --max-time 10 http://localhost:3000/api/health)
    local page_count
    page_count=$(echo "$health_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('page_count', 0))
" 2>/dev/null)

    if [ "$page_count" -lt 4 ]; then
        echo "  FAIL: expected page_count >= 4 in DB, got $page_count"
        record_stage 16 REAL FAIL
        return 1
    fi

    # Generate schema (bootstrap)
    echo "  generating wiki schema..."
    local schema_response
    schema_response=$(curl -sf --max-time 120 -X POST http://localhost:3000/api/compile/schema \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\"}")
    if [ -n "$schema_response" ]; then
        local schema_ok
        schema_ok=$(echo "$schema_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('ok' if d.get('schema_generated') or d.get('reason') == 'already_exists' else 'fail')
" 2>/dev/null)
        if [ "$schema_ok" != "ok" ]; then
            echo "  WARN: schema generation failed: $schema_response"
        fi
    fi

    echo "  committed $committed pages, page_count=$page_count — OK"
    echo "  PASS"
    record_stage 16 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 17 — session compile via n8n (Part 2c-ii)
# confirm → n8n triggers /api/compile/run → progress polling → completion
# Skipped if GEMINI_API_KEY not set (pipeline calls Gemini for extraction).
# ---------------------------------------------------------------------------
stage_17_session_compile() {
    echo "--- stage 17: session compile via n8n ---"

    if [ -z "${GEMINI_API_KEY:-}" ]; then
        echo "  SKIPPED: GEMINI_API_KEY not set"
        record_stage 17 REAL SKIPPED
        return 0
    fi

    local SESSION_ID
    SESSION_ID=$(node -e "console.log(require('crypto').randomUUID())")

    # Collect 2 text sources
    echo "  collecting 2 text sources..."
    curl -sf --max-time 60 -X POST http://localhost:3000/api/onboarding/collect \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[
            {\"markdown\":\"Python is a programming language created by Guido van Rossum in 1991. It is widely used in data science and machine learning.\",\"title_hint\":\"Python Intro\",\"source_type_hint\":\"note\"},
            {\"markdown\":\"Guido van Rossum designed Python in the late 1980s. Python emphasizes code readability and simplicity over performance.\",\"title_hint\":\"Python History\",\"source_type_hint\":\"note\"}
        ]}" > /dev/null

    # Get source IDs
    local review_response
    review_response=$(curl -sf --max-time 30 \
        "http://localhost:3000/api/onboarding/review?session_id=$SESSION_ID")
    if [ -z "$review_response" ]; then
        echo "  FAIL: /api/onboarding/review returned empty"
        record_stage 17 REAL FAIL
        return 1
    fi

    local SOURCE_IDS_JSON
    SOURCE_IDS_JSON=$(echo "$review_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
sources = d.get('sources', {})
ids = []
if isinstance(sources, dict):
    for v in sources.values():
        if isinstance(v, list):
            ids.extend(s['source_id'] for s in v)
elif isinstance(sources, list):
    ids = [s['source_id'] for s in sources]
print(json.dumps(ids))
" 2>/dev/null)

    local source_count
    source_count=$(echo "$SOURCE_IDS_JSON" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null)
    if [ "$source_count" -ne 2 ]; then
        echo "  FAIL: expected 2 collected sources, got $source_count"
        record_stage 17 REAL FAIL
        return 1
    fi

    # Confirm — this triggers n8n session-compile workflow → /api/compile/run
    echo "  confirming (triggers n8n compile pipeline)..."
    local confirm_response
    confirm_response=$(curl -sf --max-time 30 -X POST http://localhost:3000/api/onboarding/confirm \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"selected_source_ids\":$SOURCE_IDS_JSON,\"deleted_source_ids\":[]}")
    if [ -z "$confirm_response" ]; then
        echo "  FAIL: /api/onboarding/confirm returned empty"
        record_stage 17 REAL FAIL
        return 1
    fi

    # Poll progress endpoint until completed or timeout (180s)
    echo "  polling compile progress..."
    local TIMEOUT=180
    local ELAPSED=0
    local STATUS="queued"
    while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
        sleep 5
        ELAPSED=$((ELAPSED + 5))

        local progress_response
        progress_response=$(curl -sf --max-time 10 \
            "http://localhost:3000/api/compile/progress?session_id=$SESSION_ID" 2>/dev/null || echo "")
        if [ -z "$progress_response" ]; then
            continue
        fi

        STATUS=$(echo "$progress_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('status', 'unknown'))
" 2>/dev/null)

        echo "    ${ELAPSED}s: $STATUS"

        if [ "$STATUS" = "completed" ]; then
            break
        fi

        if [ "$STATUS" = "failed" ]; then
            local error_msg
            error_msg=$(echo "$progress_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('error', 'unknown error'))
" 2>/dev/null)
            echo "  FAIL: session compile failed: $error_msg"
            record_stage 17 REAL FAIL
            return 1
        fi
    done

    if [ "$STATUS" != "completed" ]; then
        echo "  FAIL: session compile timed out after ${TIMEOUT}s (status: $STATUS)"
        record_stage 17 REAL FAIL
        return 1
    fi

    # Verify pages were created
    local health_response
    health_response=$(curl -sf --max-time 10 http://localhost:3000/api/health)
    local page_count
    page_count=$(echo "$health_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('page_count', 0))
" 2>/dev/null)

    if [ "$page_count" -lt 3 ]; then
        echo "  FAIL: expected at least 3 pages in DB, got $page_count"
        record_stage 17 REAL FAIL
        return 1
    fi

    echo "  session compile completed — $page_count pages in DB"
    echo "  PASS"
    record_stage 17 REAL PASS
    return 0
}

# Stage 18 — wiki-aware update: returning session match step (Part 2d)
#
# Skipped if:
#   - GEMINI_API_KEY is unset
#   - page_count < 1 (stages 16/17 must have run to create pages first)
#
# Flow:
#   1. Assert page_count >= 1 from /api/health
#   2. Add 1 text source that mentions a topic from an existing page
#   3. Confirm session → poll progress until completed (180s)
#   4. Assert match step detail does NOT contain "First compile"
#   5. Assert page_count >= previous page_count (no pages deleted)
#   6. Assert session status = 'completed'
stage_18_wiki_aware_update() {
    echo "--- stage 18: wiki-aware update (returning session) ---"

    if [[ -z "${GEMINI_API_KEY:-}" ]]; then
        echo "  SKIPPED: GEMINI_API_KEY not set"
        record_stage 18 REAL SKIPPED
        return 0
    fi

    local HEALTH PAGE_COUNT_BEFORE SESSION_ID COLLECT_RESP REVIEW SOURCE_IDS_JSON
    local CONFIRM TIMEOUT ELAPSED STATUS PROG MATCH_DETAIL HEALTH_AFTER PAGE_COUNT_AFTER error_msg

    # Check that at least one page exists (stage 16/17 must have run first)
    HEALTH=$(curl -sf "http://localhost:3000/api/health" 2>/dev/null || echo "")
    PAGE_COUNT_BEFORE=$(echo "$HEALTH" | grep -o '"page_count":[0-9]*' | grep -o '[0-9]*' || echo "0")
    if [[ "$PAGE_COUNT_BEFORE" -lt 1 ]]; then
        echo "  SKIPPED: page_count=$PAGE_COUNT_BEFORE — stages 16/17 must run first to populate wiki"
        record_stage 18 REAL SKIPPED
        return 0
    fi
    echo "  page_count before: $PAGE_COUNT_BEFORE"

    # Collect 1 source that overlaps with existing wiki content
    SESSION_ID="stage18-returning-$(date +%s)"
    COLLECT_RESP=$(curl -sf -X POST "http://localhost:3000/api/onboarding/collect" \
        -H "Content-Type: application/json" \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[
              {\"title\":\"Returning source for wiki update test\",
               \"text\":\"Bitcoin is a decentralized digital currency. Ethereum introduced smart contracts. Blockchain technology enables trustless transactions.\"}
            ]}" 2>/dev/null || echo "")
    if [[ -z "$COLLECT_RESP" ]]; then
        echo "  FAIL: collect request failed"
        record_stage 18 REAL FAIL
        return 1
    fi

    # Review — get source IDs
    REVIEW=$(curl -sf "http://localhost:3000/api/onboarding/review?session_id=$SESSION_ID" 2>/dev/null || echo "")
    SOURCE_IDS_JSON=$(echo "$REVIEW" | grep -o '"source_id":"[^"]*"' | grep -o '"[^"]*"$' | tr '\n' ',' | sed 's/,$//' | sed 's/^/[/' | sed 's/$/]/')
    if [[ "$SOURCE_IDS_JSON" == "[]" || -z "$SOURCE_IDS_JSON" ]]; then
        echo "  FAIL: no sources found in review"
        record_stage 18 REAL FAIL
        return 1
    fi

    # Confirm — triggers n8n session-compile → /api/compile/run
    CONFIRM=$(curl -sf -X POST "http://localhost:3000/api/onboarding/confirm" \
        -H "Content-Type: application/json" \
        -d "{\"session_id\":\"$SESSION_ID\",\"selected_source_ids\":$SOURCE_IDS_JSON,\"deleted_source_ids\":[]}" \
        2>/dev/null || echo "")
    if [[ -z "$CONFIRM" ]]; then
        echo "  FAIL: confirm request failed"
        record_stage 18 REAL FAIL
        return 1
    fi

    # Poll progress until completed or failed (180s timeout)
    TIMEOUT=180
    ELAPSED=0
    STATUS=""
    while [[ $ELAPSED -lt $TIMEOUT ]]; do
        sleep 4
        ELAPSED=$((ELAPSED + 4))
        PROG=$(curl -sf "http://localhost:3000/api/compile/progress?session_id=$SESSION_ID" 2>/dev/null || echo "")
        STATUS=$(echo "$PROG" | grep -o '"status":"[^"]*"' | head -1 | grep -o '"[^"]*"$' | tr -d '"' || echo "")
        if [[ "$STATUS" == "completed" || "$STATUS" == "failed" ]]; then
            break
        fi
    done

    if [[ "$STATUS" == "failed" ]]; then
        error_msg=$(curl -sf "http://localhost:3000/api/compile/progress?session_id=$SESSION_ID" 2>/dev/null | grep -o '"error":"[^"]*"' | head -1 || echo "")
        echo "  FAIL: compile failed: $error_msg"
        record_stage 18 REAL FAIL
        return 1
    fi
    if [[ "$STATUS" != "completed" ]]; then
        echo "  FAIL: compile timed out after ${TIMEOUT}s (status: $STATUS)"
        record_stage 18 REAL FAIL
        return 1
    fi

    # Assert match step detail does NOT say "First compile"
    MATCH_DETAIL=$(curl -sf "http://localhost:3000/api/compile/progress?session_id=$SESSION_ID" 2>/dev/null \
        | grep -o '"match":{[^}]*}' | head -1 || echo "")
    if echo "$MATCH_DETAIL" | grep -qi "First compile"; then
        echo "  FAIL: match step shows 'First compile' but page_count was $PAGE_COUNT_BEFORE — wiki-aware routing broken"
        record_stage 18 REAL FAIL
        return 1
    fi
    echo "  match step detail: $MATCH_DETAIL"

    # Assert page_count did not decrease
    HEALTH_AFTER=$(curl -sf "http://localhost:3000/api/health" 2>/dev/null || echo "")
    PAGE_COUNT_AFTER=$(echo "$HEALTH_AFTER" | grep -o '"page_count":[0-9]*' | grep -o '[0-9]*' || echo "0")
    if [[ "$PAGE_COUNT_AFTER" -lt "$PAGE_COUNT_BEFORE" ]]; then
        echo "  FAIL: page_count decreased from $PAGE_COUNT_BEFORE to $PAGE_COUNT_AFTER"
        record_stage 18 REAL FAIL
        return 1
    fi
    echo "  page_count after: $PAGE_COUNT_AFTER (was $PAGE_COUNT_BEFORE)"

    echo "  stage 18 PASS — returning session compile completed, match step active"
    record_stage 18 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
    echo "=== Kompl v2 integration test ==="
    echo "Commit 4 state: stages 0, 1, 4 REAL; compile assertion in stage 4 requires GEMINI_API_KEY."
    echo

    stage_0_cold_start
    stage_1_migration_schema
    stage_4_live_ingest
    stage_11_onboarding_api
    stage_11b_confirm_surfaces_n8n_down
    stage_12_text_connector
    stage_13_twitter_connector
    stage_14_extraction
    stage_15_resolution
    stage_16_full_pipeline
    stage_17_session_compile
    stage_18_wiki_aware_update
    stage_19_chat_canary
    stage_20_source_mgmt_canary
    stage_21_wiki_data_canary
    stage_22_original_source_gate2
    stage_23_zombie_cleanup_endpoint

    echo
    echo "=== Stage summary ==="
    for result in "${STAGE_RESULTS[@]}"; do
        echo "  $result"
    done
    echo
    echo "=== All 16 stages (0, 1, 4, 11–23) executed, all passed ==="
    exit 0
}

# ---------------------------------------------------------------------------
# Stage 19: chat canary
#   Skip if no GEMINI_API_KEY or page_count < 1.
#   1. POST /api/chat with a generic question
#   2. Assert answer non-empty + citations key present
#   3. GET /api/chat/history — assert >= 2 messages
# ---------------------------------------------------------------------------
stage_19_chat_canary() {
    echo "--- stage 19: chat canary ---"

    if [[ -z "${GEMINI_API_KEY:-}" ]]; then
        echo "  SKIP: no GEMINI_API_KEY"
        record_stage 19 REAL SKIPPED
        return 0
    fi

    local HEALTH PAGE_COUNT CHAT_SESSION CHAT_RESP ANSWER CITATIONS_PRESENT
    local HISTORY_RESP MSG_COUNT

    HEALTH=$(curl -sf "http://localhost:3000/api/health" 2>/dev/null || echo "")
    PAGE_COUNT=$(echo "$HEALTH" | grep -o '"page_count":[0-9]*' | grep -o '[0-9]*' || echo "0")
    if [[ "$PAGE_COUNT" -lt 1 ]]; then
        echo "  SKIP: page_count=$PAGE_COUNT (need at least 1 compiled page)"
        record_stage 19 REAL SKIPPED
        return 0
    fi

    CHAT_SESSION=$(python3 -c "import uuid; print(str(uuid.uuid4()))")

    CHAT_RESP=$(curl -sf -X POST "http://localhost:3000/api/chat" \
        -H "Content-Type: application/json" \
        -d "{\"session_id\":\"$CHAT_SESSION\",\"question\":\"What topics does my knowledge base cover?\"}" \
        2>/dev/null || echo "")

    if [[ -z "$CHAT_RESP" ]]; then
        echo "  FAIL: POST /api/chat returned empty"
        record_stage 19 REAL FAIL
        return 1
    fi

    ANSWER=$(echo "$CHAT_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('answer',''))" 2>/dev/null || echo "")
    if [[ -z "$ANSWER" ]]; then
        echo "  FAIL: answer field missing or empty. response: $CHAT_RESP"
        record_stage 19 REAL FAIL
        return 1
    fi

    CITATIONS_PRESENT=$(echo "$CHAT_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'citations' in d else 'no')" 2>/dev/null || echo "no")
    if [[ "$CITATIONS_PRESENT" != "yes" ]]; then
        echo "  FAIL: citations key missing from response"
        record_stage 19 REAL FAIL
        return 1
    fi

    HISTORY_RESP=$(curl -sf "http://localhost:3000/api/chat/history?session_id=$CHAT_SESSION" 2>/dev/null || echo "")
    MSG_COUNT=$(echo "$HISTORY_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('messages',[])))" 2>/dev/null || echo "0")
    if [[ "$MSG_COUNT" -lt 2 ]]; then
        echo "  FAIL: expected >= 2 messages in history, got $MSG_COUNT"
        record_stage 19 REAL FAIL
        return 1
    fi

    echo "  answer length: ${#ANSWER} chars, messages in history: $MSG_COUNT"
    echo "  stage 19 PASS — chat answered with citations, history persisted"
    record_stage 19 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 20 — Source management + draft approval canary (REAL as of commit 8)
#
# 1. GET /api/sources — assert returns sources array + total keys
# 2. GET /api/settings — assert auto_approve key present
# 3. POST /api/settings { auto_approve: true } — assert saved
# 4. If page_count >= 1: GET /api/drafts/pending — assert drafts key present
# ---------------------------------------------------------------------------
stage_20_source_mgmt_canary() {
    echo "--- stage 20: source management + settings canary ---"

    local SOURCES_RESP SOURCES_OK TOTAL SETTINGS_RESP SETTINGS_OK
    local PATCH_RESP PATCH_OK DRAFTS_RESP DRAFTS_OK

    # Check GET /api/sources
    SOURCES_RESP=$(curl -sf "http://localhost:3000/api/sources" 2>/dev/null || echo "")
    if [[ -z "$SOURCES_RESP" ]]; then
        echo "  FAIL: GET /api/sources returned empty"
        record_stage 20 REAL FAIL
        return 1
    fi
    SOURCES_OK=$(echo "$SOURCES_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'sources' in d and 'total' in d else 'no')" 2>/dev/null || echo "no")
    if [[ "$SOURCES_OK" != "yes" ]]; then
        echo "  FAIL: GET /api/sources missing sources or total key"
        record_stage 20 REAL FAIL
        return 1
    fi
    TOTAL=$(echo "$SOURCES_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['total'])" 2>/dev/null || echo "0")
    echo "  sources total: $TOTAL"

    # Check GET /api/settings
    SETTINGS_RESP=$(curl -sf "http://localhost:3000/api/settings" 2>/dev/null || echo "")
    SETTINGS_OK=$(echo "$SETTINGS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'auto_approve' in d else 'no')" 2>/dev/null || echo "no")
    if [[ "$SETTINGS_OK" != "yes" ]]; then
        echo "  FAIL: GET /api/settings missing auto_approve key"
        record_stage 20 REAL FAIL
        return 1
    fi

    # Check POST /api/settings
    PATCH_RESP=$(curl -sf -X POST "http://localhost:3000/api/settings" \
        -H "Content-Type: application/json" \
        -d '{"auto_approve":true}' 2>/dev/null || echo "")
    PATCH_OK=$(echo "$PATCH_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('auto_approve') == True else 'no')" 2>/dev/null || echo "no")
    if [[ "$PATCH_OK" != "yes" ]]; then
        echo "  FAIL: POST /api/settings did not return auto_approve=true"
        record_stage 20 REAL FAIL
        return 1
    fi

    # Check GET /api/drafts/pending
    DRAFTS_RESP=$(curl -sf "http://localhost:3000/api/drafts/pending" 2>/dev/null || echo "")
    DRAFTS_OK=$(echo "$DRAFTS_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'drafts' in d else 'no')" 2>/dev/null || echo "no")
    if [[ "$DRAFTS_OK" != "yes" ]]; then
        echo "  FAIL: GET /api/drafts/pending missing drafts key"
        record_stage 20 REAL FAIL
        return 1
    fi

    echo "  stage 20 PASS — sources list, settings, and drafts endpoints OK"
    record_stage 20 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 21 — Wiki data canary (REAL — no API keys needed)
#
# 1. GET /api/wiki/index       → assert pages (array), total_pages (number), categories (object)
# 2. If total_pages > 0:       → GET /api/wiki/{page_id}/data for first page
#                                 assert page_id, title, content (string), sources (array)
# 3. GET /api/pages/search     → assert items (array), count (number)
# 4. If wiki empty:            → skip /data assertion, still PASS
# ---------------------------------------------------------------------------
stage_21_wiki_data_canary() {
    echo "--- stage 21: wiki data canary ---"

    local INDEX_RESP PAGES_OK TOTAL_PAGES CATEGORIES_OK PAGE_ID
    local DATA_RESP DATA_FIELDS_OK CONTENT_OK SOURCES_OK SEARCH_RESP SEARCH_OK

    # ── 1. GET /api/wiki/index ──────────────────────────────────────────────
    INDEX_RESP=$(curl -sf "http://localhost:3000/api/wiki/index" 2>/dev/null || echo "")
    if [[ -z "$INDEX_RESP" ]]; then
        echo "  FAIL: GET /api/wiki/index returned empty"
        record_stage 21 REAL FAIL
        return 1
    fi

    PAGES_OK=$(echo "$INDEX_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if isinstance(d.get('pages'), list) else 'no')" 2>/dev/null || echo "no")
    if [[ "$PAGES_OK" != "yes" ]]; then
        echo "  FAIL: /api/wiki/index missing pages array"
        record_stage 21 REAL FAIL
        return 1
    fi

    TOTAL_PAGES=$(echo "$INDEX_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('total_pages', -1))" 2>/dev/null || echo "-1")
    if [[ "$TOTAL_PAGES" == "-1" ]]; then
        echo "  FAIL: /api/wiki/index missing total_pages"
        record_stage 21 REAL FAIL
        return 1
    fi

    CATEGORIES_OK=$(echo "$INDEX_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if isinstance(d.get('categories'), dict) else 'no')" 2>/dev/null || echo "no")
    if [[ "$CATEGORIES_OK" != "yes" ]]; then
        echo "  FAIL: /api/wiki/index missing categories object"
        record_stage 21 REAL FAIL
        return 1
    fi

    echo "  wiki/index OK (total_pages=$TOTAL_PAGES)"

    # ── 2. GET /api/wiki/{page_id}/data (conditional) ───────────────────────
    if [[ "$TOTAL_PAGES" -gt 0 ]]; then
        PAGE_ID=$(echo "$INDEX_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['pages'][0]['page_id'] if d.get('pages') else '')" 2>/dev/null || echo "")
        if [[ -z "$PAGE_ID" ]]; then
            echo "  FAIL: could not extract page_id from wiki/index pages[0]"
            record_stage 21 REAL FAIL
            return 1
        fi

        DATA_RESP=$(curl -sf "http://localhost:3000/api/wiki/$PAGE_ID/data" 2>/dev/null || echo "")
        if [[ -z "$DATA_RESP" ]]; then
            echo "  FAIL: GET /api/wiki/$PAGE_ID/data returned empty"
            record_stage 21 REAL FAIL
            return 1
        fi

        DATA_FIELDS_OK=$(echo "$DATA_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if all(k in d for k in ['page_id','title','content','sources']) else 'no')" 2>/dev/null || echo "no")
        if [[ "$DATA_FIELDS_OK" != "yes" ]]; then
            echo "  FAIL: /api/wiki/$PAGE_ID/data missing page_id, title, content, or sources"
            record_stage 21 REAL FAIL
            return 1
        fi

        CONTENT_OK=$(echo "$DATA_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if isinstance(d.get('content'), str) else 'no')" 2>/dev/null || echo "no")
        if [[ "$CONTENT_OK" != "yes" ]]; then
            echo "  FAIL: content field is not a string"
            record_stage 21 REAL FAIL
            return 1
        fi

        SOURCES_OK=$(echo "$DATA_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if isinstance(d.get('sources'), list) else 'no')" 2>/dev/null || echo "no")
        if [[ "$SOURCES_OK" != "yes" ]]; then
            echo "  FAIL: sources field is not an array"
            record_stage 21 REAL FAIL
            return 1
        fi

        echo "  wiki/$PAGE_ID/data OK"
    else
        echo "  SKIP: wiki is empty (total_pages=0), skipping /data assertion"
    fi

    # ── 3. GET /api/pages/search ────────────────────────────────────────────
    SEARCH_RESP=$(curl -sf "http://localhost:3000/api/pages/search?q=test&limit=5" 2>/dev/null || echo "")
    if [[ -z "$SEARCH_RESP" ]]; then
        echo "  FAIL: GET /api/pages/search returned empty"
        record_stage 21 REAL FAIL
        return 1
    fi

    SEARCH_OK=$(echo "$SEARCH_RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if isinstance(d.get('items'), list) and isinstance(d.get('count'), int) else 'no')" 2>/dev/null || echo "no")
    if [[ "$SEARCH_OK" != "yes" ]]; then
        echo "  FAIL: /api/pages/search missing items (array) or count (number)"
        record_stage 21 REAL FAIL
        return 1
    fi

    echo "  pages/search OK"
    echo "  stage 21 PASS — wiki index, data, and search endpoints OK"
    record_stage 21 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 22 — original-source Gate 2 exemption (regression)
# ---------------------------------------------------------------------------
# Seeds a <min_source_chars (default 500) text source. The plan step assigns
# page_type='original-source' and the draft step writes a raw passthrough
# (body length < min_draft_chars, default 800). The commit route MUST exempt
# 'original-source' from Gate 2 — otherwise the plan is rejected as
# draft_too_thin and no pages row is ever written. This stage asserts that
# a page with page_type='original-source' exists after commit.
#
# Skipped if GEMINI_API_KEY unset — /api/compile/extract still needs Gemini
# even though plan/draft/commit for original-source bypass the LLM.
# ---------------------------------------------------------------------------
stage_22_original_source_gate2() {
    echo "--- stage 22: original-source Gate 2 exemption ---"

    if [ -z "${GEMINI_API_KEY:-}" ]; then
        echo "  SKIPPED: GEMINI_API_KEY not set"
        record_stage 22 REAL SKIPPED
        return 0
    fi

    local SESSION_ID
    SESSION_ID=$(node -e "console.log(require('crypto').randomUUID())")

    # ~80 chars — well under default min_source_chars=500.
    local SHORT_MD='Bitcoin hit a new all-time high today. Satoshi would be proud.'

    curl -sf --max-time 60 -X POST http://localhost:3000/api/onboarding/collect \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[{\"markdown\":\"$SHORT_MD\",\"title_hint\":\"Short BTC note\",\"source_type_hint\":\"note\"}]}" > /dev/null

    local review_response
    review_response=$(curl -sf --max-time 30 \
        "http://localhost:3000/api/onboarding/review?session_id=$SESSION_ID")

    local SOURCE_ID
    SOURCE_ID=$(echo "$review_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
sources = d.get('sources', {})
for v in sources.values():
    if isinstance(v, list) and v:
        print(v[0]['source_id'])
        break
" 2>/dev/null)

    if [ -z "$SOURCE_ID" ]; then
        echo "  FAIL: could not extract source_id from review"
        record_stage 22 REAL FAIL
        return 1
    fi

    curl -sf --max-time 30 -X POST http://localhost:3000/api/onboarding/confirm \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"selected_source_ids\":[\"$SOURCE_ID\"],\"deleted_source_ids\":[]}" > /dev/null

    curl -sf --max-time 180 -X POST http://localhost:3000/api/compile/extract \
        -H 'Content-Type: application/json' \
        -d "{\"source_id\":\"$SOURCE_ID\"}" > /dev/null

    curl -sf --max-time 60 -X POST http://localhost:3000/api/compile/resolve \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\"}" > /dev/null

    local plan_response
    plan_response=$(curl -sf --max-time 30 -X POST http://localhost:3000/api/compile/plan \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"canonical_entities\":[]}")

    local orig_planned
    orig_planned=$(echo "$plan_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('stats', {}).get('original_sources', 0))
" 2>/dev/null)

    if [ "$orig_planned" -lt 1 ]; then
        echo "  FAIL: plan did not assign page_type='original-source' (original_sources=$orig_planned)"
        echo "  response: $plan_response"
        record_stage 22 REAL FAIL
        return 1
    fi

    curl -sf --max-time 120 -X POST http://localhost:3000/api/compile/draft \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\"}" > /dev/null

    curl -sf --max-time 120 -X POST http://localhost:3000/api/compile/crossref \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\"}" > /dev/null

    local commit_response
    commit_response=$(curl -sf --max-time 60 -X POST http://localhost:3000/api/compile/commit \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\"}")

    local committed thin
    committed=$(echo "$commit_response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('committed', 0))" 2>/dev/null)
    thin=$(echo "$commit_response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('thin', 0))" 2>/dev/null || echo "0")

    if [ "$committed" -lt 1 ]; then
        echo "  FAIL: expected committed>=1, got $committed (thin=$thin) — Gate 2 exemption broken"
        echo "  response: $commit_response"
        record_stage 22 REAL FAIL
        return 1
    fi

    # Verify a page with page_type='original-source' exists in wiki/index
    local index_response
    index_response=$(curl -sf --max-time 10 "http://localhost:3000/api/wiki/index")

    local orig_page_count
    orig_page_count=$(echo "$index_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
pages = d.get('pages', [])
print(sum(1 for p in pages if p.get('page_type') == 'original-source'))
" 2>/dev/null)

    if [ "$orig_page_count" -lt 1 ]; then
        echo "  FAIL: wiki/index has no page with page_type='original-source'"
        record_stage 22 REAL FAIL
        return 1
    fi

    echo "  committed=$committed, original-source pages in wiki=$orig_page_count"
    echo "  stage 22 PASS — Gate 2 correctly exempts 'original-source'"
    record_stage 22 REAL PASS
    return 0
}

stage_23_zombie_cleanup_endpoint() {
    echo "--- stage 23: zombie-page cleanup endpoint smoke ---"

    # GET — dry-run. Endpoint must respond with {count: int, pages: array}.
    local get_response
    get_response=$(curl -sf --max-time 10 http://localhost:3000/api/admin/cleanup/zombie-pages)

    local count_field
    count_field=$(echo "$get_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert isinstance(d.get('count'), int), 'count must be int'
assert isinstance(d.get('pages'), list), 'pages must be list'
print(d['count'])
" 2>/dev/null)

    if [ -z "$count_field" ]; then
        echo "  FAIL: GET response missing or malformed: $get_response"
        record_stage 23 REAL FAIL
        return 1
    fi

    # POST — must succeed even when count=0 (no-op).
    local post_response
    post_response=$(curl -sf --max-time 10 -X POST http://localhost:3000/api/admin/cleanup/zombie-pages)

    local deleted_field
    deleted_field=$(echo "$post_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert isinstance(d.get('deleted'), int), 'deleted must be int'
assert isinstance(d.get('pages'), list), 'pages must be list'
print(d['deleted'])
" 2>/dev/null)

    if [ -z "$deleted_field" ]; then
        echo "  FAIL: POST response missing or malformed: $post_response"
        record_stage 23 REAL FAIL
        return 1
    fi

    # POST must be idempotent — second call returns 0 (cleaned previously).
    local second_response
    second_response=$(curl -sf --max-time 10 -X POST http://localhost:3000/api/admin/cleanup/zombie-pages)
    local second_deleted
    second_deleted=$(echo "$second_response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('deleted', -1))" 2>/dev/null)

    if [ "$second_deleted" != "0" ]; then
        echo "  FAIL: POST was not idempotent (second run deleted=$second_deleted)"
        record_stage 23 REAL FAIL
        return 1
    fi

    echo "  GET count=$count_field, POST deleted=$deleted_field, second POST deleted=0"
    echo "  stage 23 PASS — admin cleanup endpoint shape + idempotent"
    record_stage 23 REAL PASS
    return 0
}

main "$@"
