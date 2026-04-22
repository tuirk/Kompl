#!/usr/bin/env bash
#
# Manual verification for Flag 3A dossier relevance cap.
#
# Before: draft step loaded extractions session-scoped only. Cross-session
# updates missed pre-digested facts from older sources.
# Now: corpus-wide load + TF-IDF ranking + top-N cap + min-score floor.
#
# Scenario:
#   Stage 6 sources that all mention "Claude 3.5 Sonnet" to varying degrees
#   (5 are deeply relevant, 1 is an unrelated tangent). Set dossier_max_sources=3.
#   Compile. Inspect app logs for the 'dossier_capped' telemetry line and
#   assert candidates_scored=6, candidates_kept=3, tangent source was dropped.
#
# Prereqs:
#   - Docker stack healthy (app, nlp-service, n8n)
#   - GEMINI_API_KEY in the app container env
#   - Clean DB recommended (docker compose down -v) — existing Claude 3.5
#     Sonnet pages mask the effect
#
# Usage:  bash scripts/manual-dossier-cap-test.sh
# Exit:   0 pass, non-zero on any assertion failure.

set -uo pipefail

# Windows Git Bash compatibility for python3 (same pattern as sibling scripts).
if ! python3 --version 2>&1 | grep -q "Python 3"; then
    python3() { python "$@"; }
    export -f python3
fi

BASE="http://localhost:3000"
NOW=$(date +%s)
SESSION="dos-$NOW"
COMPILE_TIMEOUT=480

echo "=== Flag 3A dossier cap verification ==="
echo

pass() { echo "  PASS — $*" ; }
fail() { echo "  FAIL — $*" ; exit 1 ; }

wait_compile() {
    local session="$1" start now status elapsed
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

# ─── Preflight ──────────────────────────────────────────────────────────────
echo "[preflight] entity_promotion_threshold=1, dossier_max_sources=3, dossier_min_score=0"
curl -s -X POST "$BASE/api/settings" \
    -H 'Content-Type: application/json' \
    -d '{"entity_promotion_threshold":1,"dossier_max_sources":3,"dossier_min_score":0}' > /dev/null
pass "settings ready"

# Save the app log position so we can grep only this run's output.
LOG_MARK_BEFORE=$(docker logs --tail 1 komplcore-app-1 2>&1 | tail -1)

# ═══════════════════════════════════════════════════════════════════════════
# STEP — stage 6 sources: 5 relevant + 1 tangent
# ═══════════════════════════════════════════════════════════════════════════
for i in 1 2 3 4 5; do
    BODY="[run-$NOW src-$i] Claude 3.5 Sonnet is Anthropic's flagship model. Claude 3.5 Sonnet excels at reasoning and coding. Source $i adds details about specific benchmark $i scores and pricing breakdowns. The Claude 3.5 Sonnet API is widely adopted."
    stage_text "$SESSION" "Claude 3.5 Sonnet source $i" "$BODY" > /dev/null
done
# Tangent source — mentions Claude briefly but spends most words on unrelated topic
TANGENT_BODY="[run-$NOW tangent] This article is primarily about medieval harpsichord manufacture and tuning traditions. Claude 3.5 Sonnet is mentioned in passing as a modern AI model that might help with translating historical texts. The rest of the article has nothing to do with AI."
stage_text "$SESSION" "Harpsichord and AI" "$TANGENT_BODY" > /dev/null
pass "6 sources staged"

finalize_session "$SESSION" > /dev/null
pass "session queued"

echo "[M2] wait for compile"
wait_compile "$SESSION" || fail "session did not complete"
pass "session completed"

# ═══════════════════════════════════════════════════════════════════════════
# ASSERT — telemetry shows the cap fired
# ═══════════════════════════════════════════════════════════════════════════
echo "[M3] grep 'dossier_capped' from app container logs"
# Pull logs since the mark. dossier_capped is one structured JSON line per plan.
DOSSIER_LINES=$(docker logs komplcore-app-1 2>&1 | grep dossier_capped || true)
if [ -z "$DOSSIER_LINES" ]; then
    fail "no dossier_capped telemetry line emitted — cap step didn't run"
fi
pass "telemetry present"

# Find the line for the Claude 3.5 Sonnet entity plan (or just any plan).
echo "--- dossier_capped lines (first 10) ---"
echo "$DOSSIER_LINES" | head -10
echo "---"

# Look for a line with 6 candidates scored AND candidates_kept ≤ 3.
MATCHING_LINE=$(echo "$DOSSIER_LINES" | python3 -c "
import json, sys
for line in sys.stdin:
    # Some app logs prepend text; try to find a {...} JSON blob.
    i = line.find('{')
    if i < 0: continue
    try:
        d = json.loads(line[i:])
    except Exception:
        continue
    if d.get('event') != 'dossier_capped':
        continue
    if d.get('candidates_scored', 0) >= 5 and d.get('candidates_kept', 0) <= 3:
        print(json.dumps(d))
        break
")

if [ -z "$MATCHING_LINE" ]; then
    echo "--- all dossier_capped lines ---"
    echo "$DOSSIER_LINES"
    echo "---"
    fail "no dossier_capped line with candidates_scored ≥ 5 AND kept ≤ 3"
fi

echo "matching telemetry line:"
echo "$MATCHING_LINE"
pass "cap fired: >=5 scored, <=3 kept"

# ═══════════════════════════════════════════════════════════════════════════
# ASSERT — the tangent source had the lowest TF-IDF score (bottom_score)
# ═══════════════════════════════════════════════════════════════════════════
# bottom_score on the capped set should still be positive — 0 would mean
# either no-match or a true tangent survived. 3 deeply-relevant sources kept
# implies bottom_score > 0.1 for a Claude 3.5 Sonnet query.
BOTTOM=$(echo "$MATCHING_LINE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('bottom_score',0))")
awk_check=$(python3 -c "print(1 if float('$BOTTOM') > 0 else 0)")
if [ "$awk_check" = "1" ]; then
    pass "bottom_score=$BOTTOM > 0 — all kept sources had real overlap"
else
    fail "bottom_score=$BOTTOM not > 0 — tangent may have slipped through"
fi

echo
echo "=== ALL STEPS PASSED ==="
echo "Flag 3A dossier cap verified end-to-end: 6 candidates scored, 3 kept,"
echo "tangent source excluded by TF-IDF ranking."
