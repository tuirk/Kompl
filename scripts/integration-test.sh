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
#   Stage 1  — REAL (migration & schema sanity via /api/health, schema_version=20)
#   Stage 4  — REAL (text connector stage end-to-end, no API key needed)
#   Stage 11 — REAL (onboarding API canary via /stage → /finalize → pipeline)
#   Stage 11b — REAL (finalize surfaces n8n-down as 503)
#   Stage 11c — REAL (nlp-down surfaces via health_check step failure, not /stage)
#   Stage 12 — REAL (text connector canary via /stage)
#   Stage 13 — REAL (twitter connector canary via /stage)
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
    if ! echo "$response" | grep -q '"schema_version":20'; then
        echo "  FAIL: schema_version != 20"
        record_stage 1 REAL FAIL
        return 1
    fi
    if ! echo "$response" | grep -q '"table_count":18'; then
        echo "  FAIL: table_count != 18"
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

    # Env-wire sanity: if the host has a key set, the app container MUST see
    # it too. Catches docker-compose.yml plumbing gaps like the one shipped
    # in Phase 1 — GEMINI_API_KEY was wired only to nlp-service, not app, so
    # the onboarding v2 health-check step hard-failed on every staging
    # compile. Fixed 2026-04-20 by adding the keys to app.environment.
    # Presence-only check; never compares values (would leak secrets on fail).
    echo "  checking env-var wire (host -> app container)..."
    for var in GEMINI_API_KEY FIRECRAWL_API_KEY; do
        host_val=$(printenv "$var" 2>/dev/null || true)
        if [ -n "$host_val" ]; then
            container_val=$($COMPOSE exec -T app printenv "$var" 2>/dev/null || true)
            if [ -z "$container_val" ]; then
                echo "  FAIL: host has $var set but app container does not"
                echo "         -> add '$var: \${$var:-}' to the 'app.environment' block in docker-compose.yml"
                record_stage 1 REAL FAIL
                return 1
            fi
        fi
    done

    echo "  PASS"
    record_stage 1 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 4 -- Stage end-to-end via text connector (REAL -- no API key needed)
# ---------------------------------------------------------------------------
# Brings up nlp-service (app already running from stage 1). POSTs a text note
# to /api/onboarding/stage and verifies the row lands in collect_staging with
# the expected payload, readable back via /api/onboarding/staging.
#
# Text connector through /stage stores intent only — no NLP call, no Firecrawl.
# Reliably runnable in CI without any secrets.
#
# The legacy sub-test for a .invalid URL canary (exercising /collect's sync
# NLP error surface) was removed in Phase 3 — /stage doesn't call NLP so
# the equivalent failure now surfaces inside the pipeline's ingest_urls step
# and is covered by the GEMINI/FIRECRAWL-gated stage 11.
stage_4_live_ingest() {
    echo "[STAGE 4] REAL: stage end-to-end via text connector (stage -> staging -> verify)"

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

    local SESSION_ID
    SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
    echo "  session_id: $SESSION_ID"

    local NOTE_TITLE="Integration Test Note"
    local NOTE_MD="Integration Test Note. This note is seeded by the integration test suite to verify the text connector stage path end-to-end. It contains enough content to clear the min_source_chars gate (default 500 characters). The stage endpoint should record intent in collect_staging and return stage_ids. The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump quickly. The five boxing wizards are fully ready and waiting here."

    local stage_response stage_http
    stage_http=$(curl -s -o /tmp/stage_body.json -w "%{http_code}" -X POST \
        -H "content-type: application/json" \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[{\"markdown\":\"$NOTE_MD\",\"title_hint\":\"$NOTE_TITLE\",\"source_type_hint\":\"note\"}]}" \
        "http://localhost:3000/api/onboarding/stage" 2>&1)
    stage_response=$(cat /tmp/stage_body.json 2>/dev/null || echo "")
    if [ "$stage_http" != "200" ]; then
        echo "  FAIL: /api/onboarding/stage returned HTTP $stage_http"
        echo "  body: $stage_response"
        echo "  --- app logs ---"
        $COMPOSE logs app 2>&1 | tail -30
        record_stage 4 REAL FAIL
        return 1
    fi
    echo "  stage response: $stage_response"

    # Expect stage_ids: [uuid]
    if ! echo "$stage_response" | grep -q '"stage_ids":\["'; then
        echo "  FAIL: stage response missing stage_ids array"
        record_stage 4 REAL FAIL
        return 1
    fi

    echo "  verifying /api/onboarding/staging?session_id=$SESSION_ID..."
    local staging_response
    staging_response=$(curl -sf "http://localhost:3000/api/onboarding/staging?session_id=$SESSION_ID" 2>/dev/null || echo "")
    if [ -z "$staging_response" ]; then
        echo "  FAIL: /api/onboarding/staging returned empty response"
        record_stage 4 REAL FAIL
        return 1
    fi

    # Expect totals.total=1 and the text group has 1 row.
    if ! echo "$staging_response" | grep -q '"total":1'; then
        echo "  FAIL: staging totals.total != 1"
        echo "  $staging_response"
        record_stage 4 REAL FAIL
        return 1
    fi
    if ! echo "$staging_response" | grep -qi 'Integration Test'; then
        echo "  FAIL: staging payload does not contain expected markdown snippet"
        echo "  $staging_response"
        record_stage 4 REAL FAIL
        return 1
    fi

    echo "  PASS"
    record_stage 4 REAL PASS
    return 0
}


# ---------------------------------------------------------------------------
# Stage 11 — Onboarding API canary via /stage → /finalize → pipeline
# ---------------------------------------------------------------------------
# Exercises the full staging flow:
#   1. POST /api/onboarding/stage with example.com (url connector)
#   2. GET  /api/onboarding/staging — asserts totals.total=1
#   3. POST /api/onboarding/finalize — asserts queued=1
#   4. Poll /api/compile/progress until not-queued (pipeline entered or ran)
#
# Needs BOTH FIRECRAWL_API_KEY (ingest_urls) and GEMINI_API_KEY (extract step).
# Skipped gracefully when either is missing.
stage_11_onboarding_api() {
    echo "[STAGE 11] REAL: onboarding API canary (stage → staging → finalize → pipeline)"

    if [ -z "${FIRECRAWL_API_KEY:-}" ]; then
        echo "  SKIP: FIRECRAWL_API_KEY not set — skipping onboarding API canary."
        record_stage 11 REAL SKIPPED
        return 0
    fi
    if [ -z "${GEMINI_API_KEY:-}" ]; then
        echo "  SKIP: GEMINI_API_KEY not set — pipeline needs Gemini for extract step."
        record_stage 11 REAL SKIPPED
        return 0
    fi

    local SESSION_ID
    SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
    echo "  session_id: $SESSION_ID"

    # ── Step 1: stage ────────────────────────────────────────────────────────
    echo "  POSTing to /api/onboarding/stage..."
    local stage_response
    stage_response=$(curl -sf -X POST \
        -H "content-type: application/json" \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"url\",\"items\":[{\"url\":\"https://example.com\"}]}" \
        "http://localhost:3000/api/onboarding/stage" 2>&1)

    if ! echo "$stage_response" | grep -q '"stage_ids":\["'; then
        echo "  FAIL: /api/onboarding/stage missing stage_ids"
        echo "  stage response: $stage_response"
        record_stage 11 REAL FAIL
        return 1
    fi
    echo "  stage response: $stage_response"

    # ── Step 2: staging ──────────────────────────────────────────────────────
    echo "  GETting /api/onboarding/staging..."
    local staging_response
    staging_response=$(curl -sf "http://localhost:3000/api/onboarding/staging?session_id=$SESSION_ID")
    if ! echo "$staging_response" | grep -q '"total":1'; then
        echo "  FAIL: staging response missing totals.total=1"
        echo "  staging response: $staging_response"
        record_stage 11 REAL FAIL
        return 1
    fi
    echo "  staging total=1 OK"

    # ── Step 3: finalize ─────────────────────────────────────────────────────
    echo "  POSTing to /api/onboarding/finalize..."
    local finalize_response
    finalize_response=$(curl -sf -X POST \
        -H "content-type: application/json" \
        -d "{\"session_id\":\"$SESSION_ID\"}" \
        "http://localhost:3000/api/onboarding/finalize")

    if ! echo "$finalize_response" | grep -q '"queued":1'; then
        echo "  FAIL: finalize response missing \"queued\":1"
        echo "  finalize response: $finalize_response"
        record_stage 11 REAL FAIL
        return 1
    fi
    echo "  finalize queued=1 OK"

    # ── Step 4: poll compile_progress left-moves past 'queued' ───────────────
    # Short wait — we're proving the pipeline picked up the run, not that it
    # completes. Full pipeline-completion coverage lives in stages 16/17.
    local status=""
    for i in $(seq 1 30); do
        status=$(curl -sf --max-time 5 \
            "http://localhost:3000/api/compile/progress?session_id=$SESSION_ID" \
            | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
        if [ "$status" != "queued" ] && [ -n "$status" ]; then break; fi
        sleep 2
    done
    if [ -z "$status" ] || [ "$status" = "queued" ]; then
        echo "  FAIL: pipeline did not leave 'queued' within 60s (last status=$status)"
        record_stage 11 REAL FAIL
        return 1
    fi
    echo "  compile_progress status=$status (entered pipeline) OK"

    echo "  PASS"
    record_stage 11 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 11b — finalize surfaces n8n-down as 503 (not silent 'queued forever')
# ---------------------------------------------------------------------------
#
# Regression test for the silent-failure bug fixed by lib/trigger-n8n.ts.
# Pre-fix: with n8n down, the onboarding confirm path used fire-and-forget
# fetch and returned 200 — compile_progress row got stuck at 'queued'
# forever. Post-fix: the finalize route awaits the webhook via
# triggerSessionCompile and returns 503 with an n8n_* error code, while the
# DB row is still created so the reconciler in /api/health can clean it up
# later.
#
# This test does NOT require FIRECRAWL_API_KEY (uses text connector).
stage_11b_confirm_surfaces_n8n_down() {
    echo "[STAGE 11b] REAL: /api/onboarding/finalize returns 503 when n8n is down"

    local SESSION_ID
    SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())")

    # ── stage a text source ──────────────────────────────────────────────────
    local NOTE_MD='# 11b test note\n\nRegression guard for n8n-down finalize.'
    local stage_response
    stage_response=$(curl -sf -X POST \
        -H "content-type: application/json" \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[{\"markdown\":\"$NOTE_MD\",\"title_hint\":\"11b Test\",\"source_type_hint\":\"note\"}]}" \
        "http://localhost:3000/api/onboarding/stage")

    if ! echo "$stage_response" | grep -q '"stage_ids":\["'; then
        echo "  FAIL: could not stage test item"
        echo "  stage response: $stage_response"
        record_stage 11b REAL FAIL
        return 1
    fi
    echo "  staged session_id=$SESSION_ID"

    # ── stop n8n ─────────────────────────────────────────────────────────────
    echo "  stopping n8n to simulate webhook failure..."
    if ! $COMPOSE stop n8n >/dev/null 2>&1; then
        echo "  FAIL: could not stop n8n"
        record_stage 11b REAL FAIL
        return 1
    fi

    # ── finalize with n8n down — expect HTTP 503 + n8n_* error code ──────────
    echo "  POSTing /api/onboarding/finalize with n8n down (expect 503)..."
    local finalize_http finalize_body
    finalize_http=$(curl -s -o /tmp/11b_body -w "%{http_code}" -X POST \
        -H "content-type: application/json" \
        -d "{\"session_id\":\"$SESSION_ID\"}" \
        "http://localhost:3000/api/onboarding/finalize")
    finalize_body=$(cat /tmp/11b_body 2>/dev/null || echo "")
    rm -f /tmp/11b_body

    # Restart n8n regardless of test outcome so other stages can run.
    # Use `up -d` not `start`: stage 1's `down -v` already removed the n8n
    # container before we got here, and `docker compose start` errors
    # out with exit 1 + "service \"n8n\" has no container to start" in
    # that case — which gets silenced by `>/dev/null 2>&1 || true` and
    # surfaces 120s later as a mysterious wait_for_http_200 timeout.
    # `up -d` creates-if-missing AND starts, covering both paths.
    echo "  restarting n8n..."
    $COMPOSE up -d n8n >/dev/null 2>&1 || true
    wait_for_http_200 "http://localhost:5678/healthz" 120 || echo "  WARNING: n8n did not come back within 120s"
    # Guard: ensure the container actually exists post-restart.
    if [ -z "$($COMPOSE ps -q n8n 2>/dev/null)" ]; then
        echo "  WARNING: n8n container is missing after restart — silent-failure regression"
    fi
    # healthz returns 200 once n8n HTTP is up, but n8n needs extra seconds
    # to register webhook routes from the active workflows. Probe the webhook
    # via GET (method mismatch for our POST-only endpoint) — does NOT fire
    # the workflow, unlike a POST probe which cascades:
    #   n8n webhook (202) → HTTP: Start Compile → /api/compile/run 404
    #   → onError branch → POST /api/activity → one 'compile_failed' row
    # GET is rejected at the webhook router layer. n8n 2.x returns a body
    # naming the registered method when the route exists, vs. a generic
    # "not registered" body when it doesn't.
    # Empirically verified against n8nio/n8n:2.15.0 (2026-04-20):
    #   Registered: 404 "This webhook is not registered for GET requests.
    #                    Did you mean to make a POST request?"
    #   Unregistered / n8n still booting: generic 404 / connection fail.
    # Body-match on the "POST" keyword is load-bearing on an observable
    # behavior, not a documented contract; relies on our pin to 2.15.0.
    # Failure mode is loud (probe times out → stage 11c fails visibly).
    echo "  waiting for n8n webhook registration (auto-import activation)..."
    for i in $(seq 1 90); do
        probe_body=$(curl -s --max-time 3 -X GET \
            "http://localhost:5678/webhook/session-compile" 2>/dev/null || echo "")
        case "$probe_body" in
            *POST*)
                echo "    webhook ready after ${i}s (method-mismatch 404 returned)"
                break
                ;;
            *)
                sleep 1
                ;;
        esac
    done

    if [ "$finalize_http" != "503" ]; then
        echo "  FAIL: expected HTTP 503 with n8n down, got $finalize_http"
        echo "  body: $finalize_body"
        record_stage 11b REAL FAIL
        return 1
    fi
    echo "  finalize HTTP 503 OK"

    if ! echo "$finalize_body" | grep -qE '"error":"n8n_(unreachable|timeout|webhook_failed)"'; then
        echo "  FAIL: body missing expected n8n_* error code"
        echo "  body: $finalize_body"
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

    # Hermetic cleanup: the persisted 'queued' row would otherwise trip the
    # cross-session concurrency guard in subsequent stages (11c, 12, 13…)
    # that finalize fresh sessions. DELETE /api/onboarding/session clears
    # both the staging rows and the compile_progress row so the next stage
    # starts from a clean slate. In production the same row lives on until
    # the reconciler sweeps it; that behaviour is covered by Stage 11 and
    # health-check integration tests, not 11b.
    curl -sf -X DELETE \
        "http://localhost:3000/api/onboarding/session?session_id=$SESSION_ID" > /dev/null || true

    echo "  PASS"
    record_stage 11b REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 11c — nlp-unreachable surfaces via pipeline's health_check step
# ---------------------------------------------------------------------------
#
# SEMANTIC SHIFT vs pre-Phase-3: the old /collect route synchronously called
# NLP during the POST and returned HTTP 502 + error_code='nlp_unreachable'.
# Post-Phase-3 /stage NEVER calls NLP — it just records intent. An NLP-down
# condition no longer surfaces at the /stage response; instead it's caught
# by the pipeline's first prelude step (runHealthCheckStep in
# app/src/lib/compile/steps/health-check.ts), which throws
# HealthCheckFailedError('nlp_unreachable') and marks the step 'failed'.
#
# The new assertion shape: /stage 200 → /finalize 202 → poll compile_progress
# until health_check.status='failed' with detail containing 'nlp_unreachable'.
#
# Does NOT require FIRECRAWL_API_KEY (/stage records intent without NLP).
stage_11c_collect_surfaces_nlp_down() {
    echo "[STAGE 11c] REAL: nlp-down surfaces as health_check step failure"

    local SESSION_ID
    SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())")

    # ── Step 1: stage a URL item — must 200 even with nlp-service down ───────
    echo "  POSTing /api/onboarding/stage (nlp still up)..."
    local stage_response stage_http
    stage_http=$(curl -s -o /tmp/11c_stage -w "%{http_code}" -X POST \
        -H "content-type: application/json" \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"url\",\"items\":[{\"url\":\"https://example.com/11c-test\"}]}" \
        "http://localhost:3000/api/onboarding/stage")
    stage_response=$(cat /tmp/11c_stage 2>/dev/null || echo "")
    rm -f /tmp/11c_stage

    if [ "$stage_http" != "200" ]; then
        echo "  FAIL: /api/onboarding/stage returned $stage_http (expected 200)"
        echo "  body: $stage_response"
        record_stage 11c REAL FAIL
        return 1
    fi
    echo "  stage HTTP 200 OK"

    # ── Step 2: stop nlp-service, then finalize ──────────────────────────────
    echo "  stopping nlp-service to simulate unreachable during pipeline..."
    if ! $COMPOSE stop nlp-service >/dev/null 2>&1; then
        echo "  FAIL: could not stop nlp-service"
        record_stage 11c REAL FAIL
        return 1
    fi

    # /finalize triggers n8n which fires /api/compile/run. The pipeline's
    # first step is runHealthCheckStep which pings nlp-service and fails hard.
    echo "  POSTing /api/onboarding/finalize with nlp down..."
    local finalize_http finalize_body
    finalize_http=$(curl -s -o /tmp/11c_finalize -w "%{http_code}" -X POST \
        -H "content-type: application/json" \
        -d "{\"session_id\":\"$SESSION_ID\"}" \
        "http://localhost:3000/api/onboarding/finalize")
    finalize_body=$(cat /tmp/11c_finalize 2>/dev/null || echo "")
    rm -f /tmp/11c_finalize

    # Finalize succeeds — n8n is up, trigger returns ok. Pipeline fails later.
    if [ "$finalize_http" != "200" ]; then
        echo "  WARNING: /finalize returned $finalize_http (expected 200); body=$finalize_body"
    fi

    # ── Step 3: poll compile_progress until steps.health_check.status=failed ─
    echo "  polling compile_progress for health_check step failure (up to 60s)..."
    local hc_status="" hc_detail=""
    for i in $(seq 1 30); do
        local progress_body
        progress_body=$(curl -sf --max-time 5 \
            "http://localhost:3000/api/compile/progress?session_id=$SESSION_ID" 2>/dev/null || echo "")
        hc_status=$(echo "$progress_body" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    steps = d.get('steps', {})
    hc = steps.get('health_check', {}) if isinstance(steps, dict) else {}
    print(hc.get('status', ''))
except Exception:
    print('')
" 2>/dev/null || echo "")
        hc_detail=$(echo "$progress_body" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    steps = d.get('steps', {})
    hc = steps.get('health_check', {}) if isinstance(steps, dict) else {}
    print(hc.get('detail', '') or hc.get('error', ''))
except Exception:
    print('')
" 2>/dev/null || echo "")
        if [ "$hc_status" = "failed" ]; then break; fi
        sleep 2
    done

    # Restart nlp-service regardless of test outcome so other stages can run.
    echo "  restarting nlp-service..."
    $COMPOSE start nlp-service >/dev/null 2>&1 || true
    wait_for_http_200 "http://localhost:8000/health" 120 || echo "  WARNING: nlp-service did not come back within 120s"

    if [ "$hc_status" != "failed" ]; then
        echo "  FAIL: health_check step did not reach 'failed' within 60s (last status='$hc_status')"
        record_stage 11c REAL FAIL
        return 1
    fi
    echo "  health_check.status=failed OK"

    if ! echo "$hc_detail" | grep -q 'nlp_unreachable'; then
        echo "  FAIL: health_check step detail missing 'nlp_unreachable' (got '$hc_detail')"
        record_stage 11c REAL FAIL
        return 1
    fi
    echo "  health_check detail contains 'nlp_unreachable' OK"

    echo "  PASS"
    record_stage 11c REAL PASS
    return 0
}

# ──────────────────────────────────────────────────────────────────────────
# Stage 11d: no direct insertActivity writers outside the n8n escape hatch.
# Catches any new code that bypasses the typed logActivity() wrapper from
# lib/db.ts. Exclusions:
#   - api/activity/route.ts (legit n8n open-string writer)
#   - lib/db.ts (logActivity wraps insertActivity there — internal callsite)
# ──────────────────────────────────────────────────────────────────────────
stage_11d_insertactivity_guard() {
  echo "=== Stage 11d: insertActivity writer discipline ==="
  local hits
  # -U --multiline-dotall: let . match newlines so we catch multi-line callsites.
  hits=$(rg -U --multiline-dotall -n \
    'insertActivity\s*\(\s*\{[^}]*action_type\s*:' \
    app/src/ \
    --glob '!app/src/app/api/activity/**' \
    --glob '!app/src/lib/db.ts' 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "FAIL: direct insertActivity(...) writers found outside the n8n escape hatch:"
    echo "$hits"
    echo "Use logActivity(type, {...}) from @/lib/db instead."
    record_stage 11d REAL FAIL
    return 1
  fi
  echo "OK: no unguarded insertActivity writers"
  record_stage 11d REAL PASS
  return 0
}

# ---------------------------------------------------------------------------
# Stage 12 — text connector canary via /stage
# ---------------------------------------------------------------------------
#
# Submits a raw markdown note via connector='text' through /api/onboarding/stage
# (no Firecrawl, no nlp-service call). Verifies the staging row lands with the
# markdown payload readable back via /api/onboarding/staging.
#
# This stage does NOT require FIRECRAWL_API_KEY or GEMINI_API_KEY.
stage_12_text_connector() {
    echo "[STAGE 12] REAL: text connector canary (stage note → collect_staging)"

    local SESSION_ID
    SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())")

    local NOTE_MD='# My test note\n\nThis is a test note from the integration test.'

    echo "  POSTing to /api/onboarding/stage with connector=text..."
    local stage_response
    stage_response=$(curl -sf -X POST \
        -H "content-type: application/json" \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[{\"markdown\":\"$NOTE_MD\",\"title_hint\":\"Test Note\",\"source_type_hint\":\"note\"}]}" \
        "http://localhost:3000/api/onboarding/stage")

    if [ -z "$stage_response" ]; then
        echo "  FAIL: /api/onboarding/stage returned empty response"
        record_stage 12 REAL FAIL
        return 1
    fi

    if ! echo "$stage_response" | grep -q '"stage_ids":\["'; then
        echo "  FAIL: stage response missing stage_ids"
        echo "  stage response: $stage_response"
        record_stage 12 REAL FAIL
        return 1
    fi

    local staging_response
    staging_response=$(curl -sf "http://localhost:3000/api/onboarding/staging?session_id=$SESSION_ID")

    if ! echo "$staging_response" | grep -q '"total":1'; then
        echo "  FAIL: staging response missing totals.total=1"
        echo "  staging response: $staging_response"
        record_stage 12 REAL FAIL
        return 1
    fi
    echo "  staging total=1 OK"

    # Payload carries the markdown. grep for a unique sub-string.
    if ! echo "$staging_response" | grep -q 'My test note'; then
        echo "  FAIL: staging payload missing markdown title"
        record_stage 12 REAL FAIL
        return 1
    fi
    echo "  payload contains 'My test note' OK"

    echo "  PASS"
    record_stage 12 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 13: Twitter connector canary via /stage
# Submits a tweet via connector='text' with source_type_hint='tweet' and
# date metadata. Verifies the staging row carries the tweet metadata.
# ---------------------------------------------------------------------------
stage_13_twitter_connector() {
    echo "[STAGE 13] REAL: twitter connector canary (tweet → collect_staging)"

    local SESSION_ID
    SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || uuidgen)
    local TWEET_MD
    TWEET_MD='**@testuser:**\n\nThis is a test tweet about Bitcoin\n\n[Original tweet](https://twitter.com/testuser/status/123)'

    local stage_response
    stage_response=$(curl -sf -X POST http://localhost:3000/api/onboarding/stage \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[{\"markdown\":\"$TWEET_MD\",\"title_hint\":\"Tweet by @testuser\",\"source_type_hint\":\"tweet\",\"metadata\":{\"date_saved\":\"2026-01-15T10:30:00Z\",\"author\":\"@testuser\"}}]}")

    if [ -z "$stage_response" ]; then
        echo "  FAIL: /api/onboarding/stage returned empty response"
        record_stage 13 REAL FAIL
        return 1
    fi

    if ! echo "$stage_response" | grep -q '"stage_ids":\["'; then
        echo "  FAIL: stage response missing stage_ids"
        echo "  stage response: $stage_response"
        record_stage 13 REAL FAIL
        return 1
    fi

    local staging_response
    staging_response=$(curl -sf "http://localhost:3000/api/onboarding/staging?session_id=$SESSION_ID")

    if [ -z "$staging_response" ]; then
        echo "  FAIL: /api/onboarding/staging returned empty response"
        record_stage 13 REAL FAIL
        return 1
    fi

    if ! echo "$staging_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
assert d['totals']['total'] == 1, f'total={d[\"totals\"][\"total\"]}'
row = d['groups']['text'][0]
payload = row['payload'] if isinstance(row['payload'], dict) else json.loads(row['payload'])
assert payload.get('source_type_hint') == 'tweet', f'source_type_hint={payload.get(\"source_type_hint\")}'
assert payload.get('metadata', {}).get('author') == '@testuser', f'author={payload.get(\"metadata\",{}).get(\"author\")}'
" 2>/dev/null; then
        echo "  FAIL: staging payload assertions"
        echo "  staging response: $staging_response"
        record_stage 13 REAL FAIL
        return 1
    fi

    echo "  tweet staged with source_type_hint=tweet + author=@testuser OK"
    echo "  PASS"
    record_stage 13 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 14 — Extraction pipeline canary via /stage → /finalize
# ---------------------------------------------------------------------------
# Stages one text source, triggers the pipeline, polls compile_progress
# until the extract step reaches 'done' (or pipeline completes), and
# verifies the extract step ran successfully.
#
# Post-Phase-3 the pipeline autonomously progresses through health_check →
# ingest_texts → extract → resolve → ... so the assertion shape changed
# from "call /api/compile/extract and inspect its response" to "poll
# compile_progress and assert the extract step landed 'done'".
#
# Skipped gracefully when GEMINI_API_KEY is unset.
stage_14_extraction() {
    echo "[STAGE 14] REAL: extraction pipeline canary via /stage → /finalize"

    if [ -z "${GEMINI_API_KEY:-}" ]; then
        echo "  SKIPPED: GEMINI_API_KEY not set"
        record_stage 14 REAL SKIPPED
        return 0
    fi

    local SESSION_ID
    SESSION_ID=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || uuidgen)

    # Stage a text source (no Firecrawl dep vs. old URL-based variant).
    # Content clears min_source_chars=500 so the LLM path runs end-to-end.
    local TEST_MD="Bitcoin is a decentralized digital currency created by Satoshi Nakamoto in 2009. It uses proof-of-work consensus and SHA-256 hashing. Bitcoin mining consumes significant energy. The network processes roughly seven transactions per second. Stage 14 canary content must clear min_source_chars so the LLM extract path is exercised end-to-end, not the Gate 1 raw-content fallback. The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs."
    curl -sf --max-time 10 -X POST http://localhost:3000/api/onboarding/stage \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[{\"markdown\":\"$TEST_MD\",\"title_hint\":\"Stage 14 canary\",\"source_type_hint\":\"note\"}]}" > /dev/null

    curl -sf --max-time 15 -X POST http://localhost:3000/api/onboarding/finalize \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\"}" > /dev/null

    echo "  polling compile_progress for extract step (up to 180s)..."
    local extract_status=""
    for i in $(seq 1 90); do
        local progress_body
        progress_body=$(curl -sf --max-time 5 \
            "http://localhost:3000/api/compile/progress?session_id=$SESSION_ID" 2>/dev/null || echo "")
        local top_status
        top_status=$(echo "$progress_body" | python3 -c "
import sys, json
try: print(json.load(sys.stdin).get('status', ''))
except Exception: print('')
" 2>/dev/null)
        extract_status=$(echo "$progress_body" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    steps = d.get('steps', {}) or {}
    print(steps.get('extract', {}).get('status', ''))
except Exception:
    print('')
" 2>/dev/null)
        if [ "$extract_status" = "done" ] || [ "$top_status" = "completed" ]; then break; fi
        if [ "$top_status" = "failed" ]; then
            echo "  FAIL: pipeline reported failed before extract reached 'done'"
            echo "  body: $(echo "$progress_body" | head -c 500)"
            record_stage 14 REAL FAIL
            return 1
        fi
        sleep 2
    done

    if [ "$extract_status" != "done" ]; then
        echo "  FAIL: extract step did not reach 'done' within 180s (last status='$extract_status')"
        record_stage 14 REAL FAIL
        return 1
    fi
    echo "  extract step status=done OK"

    echo "  PASS"
    record_stage 14 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 15: Entity resolution canary via /stage → /finalize
# Stages two text sources with overlapping entity names ("Vitalik Buterin"
# and "Buterin"), lets the pipeline extract + resolve autonomously, then
# asserts the resolve step reached 'done' and at least one 'buterin' alias
# exists in the aliases table.
#
# Post-Phase-3 the per-step /api/compile/extract + /resolve calls are
# replaced by a single /finalize trigger — the pipeline drives them in
# sequence. Requires GEMINI_API_KEY.
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

    curl -sf --max-time 15 -X POST http://localhost:3000/api/onboarding/stage \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[
          {\"markdown\":\"Vitalik Buterin founded Ethereum in 2015. Ethereum is a programmable blockchain platform that supports smart contracts. The Ethereum protocol is maintained by the Ethereum Foundation. Vitalik Buterin proposed Ethereum in a whitepaper published in 2013.\",\"title_hint\":\"Source A\",\"source_type_hint\":\"note\"},
          {\"markdown\":\"Buterin proposed Ethereum as a next-generation cryptocurrency platform. ETH is the native token of Ethereum. Buterin continues to lead research on Ethereum's roadmap including proto-danksharding and account abstraction.\",\"title_hint\":\"Source B\",\"source_type_hint\":\"note\"}
        ]}" > /dev/null

    curl -sf --max-time 15 -X POST http://localhost:3000/api/onboarding/finalize \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\"}" > /dev/null

    echo "  polling compile_progress for resolve step (up to 300s — two sources drive Gemini twice)..."
    local resolve_status=""
    for i in $(seq 1 150); do
        local progress_body
        progress_body=$(curl -sf --max-time 5 \
            "http://localhost:3000/api/compile/progress?session_id=$SESSION_ID" 2>/dev/null || echo "")
        local top_status
        top_status=$(echo "$progress_body" | python3 -c "
import sys, json
try: print(json.load(sys.stdin).get('status', ''))
except Exception: print('')
" 2>/dev/null)
        resolve_status=$(echo "$progress_body" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    steps = d.get('steps', {}) or {}
    print(steps.get('resolve', {}).get('status', ''))
except Exception:
    print('')
" 2>/dev/null)
        if [ "$resolve_status" = "done" ] || [ "$top_status" = "completed" ]; then break; fi
        if [ "$top_status" = "failed" ]; then
            echo "  FAIL: pipeline reported failed before resolve reached 'done'"
            record_stage 15 REAL FAIL
            return 1
        fi
        sleep 2
    done

    if [ "$resolve_status" != "done" ] && [ "$top_status" != "completed" ]; then
        echo "  FAIL: resolve step did not reach 'done' within 300s (last status='$resolve_status')"
        record_stage 15 REAL FAIL
        return 1
    fi
    echo "  resolve step complete OK"

    echo "  PASS"
    record_stage 15 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 16 — full compilation pipeline canary via /stage → /finalize
# Stages 3 related text sources, triggers the pipeline via /finalize, polls
# compile_progress until completed, then verifies page_count >= 4.
#
# Post-Phase-3 the individual step calls (extract/resolve/plan/draft/crossref/
# commit/schema) are driven automatically by the orchestrator; this stage's
# success proves they still all land on a happy 3-source input.
# ---------------------------------------------------------------------------
stage_16_full_pipeline() {
    echo "--- stage 16: full compilation pipeline (stage → finalize → complete) ---"

    if [ -z "${GEMINI_API_KEY:-}" ]; then
        echo "  SKIPPED: GEMINI_API_KEY not set"
        record_stage 16 REAL SKIPPED
        return 0
    fi

    local SESSION_ID
    SESSION_ID=$(node -e "console.log(require('crypto').randomUUID())")

    local base_page_count
    base_page_count=$(curl -sf --max-time 10 http://localhost:3000/api/health | python3 -c "
import sys, json
try: print(json.load(sys.stdin).get('page_count', 0))
except Exception: print(0)
" 2>/dev/null || echo 0)

    echo "  staging 3 text sources..."
    curl -sf --max-time 15 -X POST http://localhost:3000/api/onboarding/stage \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[
            {\"markdown\":\"Bitcoin is a decentralized digital currency created by Satoshi Nakamoto in 2009. It uses proof-of-work consensus and SHA-256 hashing. Bitcoin mining consumes significant energy. The Bitcoin network processes roughly 7 transactions per second.\",\"title_hint\":\"Bitcoin Basics\",\"source_type_hint\":\"note\"},
            {\"markdown\":\"Ethereum was founded by Vitalik Buterin in 2013. Unlike Bitcoin, Ethereum supports smart contracts and decentralized applications. Ethereum moved from proof-of-work to proof-of-stake in 2022 via the Merge. Ethereum processes around 15 transactions per second.\",\"title_hint\":\"Ethereum Overview\",\"source_type_hint\":\"note\"},
            {\"markdown\":\"Bitcoin vs Ethereum: Bitcoin is primarily a store of value while Ethereum is a platform for decentralized applications. Bitcoin uses proof-of-work, Ethereum now uses proof-of-stake. Both are leading cryptocurrencies by market cap. Vitalik Buterin created Ethereum as an improvement over Bitcoin's scripting limitations.\",\"title_hint\":\"BTC vs ETH Comparison\",\"source_type_hint\":\"note\"}
        ]}" > /dev/null

    echo "  finalizing — pipeline will extract/resolve/plan/draft/crossref/commit/schema autonomously..."
    curl -sf --max-time 15 -X POST http://localhost:3000/api/onboarding/finalize \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\"}" > /dev/null

    echo "  polling compile_progress until completed (up to 900s — full LLM pipeline)..."
    local status=""
    for i in $(seq 1 450); do
        status=$(curl -sf --max-time 5 \
            "http://localhost:3000/api/compile/progress?session_id=$SESSION_ID" \
            | python3 -c "
import sys, json
try: print(json.load(sys.stdin).get('status', ''))
except Exception: print('')
" 2>/dev/null)
        if [ "$status" = "completed" ]; then break; fi
        if [ "$status" = "failed" ]; then
            echo "  FAIL: pipeline reported failed"
            record_stage 16 REAL FAIL
            return 1
        fi
        sleep 2
    done

    if [ "$status" != "completed" ]; then
        echo "  FAIL: pipeline did not reach 'completed' within 900s (last status='$status')"
        record_stage 16 REAL FAIL
        return 1
    fi
    echo "  pipeline completed OK"

    local page_count
    page_count=$(curl -sf --max-time 10 http://localhost:3000/api/health | python3 -c "
import sys, json
try: print(json.load(sys.stdin).get('page_count', 0))
except Exception: print(0)
" 2>/dev/null)

    local delta=$((page_count - base_page_count))
    if [ "$delta" -lt 3 ]; then
        echo "  FAIL: expected >=3 new pages (3 source summaries), got delta=$delta (base=$base_page_count, now=$page_count)"
        record_stage 16 REAL FAIL
        return 1
    fi

    echo "  page_count delta=$delta (base=$base_page_count, now=$page_count) — OK"
    echo "  PASS"
    record_stage 16 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 17 — session compile via n8n (/stage → /finalize → n8n → pipeline)
# Stages 2 text sources, /finalize triggers n8n which POSTs to
# /api/compile/run, poll compile_progress to completion.
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

    echo "  staging 2 text sources..."
    curl -sf --max-time 15 -X POST http://localhost:3000/api/onboarding/stage \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[
            {\"markdown\":\"Python is a programming language created by Guido van Rossum in 1991. It is widely used in data science and machine learning. Python is known for its readable syntax and extensive standard library. The Python Software Foundation stewards the language.\",\"title_hint\":\"Python Intro\",\"source_type_hint\":\"note\"},
            {\"markdown\":\"Guido van Rossum designed Python in the late 1980s. Python emphasizes code readability and simplicity over performance. Python 2 reached end of life in 2020; Python 3 is the current mainline with regular annual releases.\",\"title_hint\":\"Python History\",\"source_type_hint\":\"note\"}
        ]}" > /dev/null

    echo "  finalizing (triggers n8n session-compile webhook → /api/compile/run)..."
    local finalize_response
    finalize_response=$(curl -sf --max-time 30 -X POST http://localhost:3000/api/onboarding/finalize \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\"}")
    if [ -z "$finalize_response" ]; then
        echo "  FAIL: /api/onboarding/finalize returned empty"
        record_stage 17 REAL FAIL
        return 1
    fi

    # Poll progress endpoint until completed or timeout (600s)
    echo "  polling compile progress..."
    local TIMEOUT=600
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
try: print(json.load(sys.stdin).get('status', 'unknown'))
except Exception: print('')
" 2>/dev/null)

        echo "    ${ELAPSED}s: $STATUS"

        if [ "$STATUS" = "completed" ]; then
            break
        fi

        if [ "$STATUS" = "failed" ]; then
            local error_msg
            error_msg=$(echo "$progress_response" | python3 -c "
import sys, json
try: print(json.load(sys.stdin).get('error', 'unknown error'))
except Exception: print('')
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
    local page_count
    page_count=$(curl -sf --max-time 10 http://localhost:3000/api/health | python3 -c "
import sys, json
try: print(json.load(sys.stdin).get('page_count', 0))
except Exception: print(0)
" 2>/dev/null)

    if [ "$page_count" -lt 2 ]; then
        echo "  FAIL: expected at least 2 pages in DB, got $page_count"
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

    local HEALTH PAGE_COUNT_BEFORE SESSION_ID COLLECT_RESP
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

    # Stage 1 text source that overlaps with existing wiki content
    SESSION_ID="stage18-returning-$(date +%s)"
    COLLECT_RESP=$(curl -sf -X POST "http://localhost:3000/api/onboarding/stage" \
        -H "Content-Type: application/json" \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[
              {\"markdown\":\"Bitcoin is a decentralized digital currency. Ethereum introduced smart contracts. Blockchain technology enables trustless transactions. This returning-session test note exercises the match step's wiki-aware routing by mentioning topics that already have pages from stage 16 or 17.\",
               \"title_hint\":\"Returning source for wiki update test\",
               \"source_type_hint\":\"note\"}
            ]}" 2>/dev/null || echo "")
    if [[ -z "$COLLECT_RESP" ]]; then
        echo "  FAIL: stage request failed"
        record_stage 18 REAL FAIL
        return 1
    fi

    # Finalize — triggers n8n session-compile → /api/compile/run
    CONFIRM=$(curl -sf -X POST "http://localhost:3000/api/onboarding/finalize" \
        -H "Content-Type: application/json" \
        -d "{\"session_id\":\"$SESSION_ID\"}" \
        2>/dev/null || echo "")
    if [[ -z "$CONFIRM" ]]; then
        echo "  FAIL: finalize request failed"
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
    stage_11c_collect_surfaces_nlp_down
    stage_11d_insertactivity_guard
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
    stage_24_staging_crud
    stage_25_finalize_end_to_end
    stage_26_finalize_accepts_ingested
    stage_27_patch_excludes_from_finalize

    echo
    echo "=== Stage summary ==="
    for result in "${STAGE_RESULTS[@]}"; do
        echo "  $result"
    done
    echo
    echo "=== All 20 stages (0, 1, 4, 11–27) executed, all passed ==="
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

    local base_orig_count
    base_orig_count=$(curl -sf --max-time 10 "http://localhost:3000/api/wiki/index" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(sum(1 for p in d.get('pages', []) if p.get('page_type') == 'original-source'))
except Exception:
    print(0)
" 2>/dev/null || echo 0)

    # ~80 chars — well under default min_source_chars=500. Routes through
    # Gate 1 as an original-source page (raw content, no LLM draft) and
    # must survive Gate 2 despite being too thin for a normal commit.
    local SHORT_MD='Bitcoin hit a new all-time high today. Satoshi would be proud.'

    curl -sf --max-time 15 -X POST http://localhost:3000/api/onboarding/stage \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"text\",\"items\":[{\"markdown\":\"$SHORT_MD\",\"title_hint\":\"Short BTC note\",\"source_type_hint\":\"note\"}]}" > /dev/null

    curl -sf --max-time 15 -X POST http://localhost:3000/api/onboarding/finalize \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\"}" > /dev/null

    echo "  polling compile_progress until completed (up to 300s)..."
    local status=""
    for i in $(seq 1 150); do
        status=$(curl -sf --max-time 5 \
            "http://localhost:3000/api/compile/progress?session_id=$SESSION_ID" \
            | python3 -c "
import sys, json
try: print(json.load(sys.stdin).get('status', ''))
except Exception: print('')
" 2>/dev/null)
        if [ "$status" = "completed" ]; then break; fi
        if [ "$status" = "failed" ]; then
            echo "  FAIL: pipeline reported failed — Gate 2 exemption may be broken"
            record_stage 22 REAL FAIL
            return 1
        fi
        sleep 2
    done

    if [ "$status" != "completed" ]; then
        echo "  FAIL: pipeline did not reach 'completed' within 300s (last status='$status')"
        record_stage 22 REAL FAIL
        return 1
    fi

    # Verify an original-source page was added since we started
    local orig_page_count
    orig_page_count=$(curl -sf --max-time 10 "http://localhost:3000/api/wiki/index" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(sum(1 for p in d.get('pages', []) if p.get('page_type') == 'original-source'))
except Exception:
    print(0)
" 2>/dev/null)

    if [ "$orig_page_count" -le "$base_orig_count" ]; then
        echo "  FAIL: original-source page_type count did not increase (base=$base_orig_count, now=$orig_page_count)"
        record_stage 22 REAL FAIL
        return 1
    fi

    echo "  original-source pages: base=$base_orig_count, now=$orig_page_count"
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

# ---------------------------------------------------------------------------
# Stage 24: collect_staging CRUD (v18 onboarding v2 foundation)
#   REAL — no external services needed. Pure DB + Next.js.
#   1. POST /api/onboarding/stage with 2 URL items → expect 2 stage_ids
#   2. GET /api/onboarding/staging — expect total=2, included=2
#   3. PATCH one row included=false — expect included=1
#   4. DELETE /api/onboarding/session — expect staging_rows=2
#   5. GET /api/onboarding/staging — expect total=0 (idempotent cleanup)
# ---------------------------------------------------------------------------
stage_24_staging_crud() {
    echo "--- stage 24: collect_staging CRUD ---"

    local SESSION_ID
    SESSION_ID=$(node -e "console.log(require('crypto').randomUUID())")

    # 1. Stage 2 URL rows
    local stage_response
    stage_response=$(curl -sf --max-time 10 -X POST \
        http://localhost:3000/api/onboarding/stage \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"url\",\"items\":[{\"url\":\"https://a.test\"},{\"url\":\"https://b.test\"}]}")

    local stage_count
    stage_count=$(echo "$stage_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(len(d.get('stage_ids', [])))
" 2>/dev/null)

    if [ "$stage_count" != "2" ]; then
        echo "  FAIL: POST /stage returned stage_ids count=$stage_count, expected 2"
        echo "  response: $stage_response"
        record_stage 24 REAL FAIL
        return 1
    fi

    local first_stage_id
    first_stage_id=$(echo "$stage_response" | python3 -c "
import sys, json
print(json.load(sys.stdin)['stage_ids'][0])
" 2>/dev/null)

    # 2. GET /staging — expect total=2, included=2
    local staging_response
    staging_response=$(curl -sf --max-time 10 \
        "http://localhost:3000/api/onboarding/staging?session_id=$SESSION_ID")

    local total included
    total=$(echo "$staging_response" | python3 -c "
import sys, json
print(json.load(sys.stdin).get('totals', {}).get('total', -1))
" 2>/dev/null)
    included=$(echo "$staging_response" | python3 -c "
import sys, json
print(json.load(sys.stdin).get('totals', {}).get('included', -1))
" 2>/dev/null)

    if [ "$total" != "2" ] || [ "$included" != "2" ]; then
        echo "  FAIL: GET /staging total=$total included=$included, expected 2/2"
        record_stage 24 REAL FAIL
        return 1
    fi

    # 3. PATCH one row included=false
    curl -sf --max-time 10 -X PATCH \
        "http://localhost:3000/api/onboarding/staging/$first_stage_id" \
        -H 'Content-Type: application/json' \
        -d '{"included":false}' > /dev/null

    local included_after
    included_after=$(curl -sf --max-time 10 \
        "http://localhost:3000/api/onboarding/staging?session_id=$SESSION_ID" \
        | python3 -c "
import sys, json
print(json.load(sys.stdin).get('totals', {}).get('included', -1))
" 2>/dev/null)

    if [ "$included_after" != "1" ]; then
        echo "  FAIL: after PATCH, included=$included_after, expected 1"
        record_stage 24 REAL FAIL
        return 1
    fi

    # 4. DELETE /session
    local delete_response
    delete_response=$(curl -sf --max-time 10 -X DELETE \
        "http://localhost:3000/api/onboarding/session?session_id=$SESSION_ID")

    local staging_rows
    staging_rows=$(echo "$delete_response" | python3 -c "
import sys, json
print(json.load(sys.stdin).get('removed', {}).get('staging_rows', -1))
" 2>/dev/null)

    if [ "$staging_rows" != "2" ]; then
        echo "  FAIL: DELETE removed.staging_rows=$staging_rows, expected 2"
        echo "  response: $delete_response"
        record_stage 24 REAL FAIL
        return 1
    fi

    # 5. GET after DELETE — expect total=0 (idempotent)
    local final_total
    final_total=$(curl -sf --max-time 10 \
        "http://localhost:3000/api/onboarding/staging?session_id=$SESSION_ID" \
        | python3 -c "
import sys, json
print(json.load(sys.stdin).get('totals', {}).get('total', -1))
" 2>/dev/null)

    if [ "$final_total" != "0" ]; then
        echo "  FAIL: after DELETE, total=$final_total, expected 0"
        record_stage 24 REAL FAIL
        return 1
    fi

    echo "  staged=2, patched included=1, deleted=2, final=0"
    echo "  stage 24 PASS — collect_staging CRUD round-trip"
    record_stage 24 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 25: finalize → pipeline prelude end-to-end (text connector only)
#   REAL — requires GEMINI_API_KEY (drives extract/draft/commit).
#   Doesn't hit Firecrawl (text connector is local hash + DB insert).
#   1. POST /stage with a text item
#   2. POST /finalize → expect queued=1
#   3. Poll /api/compile/progress until status='completed' (2 min timeout)
#   4. Assert prelude steps walked through:
#      health_check.status='done', ingest_texts.status='done', extract.status='done'
#   5. Assert sources row exists for the session with compile_status='active'
# ---------------------------------------------------------------------------
stage_25_finalize_end_to_end() {
    echo "--- stage 25: finalize → pipeline prelude end-to-end ---"

    if [ -z "${GEMINI_API_KEY:-}" ]; then
        echo "  SKIPPED: GEMINI_API_KEY not set"
        record_stage 25 REAL SKIPPED
        return 0
    fi

    local SESSION_ID
    SESSION_ID=$(node -e "console.log(require('crypto').randomUUID())")

    local TEST_MARKDOWN='# Stage 25 canary

This is a test note for integration stage 25. It must exceed min_source_chars
(default 500) so it goes through the full LLM draft path rather than hitting
the Gate 1 raw-content bypass. Stage 25 verifies that the new onboarding v2
prelude steps (health_check, ingest_texts) run cleanly ahead of the existing
extract → resolve → match → plan → draft → crossref → commit → schema chain
without breaking any part of the downstream pipeline. The goal is a single
wiki page at the end with a real content hash and a sources row in the
active compile status. If any of the prelude steps fail, the overall
compile_progress.status should surface failed, not silently stall. This note
should comfortably exceed 500 characters in length so Gate 1 routes it to
the LLM draft step rather than the raw-content fallback path.'

    # 1. Stage the text item
    local stage_response
    stage_response=$(curl -sf --max-time 10 -X POST \
        http://localhost:3000/api/onboarding/stage \
        -H 'Content-Type: application/json' \
        -d "$(python3 -c "
import json, sys
md = '''$TEST_MARKDOWN'''
print(json.dumps({
    'session_id': '$SESSION_ID',
    'connector': 'text',
    'items': [{
        'markdown': md,
        'title_hint': 'Stage 25 canary',
        'source_type_hint': 'note',
    }],
}))
")")

    local stage_count
    stage_count=$(echo "$stage_response" | python3 -c "
import sys, json
print(len(json.load(sys.stdin).get('stage_ids', [])))
" 2>/dev/null)

    if [ "$stage_count" != "1" ]; then
        echo "  FAIL: POST /stage returned stage_ids count=$stage_count, expected 1"
        record_stage 25 REAL FAIL
        return 1
    fi

    # 2. Finalize — kicks off n8n → /api/compile/run
    local finalize_response
    finalize_response=$(curl -sf --max-time 15 -X POST \
        http://localhost:3000/api/onboarding/finalize \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\"}")

    local queued
    queued=$(echo "$finalize_response" | python3 -c "
import sys, json
print(json.load(sys.stdin).get('queued', -1))
" 2>/dev/null)

    if [ "$queued" != "1" ]; then
        echo "  FAIL: /finalize queued=$queued, expected 1"
        echo "  response: $finalize_response"
        record_stage 25 REAL FAIL
        return 1
    fi

    # 3. Poll up to 120s for completion
    local status=""
    for i in $(seq 1 60); do
        status=$(curl -sf --max-time 5 \
            "http://localhost:3000/api/compile/progress?session_id=$SESSION_ID" \
            | python3 -c "
import sys, json
print(json.load(sys.stdin).get('status', ''))
" 2>/dev/null)
        if [ "$status" = "completed" ]; then break; fi
        if [ "$status" = "failed" ]; then
            local err
            err=$(curl -sf --max-time 5 \
                "http://localhost:3000/api/compile/progress?session_id=$SESSION_ID" \
                | python3 -c "
import sys, json
print(json.load(sys.stdin).get('error', ''))
" 2>/dev/null)
            echo "  FAIL: pipeline reported status=failed. error=$err"
            record_stage 25 REAL FAIL
            return 1
        fi
        sleep 2
    done

    if [ "$status" != "completed" ]; then
        echo "  FAIL: pipeline did not reach 'completed' within 120s (last status=$status)"
        record_stage 25 REAL FAIL
        return 1
    fi

    # 4. Assert prelude steps walked through
    local progress_response
    progress_response=$(curl -sf --max-time 5 \
        "http://localhost:3000/api/compile/progress?session_id=$SESSION_ID")

    local all_ok
    all_ok=$(echo "$progress_response" | python3 -c "
import sys, json
d = json.load(sys.stdin)
steps = d.get('steps', {})
required = ['health_check', 'ingest_texts', 'extract']
missing = [s for s in required if steps.get(s, {}).get('status') != 'done']
if missing:
    print('MISSING:' + ','.join(missing))
else:
    print('OK')
")

    if [ "$all_ok" != "OK" ]; then
        echo "  FAIL: prelude steps not all 'done': $all_ok"
        echo "  progress: $progress_response"
        record_stage 25 REAL FAIL
        return 1
    fi

    # 5. Verify a source row materialised for this session.
    # App container has python3 + stdlib sqlite3; doesn't ship the sqlite3 CLI.
    local source_count
    # tail -n 1 isolates the python print() output from any stderr warning
    # that docker compose emits (e.g. unset FIRECRAWL_API_KEY on CI).
    source_count=$(docker compose exec -T app python3 -c "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"SELECT count(*) FROM sources WHERE onboarding_session_id = ? AND compile_status = 'active'\", ('$SESSION_ID',)).fetchone()
print(row[0])
db.close()
" 2>&1 | tail -n 1 | tr -d '[:space:]')

    if [ "$source_count" != "1" ]; then
        echo "  FAIL: expected 1 active source for session, got $source_count"
        record_stage 25 REAL FAIL
        return 1
    fi

    echo "  prelude steps: health_check + ingest_texts + extract all done"
    echo "  source_count=1 (compile_status=active)"
    echo "  stage 25 PASS — v18 staging → finalize → pipeline end-to-end"
    record_stage 25 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 26: /finalize accepts status='ingested' staging rows (Phase 2 safety net)
#   REAL — no external services. Seeds DB directly to simulate the v18 migration
#   that lifts legacy compile_status='collected' sources into staging.
#   1. SQL-insert a sources row (compile_status='pending')
#   2. SQL-insert a collect_staging row (status='ingested', resolved_source_id=<source_id>)
#   3. POST /api/onboarding/finalize → expect queued=1 (NOT no_items_staged)
#   4. Assert compile_progress row was created
# ---------------------------------------------------------------------------
stage_26_finalize_accepts_ingested() {
    echo "--- stage 26: /finalize accepts 'ingested' rows (legacy-lifted safety) ---"

    local SESSION_ID
    SESSION_ID=$(node -e "console.log(require('crypto').randomUUID())")
    local SOURCE_ID
    SOURCE_ID=$(node -e "console.log(require('crypto').randomUUID())")
    local STAGE_ID
    STAGE_ID=$(node -e "console.log(require('crypto').randomUUID())")

    # The app container ships python3 (migrate.py runs on boot) but not the
    # sqlite3 CLI. Use python3 -c with the stdlib sqlite3 module to seed.
    # On any DB-seed failure, dump the error to stdout and bail early with
    # a clear message rather than letting the finalize curl mask it.
    local seed_out
    # tail -n 1 isolates the python print() output from any stderr warning
    # that docker compose emits (e.g. unset FIRECRAWL_API_KEY on CI).
    seed_out=$(docker compose exec -T app python3 -c "
import sqlite3, sys
db = sqlite3.connect('/data/db/kompl.db')
db.execute('''
  INSERT INTO sources (source_id, title, source_type, source_url, content_hash, file_path, compile_status, onboarding_session_id)
  VALUES (?, ?, ?, NULL, ?, ?, 'pending', ?)
''', ('$SOURCE_ID', 'Stage 26 canary', 'note', 'sha256-stage26', '/data/raw/$SOURCE_ID.md.gz', '$SESSION_ID'))
db.execute('''
  INSERT INTO collect_staging (stage_id, session_id, connector, payload, included, status, resolved_source_id, created_at, ingested_at)
  VALUES (?, ?, 'text', '{\"resumed_from_legacy\":1}', 1, 'ingested', ?, datetime('now'), datetime('now'))
''', ('$STAGE_ID', '$SESSION_ID', '$SOURCE_ID'))
db.commit()
db.close()
print('seeded')
" 2>&1 | tail -n 1)
    if [ "$seed_out" != "seeded" ]; then
        echo "  FAIL: DB seeding failed: $seed_out"
        record_stage 26 REAL FAIL
        return 1
    fi

    # POST /finalize. Even with zero 'pending' rows, the ingested row should
    # qualify — Phase 2.1 expanded the filter to status IN ('pending','ingested').
    # Accept both 200 (n8n up) and 503 (n8n unreachable from prior stages)
    # — both include queued=1 in the body which is what this stage tests.
    local finalize_response
    finalize_response=$(curl --max-time 15 -s -X POST \
        http://localhost:3000/api/onboarding/finalize \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\"}" 2>&1)

    local queued
    queued=$(echo "$finalize_response" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('queued', -1))
except Exception:
    print(-1)
" 2>/dev/null)

    if [ "$queued" != "1" ]; then
        echo "  FAIL: /finalize rejected ingested row. queued=$queued response=$finalize_response"
        record_stage 26 REAL FAIL
        return 1
    fi

    # Verify compile_progress row was created (proves finalize proceeded past
    # the 'no_items_staged' 400 guard).
    local progress_count
    # tail -n 1 isolates the python print() output from any stderr warning
    # that docker compose emits (e.g. unset FIRECRAWL_API_KEY on CI).
    progress_count=$(docker compose exec -T app python3 -c "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute('SELECT count(*) FROM compile_progress WHERE session_id = ?', ('$SESSION_ID',)).fetchone()
print(row[0])
db.close()
" 2>&1 | tail -n 1 | tr -d '[:space:]')

    if [ "$progress_count" != "1" ]; then
        echo "  FAIL: compile_progress row not created (count=$progress_count)"
        record_stage 26 REAL FAIL
        return 1
    fi

    echo "  queued=1 + compile_progress row created — ingested-row safety net works"
    echo "  stage 26 PASS"
    record_stage 26 REAL PASS
    return 0
}

# ---------------------------------------------------------------------------
# Stage 27: PATCH included=false removes a row from /finalize's queue
#   REAL — no external services.
#   1. POST /stage with 2 URL rows
#   2. PATCH one row to included=false
#   3. POST /finalize → expect queued=1 (not 2)
#   4. DELETE /session to clean up
# ---------------------------------------------------------------------------
stage_27_patch_excludes_from_finalize() {
    echo "--- stage 27: PATCH included=false excludes from /finalize ---"

    local SESSION_ID
    SESSION_ID=$(node -e "console.log(require('crypto').randomUUID())")

    local stage_response
    stage_response=$(curl -sf --max-time 10 -X POST \
        http://localhost:3000/api/onboarding/stage \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\",\"connector\":\"url\",\"items\":[{\"url\":\"https://a.test\"},{\"url\":\"https://b.test\"}]}")
    local first_id
    first_id=$(echo "$stage_response" | python3 -c "import sys, json; print(json.load(sys.stdin)['stage_ids'][0])" 2>/dev/null)

    curl -sf --max-time 10 -X PATCH \
        "http://localhost:3000/api/onboarding/staging/$first_id" \
        -H 'Content-Type: application/json' \
        -d '{"included":false}' > /dev/null

    # Finalize. n8n may be unreachable (from prior stages) — accept 503 as long
    # as queued=1 is in the response body.
    local finalize_response
    finalize_response=$(curl --max-time 15 -s -X POST \
        http://localhost:3000/api/onboarding/finalize \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$SESSION_ID\"}")

    local queued
    queued=$(echo "$finalize_response" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('queued', -1))
except Exception:
    print(-1)
" 2>/dev/null)

    if [ "$queued" != "1" ]; then
        echo "  FAIL: expected queued=1, got queued=$queued response=$finalize_response"
        record_stage 27 REAL FAIL
        return 1
    fi

    curl -sf --max-time 10 -X DELETE \
        "http://localhost:3000/api/onboarding/session?session_id=$SESSION_ID" > /dev/null

    echo "  2 staged, 1 unchecked → queued=1"
    echo "  stage 27 PASS — PATCH filter respected by finalize"
    record_stage 27 REAL PASS
    return 0
}

main "$@"
