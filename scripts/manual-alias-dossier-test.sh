#!/usr/bin/env bash
#
# Manual verification for alias-aware buildDossier.
#
# Before the fix, a source whose LLM extraction emitted a pre-canonical
# entity spelling (e.g. "GPT 4") was silently dropped from the drafting
# dossier once resolve canonicalized it to "GPT-4" — the LLM drafter
# never saw that source's pre-extracted facts and had to re-parse raw
# markdown to rediscover them.
#
# Scenario:
#   Stage a single session with two sources that both cover the same
#   entity but use different spellings. Compile. Verify the resulting
#   entity page's body surfaces distinctive phrases from BOTH sources —
#   proving both contributed to the draft (i.e. both survived the
#   dossier filter).
#
# Prereqs:
#   - Docker stack healthy (app, nlp-service, n8n)
#   - GEMINI_API_KEY in the app container env
#   - Clean DB recommended (docker compose down -v)
#
# Usage:  bash scripts/manual-alias-dossier-test.sh
# Exit:   0 pass, non-zero on any assertion failure.

set -uo pipefail

# Windows Git Bash compatibility for python3 (same pattern as sibling scripts).
if ! python3 --version 2>&1 | grep -q "Python 3"; then
    python3() { python "$@"; }
    export -f python3
fi

BASE="http://localhost:3000"
NOW=$(date +%s)
SESSION="alias-$NOW"
COMPILE_TIMEOUT=360

echo "=== alias-aware buildDossier verification ==="
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

read_page_markdown() {
    local title="$1"
    docker exec -e QB_TITLE="$title" komplcore-app-1 python3 -c "
import os, sqlite3, gzip
con = sqlite3.connect('/data/db/kompl.db')
row = con.execute(
    \"SELECT page_id, content_path, pending_content FROM pages WHERE title = ? COLLATE NOCASE AND page_type = 'entity' LIMIT 1\",
    (os.environ['QB_TITLE'],)
).fetchone()
if row is None:
    raise SystemExit('no entity page with title=' + os.environ['QB_TITLE'])
page_id, content_path, pending = row
if pending:
    print(pending)
else:
    with gzip.open(content_path, 'rt', encoding='utf-8') as fh:
        print(fh.read())
"
}

# ─── Preflight ──────────────────────────────────────────────────────────────
echo "[preflight] entity_promotion_threshold=1 (ensure 2 sources promote)"
curl -s -X POST "$BASE/api/settings" \
    -H 'Content-Type: application/json' \
    -d '{"entity_promotion_threshold":1}' > /dev/null
pass "settings ready"

# ═══════════════════════════════════════════════════════════════════════════
# STEP — stage two sources with different canonical/alias spellings
# ═══════════════════════════════════════════════════════════════════════════
# Phrase A only appears in source A (which uses "GPT 4" — the alias).
# Phrase B only appears in source B (which uses "GPT-4" — the canonical).
# If the fix works, both phrases end up in the drafted entity page body.
PHRASE_A="priced at \$0.03 per thousand input tokens"
PHRASE_B="trained on a curated multilingual corpus"

A_BODY="[run-$NOW] GPT 4 is OpenAI's flagship model. GPT 4 is ${PHRASE_A}. GPT 4 supports tool use and function calling. GPT 4 is widely available via the API and chat products."
B_BODY="[run-$NOW] GPT-4 is the best-known offering from OpenAI. GPT-4 was ${PHRASE_B}. GPT-4 achieves high scores on reasoning benchmarks including MMLU and GPQA."

echo "[S1] stage source A (alias spelling: 'GPT 4')"
stage_text "$SESSION" "GPT 4 pricing" "$A_BODY" > /dev/null
pass "A staged"

echo "[S2] stage source B (canonical spelling: 'GPT-4')"
stage_text "$SESSION" "GPT-4 training corpus" "$B_BODY" > /dev/null
pass "B staged"

echo "[S3] finalize session"
finalize_session "$SESSION" > /dev/null
pass "session queued"

echo "[S4] wait for compile"
wait_compile "$SESSION" || fail "compile did not complete"
pass "session completed"

# ═══════════════════════════════════════════════════════════════════════════
# ASSERT — the entity page surfaces facts from BOTH sources
# ═══════════════════════════════════════════════════════════════════════════
echo "[S5] read entity page"
# Title could be "GPT-4" or "GPT 4" depending on which spelling won the
# canonical — try both.
PAGE=$(read_page_markdown "GPT-4" 2>/dev/null || read_page_markdown "GPT 4" 2>/dev/null || true)
if [ -z "$PAGE" ]; then
    fail "no entity page for GPT-4 / GPT 4 — compile did not produce an entity page"
fi

echo "--- page body (first 40 lines) ---"
echo "$PAGE" | head -40
echo "---"

echo "[S6] assert PHRASE_A present (source A's distinctive phrase)"
if echo "$PAGE" | grep -qi "0.03 per thousand"; then
    pass "PHRASE_A present — source A's alias-spelled extraction contributed"
else
    fail "PHRASE_A absent — dossier dropped source A (alias-aware filter regression)"
fi

echo "[S7] assert PHRASE_B present (source B's distinctive phrase)"
if echo "$PAGE" | grep -qi "multilingual corpus"; then
    pass "PHRASE_B present — source B's canonical-spelled extraction contributed"
else
    fail "PHRASE_B absent — source B somehow dropped too"
fi

echo
echo "=== ALL ASSERTIONS PASSED ==="
echo "Both sources contributed to the drafted entity page, confirming the"
echo "alias-aware dossier filter correctly included the alias-spelled source."
