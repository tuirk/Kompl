#!/usr/bin/env bash
#
# Manual verification for the match-triage + comparison-canonicalization PR.
#
# Three scenarios:
#   A — match.decision='update': a source that content-overlaps an existing page
#       triggers a new 'update' plan driven by the match step (not just title-match).
#   B — match.decision='contradiction': a source that contradicts an existing
#       page logs a rich activity row AND surfaces through the /contradictions
#       API that powers the wiki page sidebar.
#   C — comparison canonicalization: three sources with a non-canonical
#       relationship spelling ("gpt 4 competes_with Claude") still produce a
#       single "Claude vs GPT-4" comparison page.
#
# Prereqs:
#   - Docker stack healthy (app, nlp-service, n8n)
#   - GEMINI_API_KEY in the app container env
#   - Clean DB recommended (integration-test Stage 0 wipes volumes)
#
# Usage:  bash scripts/manual-match-triage-test.sh
# Exit:   0 all scenarios pass; non-zero on any assertion failure

set -uo pipefail

# Windows Git Bash compatibility for python3 (same pattern as integration-test.sh).
if ! python3 --version 2>&1 | grep -q "Python 3"; then
    python3() { python "$@"; }
    export -f python3
fi

BASE="http://localhost:3000"
NOW=$(date +%s)
SESSION_A="mt-A-$NOW"          # Scenario A: seed a deep page on Claude 3.5 Sonnet
SESSION_B="mt-B-$NOW"          # Scenario A cont'd: add substantively overlapping source
SESSION_C="mt-C-$NOW"          # Scenario B: contradicts A's claim
SESSION_D="mt-D-$NOW"          # Scenario C: first comparison source
SESSION_E="mt-E-$NOW"          # Scenario C: second
SESSION_F="mt-F-$NOW"          # Scenario C: third
COMPILE_TIMEOUT=360            # seconds per compile

echo "=== Match-triage + comparison canonicalization verification ==="
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

# ─── Preflight: set entity threshold to 1 so singletons promote ─────────────
echo "[preflight] entity_promotion_threshold=1"
curl -s -X POST "$BASE/api/settings" \
    -H 'Content-Type: application/json' \
    -d '{"entity_promotion_threshold":1}' > /dev/null
pass "settings ready"

# ═══════════════════════════════════════════════════════════════════════════
# SCENARIO A — match.decision='update' pathway
# ═══════════════════════════════════════════════════════════════════════════
echo
echo "### Scenario A — match.decision='update' ###"

# Salt bodies with $NOW so re-runs don't hit SHA-256 content-hash dedup
# (findSourceByContentHash in ingest-texts — legitimate prod behaviour that
# makes this script look like it works when it actually skipped everything).
A_BODY="[run-$NOW] Claude 3.5 Sonnet is Anthropic's flagship large language model released in 2024. Claude 3.5 Sonnet leads public benchmarks on coding evaluations. The model supports a 200k token context window and tool use. Developers access Claude 3.5 Sonnet via the Anthropic API, Amazon Bedrock, and Google Vertex AI."
echo "[A1] stage session A about Claude 3.5 Sonnet"
stage_text "$SESSION_A" "Claude 3.5 Sonnet" "$A_BODY" > /dev/null
echo "[A2] finalize session A"
finalize_session "$SESSION_A" > /dev/null
echo "[A3] poll session A compile"
wait_compile "$SESSION_A" || fail "session A did not complete"
pass "session A compiled"

B_BODY="[run-$NOW] Claude 3.5 Sonnet scored highest in recent SWE-bench coding agent evaluations. Claude 3.5 Sonnet demonstrates strong instruction following across multilingual prompts. The Anthropic API exposes Claude 3.5 Sonnet with consistent pricing across regions. Early adopters use Claude 3.5 Sonnet for automated documentation generation."
echo "[A4] stage session B — overlapping detail on Claude 3.5 Sonnet"
stage_text "$SESSION_B" "Claude 3.5 Sonnet — coding agent benchmarks" "$B_BODY" > /dev/null
echo "[A5] finalize session B"
finalize_session "$SESSION_B" > /dev/null
echo "[A6] poll session B compile"
wait_compile "$SESSION_B" || fail "session B did not complete"
pass "session B compiled"

echo "[A7] look for match-driven update plan in session B"
claude_page_id=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"SELECT page_id FROM pages WHERE title = 'Claude 3.5 Sonnet' COLLATE NOCASE AND page_type = 'entity'\").fetchone()
print(row[0] if row else '')
db.close()
")
if [ -z "$claude_page_id" ]; then
    fail "could not find 'Claude 3.5 Sonnet' entity page"
fi
echo "    claude_page_id=$claude_page_id"

update_count=$(query_db "
import sqlite3, json
db = sqlite3.connect('/data/db/kompl.db')
rows = db.execute(\"\"\"
    SELECT details FROM activity_log
     WHERE action_type = 'page_compiled'
       AND json_extract(details, '\$.session_id') = ?
       AND json_extract(details, '\$.action') = 'update'
       AND json_extract(details, '\$.page_id') = ?
\"\"\", ('$SESSION_B', '$claude_page_id')).fetchall()
print(len(rows))
db.close()
")
if [ "$update_count" -ge "1" ]; then
    pass "session B wrote an update for Claude 3.5 Sonnet ($update_count event(s))"
else
    fail "no update event recorded for session B on Claude 3.5 Sonnet — match.update triage may not be firing"
fi

prov_count_a=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"SELECT COUNT(DISTINCT source_id) FROM provenance WHERE page_id = '$claude_page_id'\").fetchone()
print(row[0])
db.close()
")
if [ "$prov_count_a" -ge "2" ]; then
    pass "provenance has $prov_count_a distinct sources (A + B)"
else
    fail "provenance has only $prov_count_a source — B didn't attach"
fi

# ═══════════════════════════════════════════════════════════════════════════
# SCENARIO B — match.decision='contradiction' pathway
# ═══════════════════════════════════════════════════════════════════════════
echo
echo "### Scenario B — match.decision='contradiction' ###"

C_BODY="[run-$NOW] Claude 3.5 Sonnet is actually Anthropic's slowest and most expensive model. Claude 3.5 Sonnet has a mere 8k token context window and no tool use support. Claude 3.5 Sonnet is only available through private beta. Claude 3.5 Sonnet scored poorly on SWE-bench."
echo "[B1] stage session C — claims that contradict the Claude 3.5 Sonnet page"
stage_text "$SESSION_C" "Claude 3.5 Sonnet — critical take" "$C_BODY" > /dev/null
echo "[B2] finalize session C"
finalize_session "$SESSION_C" > /dev/null
echo "[B3] poll session C compile"
wait_compile "$SESSION_C" || fail "session C did not complete"
pass "session C compiled"

echo "[B4] query activity_log for page_contradiction_detected on the Claude page"
contra_row=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"\"\"
    SELECT details FROM activity_log
     WHERE action_type = 'page_contradiction_detected'
       AND json_extract(details, '\$.page_id') = ?
     ORDER BY id DESC LIMIT 1
\"\"\", ('$claude_page_id',)).fetchone()
print(row[0] if row else '')
db.close()
")
if [ -z "$contra_row" ]; then
    fail "no page_contradiction_detected activity row written"
fi
pass "activity row exists"

echo "[B5] verify activity row payload shape"
missing=$(echo "$contra_row" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
required = ['page_id','page_title','source_title','source_url','source_type','date_ingested','reason','session_id','detected_at']
missing = [k for k in required if k not in d]
print(','.join(missing))
")
if [ -z "$missing" ]; then
    pass "all required fields present in activity details"
else
    fail "missing fields in activity details: $missing"
fi

echo "[B6] fetch /api/wiki/<page>/contradictions"
api_resp=$(curl -sf "$BASE/api/wiki/$claude_page_id/contradictions")
api_count=$(echo "$api_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('count', -1))")
if [ "$api_count" -ge "1" ]; then
    pass "API returns $api_count contradiction(s) — sidebar will render"
else
    fail "API returned $api_count — sidebar would show nothing. Response: $api_resp"
fi

# ═══════════════════════════════════════════════════════════════════════════
# SCENARIO C — comparison canonicalization
# ═══════════════════════════════════════════════════════════════════════════
echo
echo "### Scenario C — comparison canonicalization ###"

# Prime the wiki with a GPT-4 page so the resolver has an existing title to
# anchor to (and so entity threshold=1 promotes GPT-4 immediately).
echo "[C1-prime] ingest a quick GPT-4 source so the page exists + is anchorable"
PRIME_BODY="[run-$NOW] GPT-4 is OpenAI's flagship model released in 2023. GPT-4 supports multimodal inputs including images. GPT-4 is available through the OpenAI API and ChatGPT Plus."
stage_text "prime-$NOW" "GPT-4 overview" "$PRIME_BODY" > /dev/null
finalize_session "prime-$NOW" > /dev/null
wait_compile "prime-$NOW" || fail "prime session did not complete"
pass "GPT-4 page primed"

# Three sources each describing a competes_with relationship using the
# variant spelling "gpt 4" — exercises the Rule 4 canonicalize fix.
for i in 1 2 3; do
    sess_var="SESSION_$([ $i -eq 1 ] && echo D || { [ $i -eq 2 ] && echo E || echo F; })"
    sess_val="${!sess_var}"
    body="[run-$NOW-$i] This comparison study shows gpt 4 competes with Claude in the LLM market, and gpt 4 competes with Claude on coding tasks. Source #$i analysing gpt 4 vs Claude head-to-head."
    echo "[C2.$i] stage session for comparison variant source (sess=$sess_val)"
    stage_text "$sess_val" "gpt 4 vs Claude analysis #$i" "$body" > /dev/null
    finalize_session "$sess_val" > /dev/null
    echo "[C3.$i] poll compile"
    wait_compile "$sess_val" || fail "comparison variant session $i did not complete"
done
pass "3 comparison-variant sessions compiled"

echo "[C4] verify relationship_mentions stored under canonical 'GPT-4' (persistence-side from Flag 2 fix)"
bad_rows=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"\"\"
    SELECT COUNT(*) FROM relationship_mentions
     WHERE (from_canonical = 'gpt 4' COLLATE NOCASE OR to_canonical = 'gpt 4' COLLATE NOCASE)
\"\"\").fetchone()
print(row[0])
db.close()
")
if [ "$bad_rows" = "0" ]; then
    pass "no relationship_mentions rows carry raw 'gpt 4' spelling"
else
    fail "$bad_rows relationship_mentions row(s) still under raw 'gpt 4' — Flag 2 normalization helper may not be firing"
fi

echo "[C5] verify exactly one comparison page emerged"
comp_count=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"SELECT COUNT(*) FROM pages WHERE page_type = 'comparison' AND title LIKE '%GPT-4%' COLLATE NOCASE\").fetchone()
print(row[0])
db.close()
")
if [ "$comp_count" = "1" ]; then
    pass "exactly 1 comparison page for GPT-4"
else
    fail "expected 1 comparison page, got $comp_count"
fi

echo "[C6] verify comparison page title uses canonical casing"
comp_title=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"SELECT title FROM pages WHERE page_type = 'comparison' AND title LIKE '%GPT-4%' COLLATE NOCASE LIMIT 1\").fetchone()
print(row[0] if row else '')
db.close()
")
if echo "$comp_title" | grep -qE "^Claude vs GPT-4$|^GPT-4 vs Claude$"; then
    pass "comparison page titled correctly: $comp_title"
else
    fail "comparison page title unexpected: '$comp_title'"
fi

echo
echo "=== All 3 scenarios passed — match-triage + comparison canonicalization verified ==="
