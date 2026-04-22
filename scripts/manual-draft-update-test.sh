#!/usr/bin/env bash
#
# Manual verification for the "update drafts load existing page markdown" fix.
#
# Before this fix, plan.draft_content (always NULL on first draft pass) was
# passed as existing_content to the Gemini draft-page prompt, so the
# "Existing page content (update this, don't rewrite from scratch):" block
# was silently skipped on every update — the LLM drafted from raw sources
# ignorant of the existing page, rewriting instead of updating.
#
# Scenario:
#   M — session A seeds a page with a distinctive phrase; session B ingests
#       an overlapping source expected to trigger match.decision='update';
#       both phrases must survive in the final page markdown, proving the
#       LLM saw existing content during the update draft.
#
# Prereqs:
#   - Docker stack healthy (app, nlp-service, n8n)
#   - GEMINI_API_KEY in the app container env
#   - Clean DB strongly recommended (docker compose down -v) — existing pages
#     can mask the behaviour under test
#
# Usage:  bash scripts/manual-draft-update-test.sh
# Exit:   0 on pass, non-zero on any assertion failure.

set -uo pipefail

# Windows Git Bash compatibility for python3 (same pattern as sibling scripts).
if ! python3 --version 2>&1 | grep -q "Python 3"; then
    python3() { python "$@"; }
    export -f python3
fi

BASE="http://localhost:3000"
NOW=$(date +%s)
SESSION_A="du-A-$NOW"          # seed page with phrase 1
SESSION_B="du-B-$NOW"          # update page with phrase 2
COMPILE_TIMEOUT=360            # seconds per compile

echo "=== Update-draft existing-content verification ==="
echo

pass() { echo "  PASS — $*" ; }
fail() { echo "  FAIL — $*" ; exit 1 ; }

query_db() {
    docker exec komplcore-app-1 python3 -c "$1"
}

wait_compile() {
    local session="$1"
    local start now status elapsed
    start=$(date +%s)
    while :; do
        now=$(date +%s)
        elapsed=$((now - start))
        if [ "$elapsed" -gt "$COMPILE_TIMEOUT" ]; then
            echo "    TIMEOUT after ${elapsed}s"
            return 1
        fi
        status=$(curl -sf "$BASE/api/compile/progress?session_id=$session" 2>/dev/null \
                 | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("status",""))' 2>/dev/null \
                 || echo "")
        echo "    $session status=$status (${elapsed}s)"
        case "$status" in
            completed) return 0 ;;
            failed|cancelled) return 1 ;;
        esac
        sleep 5
    done
}

stage_text() {
    local session="$1" title="$2" body="$3"
    export STG_SESSION="$session" STG_TITLE="$title" STG_BODY="$body"
    local payload
    payload=$(python3 -c "
import json, os
print(json.dumps({
    'session_id': os.environ['STG_SESSION'],
    'connector': 'text',
    'items': [{
        'markdown': os.environ['STG_BODY'],
        'title_hint': os.environ['STG_TITLE'],
        'source_type_hint': 'note',
    }]
}))
")
    curl -s -X POST "$BASE/api/onboarding/stage" \
        -H 'Content-Type: application/json' \
        -d "$payload"
}

finalize_session() {
    curl -s --max-time 15 -X POST "$BASE/api/onboarding/finalize" \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$1\"}"
}

read_page_markdown() {
    # Prefer pending_content (set before file flush in outbox pattern),
    # fall back to reading content_path from the app container.
    # Pass the title through `docker exec -e` because host env exports do
    # not cross the container boundary.
    local title="$1"
    docker exec -e QB_TITLE="$title" komplcore-app-1 python3 -c "
import os, sqlite3, gzip
con = sqlite3.connect('/data/db/kompl.db')
# Filter by entity — a single title can have both an 'original-source' and an
# 'entity' row; only the entity page is the one that receives match-updates.
row = con.execute(
    \"SELECT page_id, content_path, pending_content FROM pages WHERE title = ? COLLATE NOCASE AND page_type = 'entity' LIMIT 1\",
    (os.environ['QB_TITLE'],)
).fetchone()
if row is None:
    raise SystemExit('no page with title=' + os.environ['QB_TITLE'])
page_id, content_path, pending = row
if pending:
    print(pending)
else:
    with gzip.open(content_path, 'rt', encoding='utf-8') as fh:
        print(fh.read())
"
}

# ─── Preflight: make sure singletons get a page so we have something to update ─
echo "[preflight] entity_promotion_threshold=1"
curl -s -X POST "$BASE/api/settings" \
    -H 'Content-Type: application/json' \
    -d '{"entity_promotion_threshold":1}' > /dev/null
pass "settings ready"

# ═══════════════════════════════════════════════════════════════════════════
# STEP 1 — seed page with PHRASE_A
# ═══════════════════════════════════════════════════════════════════════════
# Two distinctive phrases we can grep for in the final page markdown.
# These are chosen so a rewrite would likely drop phrase A; an update that
# actually saw existing content would preserve it.
PHRASE_A="Claude 3.5 Sonnet is priced at \$3 per million input tokens"
PHRASE_B="Claude 3.5 Sonnet supports a 200K token context window"

A_BODY="[run-$NOW] Claude 3.5 Sonnet is Anthropic's flagship model. ${PHRASE_A}. It is accessed via the Anthropic API, Amazon Bedrock, and Google Vertex AI. Claude 3.5 Sonnet is widely used for coding and analysis tasks."
echo "[M1] stage + finalize session A (seed page with PHRASE_A)"
stage_text "$SESSION_A" "Claude 3.5 Sonnet" "$A_BODY" > /dev/null
finalize_session "$SESSION_A" > /dev/null
pass "session A queued"

echo "[M2] wait for session A compile"
wait_compile "$SESSION_A" || fail "session A did not complete"
pass "session A completed"

echo "[M3] assert PHRASE_A present in initial page"
PAGE_V1=$(read_page_markdown "Claude 3.5 Sonnet" 2>&1 || true)
if [ -z "$PAGE_V1" ] || echo "$PAGE_V1" | grep -q "no page with title="; then
    fail "page 'Claude 3.5 Sonnet' not created by session A"
fi
if echo "$PAGE_V1" | grep -q "priced at \$3 per million input tokens"; then
    pass "PHRASE_A present in v1 page"
else
    echo "--- v1 page (truncated) ---"
    echo "$PAGE_V1" | head -30
    echo "---"
    fail "PHRASE_A absent in v1 — session A didn't emit the phrase (fix test fixture)"
fi

# ═══════════════════════════════════════════════════════════════════════════
# STEP 2 — update page with PHRASE_B, expecting match.decision='update'
# ═══════════════════════════════════════════════════════════════════════════
B_BODY="[run-$NOW] Anthropic's Claude 3.5 Sonnet model. ${PHRASE_B}. Claude 3.5 Sonnet leads public benchmarks on coding evaluations including HumanEval and SWE-Bench. Developers consume Claude 3.5 Sonnet through the Messages API."
echo "[M4] stage + finalize session B (overlap with existing page to trigger match-update)"
stage_text "$SESSION_B" "Claude 3.5 Sonnet benchmarks" "$B_BODY" > /dev/null
finalize_session "$SESSION_B" > /dev/null
pass "session B queued"

echo "[M5] wait for session B compile"
wait_compile "$SESSION_B" || fail "session B did not complete"
pass "session B completed"

echo "[M6] read updated page markdown"
PAGE_V2=$(read_page_markdown "Claude 3.5 Sonnet" 2>&1 || true)
if [ -z "$PAGE_V2" ]; then
    fail "could not read updated page"
fi

echo "[M7] assert PHRASE_B integrated (session B content arrived)"
if echo "$PAGE_V2" | grep -qi "200K token context window"; then
    pass "PHRASE_B integrated"
else
    echo "--- v2 page (truncated) ---"
    echo "$PAGE_V2" | head -40
    echo "---"
    fail "PHRASE_B absent in v2 — session B content never landed"
fi

echo "[M8] assert PHRASE_A PRESERVED through update (proves LLM saw existing content)"
if echo "$PAGE_V2" | grep -q "priced at \$3 per million input tokens"; then
    pass "PHRASE_A preserved through update — existing_content was passed to LLM"
else
    echo "--- v2 page (truncated) ---"
    echo "$PAGE_V2" | head -40
    echo "---"
    fail "PHRASE_A absent in v2 — the LLM rewrote instead of updating. Fix regression."
fi

echo
echo "=== ALL STEPS PASSED ==="
echo "The update path successfully integrates new source content while preserving"
echo "the existing page. Existing-content wiring verified end-to-end."
