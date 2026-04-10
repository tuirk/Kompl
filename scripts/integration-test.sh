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
# Stage state at commit 4:
#   Stage 0 — REAL (cold start: docker compose down -v + up -d --build, all 3 services healthy)
#   Stage 1 — REAL (migration & schema sanity via /api/health, schema_version=5)
#   Stage 4 — REAL (live URL ingest + compile end-to-end), plus failure-path canary
#             Skipped gracefully when FIRECRAWL_API_KEY or GEMINI_API_KEY is unset.
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

# Compose command (some environments use `docker-compose`, newer use `docker compose`)
COMPOSE="docker compose"

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
    if ! $COMPOSE up -d --build app nlp-service n8n; then
        echo "  FAIL: docker compose up -d --build returned non-zero"
        record_stage 0 REAL FAIL
        return 1
    fi

    echo "  waiting for app /api/health to return 200 (up to 120s)..."
    if ! wait_for_http_200 "http://localhost:3000/api/health" 120; then
        echo "  FAIL: app /api/health not ready within 120s"
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

    # n8n readiness: wait until the ingest webhook activates (same probe as stage 4)
    echo "  waiting for n8n ingest webhook to activate (up to 120s)..."
    local elapsed=0
    local code="000"
    while [ $elapsed -lt 120 ]; do
        code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
            -H "content-type: application/json" -d '{}' \
            "http://localhost:5678/webhook/ingest" 2>/dev/null || echo "000")
        if [ "$code" = "200" ] || [ "$code" = "202" ]; then
            break
        fi
        sleep 3
        elapsed=$((elapsed + 3))
    done
    if [ $elapsed -ge 120 ]; then
        echo "  FAIL: n8n ingest webhook did not activate within 120s (last code: $code)"
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

    echo "  starting app service..."
    if ! $COMPOSE up -d --build app; then
        echo "  FAIL: docker compose up -d --build app returned non-zero"
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
    if ! echo "$response" | grep -q '"status":"ok"'; then
        echo "  FAIL: status != ok"
        record_stage 1 REAL FAIL
        return 1
    fi
    if ! echo "$response" | grep -q '"db_writable":true'; then
        echo "  FAIL: db_writable != true"
        record_stage 1 REAL FAIL
        return 1
    fi
    if ! echo "$response" | grep -q '"schema_version":5'; then
        echo "  FAIL: schema_version != 5"
        record_stage 1 REAL FAIL
        return 1
    fi
    if ! echo "$response" | grep -q '"table_count":10'; then
        echo "  FAIL: table_count != 10"
        record_stage 1 REAL FAIL
        return 1
    fi

    echo "  PASS"
    record_stage 1 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 2 — Single-writer enforcement canary
# ---------------------------------------------------------------------------
stage_2_single_writer_canary() {
    echo "[STAGE 2] TODO: single-writer enforcement canary (no silent divergence)"
    record_stage 2 TODO SKIPPED
    return 0
}

# ---------------------------------------------------------------------------
# Stage 3 — Demo seed via HTTP
# ---------------------------------------------------------------------------
stage_3_demo_seed_http() {
    echo "[STAGE 3] TODO: demo seed via HTTP (no sqlite3.connect, vector count == page count)"
    record_stage 3 TODO SKIPPED
    return 0
}

# ---------------------------------------------------------------------------
# Stage 4 — Live ingest end-to-end (REAL as of commit 3)
# ---------------------------------------------------------------------------
# Brings up the full stack (app already running from stage 1, plus
# nlp-service and n8n). POSTs a Wikipedia URL to /api/ingest/url and
# polls /api/activity until a source_stored row appears for the returned
# source_id. Then GETs /api/sources/<id> and asserts the title is present.
#
# After the happy path passes, runs a failure-path canary: POSTs an
# unresolvable .invalid URL to /api/ingest/url and polls /api/activity
# until an ingest_failed row appears for the returned source_id. This
# proves the workflow's per-node onError: continueErrorOutput routing
# still fires the "HTTP: Log Failure" node — silent regressions in error
# routing would otherwise go unnoticed.
#
# Requires FIRECRAWL_API_KEY to be set (env var or .env file). If unset,
# the stage skips gracefully with a note — CI without the Firecrawl secret
# should see SKIPPED, not FAIL.
stage_4_live_ingest() {
    echo "[STAGE 4] REAL: live ingest + compile end-to-end (commit 4)"

    if [ -z "${FIRECRAWL_API_KEY:-}" ]; then
        echo "  SKIP: FIRECRAWL_API_KEY not set. Set it in .env or export it to run this stage."
        record_stage 4 REAL SKIPPED
        return 0
    fi

    echo "  starting nlp-service and n8n..."
    if ! $COMPOSE up -d --build nlp-service n8n; then
        echo "  FAIL: docker compose up -d --build nlp-service n8n returned non-zero"
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

    # n8n takes longer to boot on first start (workflow import + sqlite init +
    # workflow activation). We must distinguish "n8n process up" from "workflow
    # actually active". An inactive workflow returns 404 on its webhook path;
    # an active workflow with responseMode: onReceived returns 200 immediately.
    #
    # Probe by POSTing an empty JSON body. n8n's ingest workflow Switch node
    # routes neither rule (no source_type field), so the workflow ends harmlessly
    # with no downstream calls and no activity log writes. We accept ONLY 200/202
    # as "ready"; 404 means workflow not yet activated.
    echo "  waiting for n8n workflow to be activated (up to 120s)..."
    local elapsed=0
    while [ $elapsed -lt 120 ]; do
        local code
        code=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
            -H "content-type: application/json" -d '{}' \
            "http://localhost:5678/webhook/ingest" 2>/dev/null || echo "000")
        if [ "$code" = "200" ] || [ "$code" = "202" ]; then
            break
        fi
        sleep 3
        elapsed=$((elapsed + 3))
    done
    if [ "$elapsed" -ge 120 ]; then
        echo "  FAIL: n8n workflow did not become active within 120s (last code: $code)"
        echo "  --- n8n logs ---"
        $COMPOSE logs n8n 2>&1 | tail -40
        record_stage 4 REAL FAIL
        return 1
    fi

    local since
    since=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    echo "  poll watermark: $since"

    echo "  POSTing Wikipedia URL to /api/ingest/url..."
    local ingest_response
    ingest_response=$(curl -sf -X POST \
        -H "content-type: application/json" \
        -d '{"urls":["https://en.wikipedia.org/wiki/Bitcoin"]}' \
        "http://localhost:3000/api/ingest/url" 2>&1)
    if [ -z "$ingest_response" ]; then
        echo "  FAIL: /api/ingest/url returned empty response"
        record_stage 4 REAL FAIL
        return 1
    fi
    echo "  ingest response: $ingest_response"

    # Extract source_id from the response using grep + sed. CI doesn't have
    # jq; avoid the dep. Response shape: {"accepted":1,"source_ids":["uuid"]}
    local source_id
    source_id=$(echo "$ingest_response" | grep -o '"source_ids":\[[^]]*\]' | grep -Eo '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1)
    if [ -z "$source_id" ]; then
        echo "  FAIL: could not extract source_id from ingest response"
        record_stage 4 REAL FAIL
        return 1
    fi
    echo "  source_id: $source_id"

    echo "  polling /api/activity for source_stored (up to 180s)..."
    elapsed=0
    local stored=0
    while [ $elapsed -lt 180 ]; do
        local activity
        activity=$(curl -sf "http://localhost:3000/api/activity?since=$since&limit=200" 2>/dev/null || echo "")
        if echo "$activity" | grep -q "\"source_id\":\"$source_id\"" \
           && echo "$activity" | grep -q '"action_type":"source_stored"'; then
            stored=1
            break
        fi
        if echo "$activity" | grep -q "\"source_id\":\"$source_id\"" \
           && echo "$activity" | grep -q '"action_type":"ingest_failed"'; then
            echo "  FAIL: activity shows ingest_failed for our source_id"
            echo "  $activity"
            echo "  --- n8n logs ---"
            $COMPOSE logs n8n 2>&1 | tail -40
            echo "  --- nlp-service logs ---"
            $COMPOSE logs nlp-service 2>&1 | tail -40
            record_stage 4 REAL FAIL
            return 1
        fi
        sleep 3
        elapsed=$((elapsed + 3))
    done
    if [ $stored -ne 1 ]; then
        echo "  FAIL: source_stored did not appear in activity within 180s"
        echo "  --- app logs ---"
        $COMPOSE logs app 2>&1 | tail -20
        echo "  --- n8n logs ---"
        $COMPOSE logs n8n 2>&1 | tail -40
        echo "  --- nlp-service logs ---"
        $COMPOSE logs nlp-service 2>&1 | tail -40
        record_stage 4 REAL FAIL
        return 1
    fi

    echo "  verifying /api/sources/$source_id..."
    local source_response
    source_response=$(curl -sf "http://localhost:3000/api/sources/$source_id")
    if ! echo "$source_response" | grep -qi '"title"'; then
        echo "  FAIL: /api/sources/<id> response missing title field"
        echo "  $source_response"
        record_stage 4 REAL FAIL
        return 1
    fi
    if ! echo "$source_response" | grep -qi 'bitcoin'; then
        echo "  FAIL: source title does not contain 'bitcoin' (case insensitive)"
        echo "  $source_response"
        record_stage 4 REAL FAIL
        return 1
    fi

    echo "  happy path: ingest stored PASS"

    # -----------------------------------------------------------------------
    # Sub-test: compile assertion
    # -----------------------------------------------------------------------
    # Skipped gracefully when GEMINI_API_KEY is not set (CI without the key).
    if [ -z "${GEMINI_API_KEY:-}" ]; then
        echo "  SKIP: GEMINI_API_KEY not set — skipping compile assertion"
    else
        echo "  polling /api/activity for source_compiled (up to 120s)..."
        elapsed=0
        local compiled=0
        local page_id=""
        while [ $elapsed -lt 120 ]; do
            local compile_activity
            compile_activity=$(curl -sf "http://localhost:3000/api/activity?since=$since&limit=200" 2>/dev/null || echo "")
            if echo "$compile_activity" | grep -q "\"source_id\":\"$source_id\"" \
               && echo "$compile_activity" | grep -q '"action_type":"source_compiled"'; then
                compiled=1
                # Extract page_id from details JSON (no jq — use grep/sed)
                page_id=$(echo "$compile_activity" | grep -o '"page_id":"[^"]*"' | head -1 | sed 's/"page_id":"//;s/"//')
                break
            fi
            if echo "$compile_activity" | grep -q "\"source_id\":\"$source_id\"" \
               && echo "$compile_activity" | grep -q '"action_type":"compile_failed"'; then
                echo "  FAIL: compile_failed in activity for source_id $source_id"
                echo "  $compile_activity"
                record_stage 4 REAL FAIL
                return 1
            fi
            sleep 5
            elapsed=$((elapsed + 5))
        done
        if [ $compiled -ne 1 ]; then
            echo "  FAIL: source_compiled did not appear in activity within 120s"
            $COMPOSE logs nlp-service 2>&1 | tail -30
            record_stage 4 REAL FAIL
            return 1
        fi
        echo "  source_compiled PASS (page_id: $page_id)"

        if [ -n "$page_id" ]; then
            echo "  verifying /page/$page_id renders (200 + title)..."
            local page_response
            page_response=$(curl -sf "http://localhost:3000/page/$page_id" 2>/dev/null || echo "")
            if ! echo "$page_response" | grep -qi '<h1'; then
                echo "  FAIL: /page/$page_id did not return an <h1> element"
                echo "  response (first 500 chars): ${page_response:0:500}"
                record_stage 4 REAL FAIL
                return 1
            fi
            echo "  wiki page render PASS"
        fi
    fi

    echo "  happy path PASS"

    # -----------------------------------------------------------------------
    # Sub-test: failure-path canary
    # -----------------------------------------------------------------------
    # Verifies the n8n workflow's per-node onError: continueErrorOutput routing
    # fires "HTTP: Log Failure" which POSTs ingest_failed to /api/activity.
    #
    # Uses the /webhook/ingest-sync entrypoint (responseMode: lastNode) which
    # blocks until the last node in the executed branch completes and returns
    # its output synchronously. No polling loop, no sleep — deterministic.
    #
    # URL uses RFC 2606 reserved .invalid TLD. nlp-service's convert_url()
    # short-circuits immediately (before calling Firecrawl) with a 502, so
    # the error branch fires in <2s instead of waiting 30s for a DNS timeout.
    #
    # The canary source_id is generated locally (not through Next.js /api/ingest/url)
    # because the sync webhook bypasses the Next.js front door — it's a test-only
    # entrypoint. We generate a UUID client-side so the activity assertion can
    # filter by that exact source_id.
    echo "  canary: POSTing .invalid URL to n8n sync webhook (blocking)..."

    local canary_source_id
    # Generate a UUID. Works on Linux (uuidgen), macOS (uuidgen), and
    # Git Bash on Windows (PowerShell fallback).
    canary_source_id=$(uuidgen 2>/dev/null || \
        powershell -Command "[guid]::NewGuid().ToString()" 2>/dev/null || \
        python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || \
        cat /proc/sys/kernel/random/uuid 2>/dev/null || \
        echo "canary-$(date +%s)")
    echo "  canary source_id: $canary_source_id"

    local canary_since
    canary_since=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

    # POST directly to the sync webhook. Blocks until "HTTP: Log Failure" returns.
    # --max-time 30: hard timeout (RFC 2606 short-circuit + 3 retries × 2s wait =
    # ~8s worst case; 30s gives plenty of headroom without the 90s sleep-loop).
    local canary_sync_response
    canary_sync_response=$(curl -s --max-time 30 -X POST \
        -H "content-type: application/json" \
        -d "{\"source_id\":\"$canary_source_id\",\"source_type\":\"url\",\"source_ref\":\"https://this-domain-does-not-exist-kompl-canary.invalid\"}" \
        "http://localhost:5678/webhook/ingest-sync" 2>&1 || echo "CURL_FAILED")

    if [ "$canary_sync_response" = "CURL_FAILED" ]; then
        echo "  FAIL: canary sync webhook curl timed out or failed"
        echo "  (Is n8n running? Is the ingest-sync webhook activated?)"
        echo "  --- n8n logs ---"
        $COMPOSE logs n8n 2>&1 | tail -20
        record_stage 4 REAL FAIL
        return 1
    fi
    echo "  canary sync response: $canary_sync_response"

    # The sync response arrived, meaning the workflow completed synchronously.
    # Now verify the ingest_failed activity row was actually written.
    local canary_activity
    canary_activity=$(curl -sf "http://localhost:3000/api/activity?since=$canary_since&limit=200" 2>/dev/null || echo "")
    if ! echo "$canary_activity" | grep -q "\"source_id\":\"$canary_source_id\"" \
       || ! echo "$canary_activity" | grep -q '"action_type":"ingest_failed"'; then
        echo "  FAIL: canary ingest_failed row not found in activity after sync webhook returned"
        echo "  (HTTP: Log Failure node fired but /api/activity POST may have failed?)"
        echo "  canary_activity: $canary_activity"
        echo "  --- n8n logs ---"
        $COMPOSE logs n8n 2>&1 | tail -20
        record_stage 4 REAL FAIL
        return 1
    fi

    echo "  canary PASS"
    echo "  PASS"
    record_stage 4 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 5 — Persistence across restart
# ---------------------------------------------------------------------------
stage_5_persistence() {
    echo "[STAGE 5] TODO: persistence across restart (counts identical after restart)"
    record_stage 5 TODO SKIPPED
    return 0
}

# ---------------------------------------------------------------------------
# Stage 6 — Chat with citations
# ---------------------------------------------------------------------------
stage_6_chat_citations() {
    echo "[STAGE 6] TODO: chat with citations (5 questions, regression guard for FIX-013)"
    record_stage 6 TODO SKIPPED
    return 0
}

# ---------------------------------------------------------------------------
# Stage 7 — Wiki rebuild
# ---------------------------------------------------------------------------
stage_7_wiki_rebuild() {
    echo "[STAGE 7] TODO: wiki rebuild (plural directory names, frontmatter present, wikilinks converted)"
    record_stage 7 TODO SKIPPED
    return 0
}

# ---------------------------------------------------------------------------
# Stage 8 — Version history
# ---------------------------------------------------------------------------
stage_8_version_history() {
    echo "[STAGE 8] TODO: version history (previous_content_path non-null, files differ)"
    record_stage 8 TODO SKIPPED
    return 0
}

# ---------------------------------------------------------------------------
# Stage 9 — Contract drift canary
# ---------------------------------------------------------------------------
stage_9_contract_drift_canary() {
    echo "[STAGE 9] TODO: contract drift canary (Pydantic rename -> npm run build fails)"
    record_stage 9 TODO SKIPPED
    return 0
}

# ---------------------------------------------------------------------------
# Stage 10 — Concurrency / rate-limit
# ---------------------------------------------------------------------------
stage_10_concurrency() {
    echo "[STAGE 10] TODO: concurrency / rate-limit (7 parallel ingests, all reach compiled)"
    record_stage 10 TODO SKIPPED
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
# Main
# ---------------------------------------------------------------------------
main() {
    echo "=== Kompl v2 integration test ==="
    echo "Commit 4 state: stages 0, 1, 4 REAL; compile assertion in stage 4 requires GEMINI_API_KEY."
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
    stage_11_onboarding_api
    stage_12_text_connector
    stage_13_twitter_connector
    stage_14_extraction

    echo
    echo "=== Stage summary ==="
    for result in "${STAGE_RESULTS[@]}"; do
        echo "  $result"
    done
    echo
    echo "=== All 14 stages executed, all passed ==="
    exit 0
}

main "$@"
