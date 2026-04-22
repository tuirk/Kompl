#!/usr/bin/env bash
#
# Manual split-session verification for Flag 2 — cross-session entity + concept
# canonicalization (commit af83675 + 9042193).
#
# Demonstrates:
#   Session A ingests a source mentioning "GPT-4" → entity page created
#   Session B (fresh session) ingests a source mentioning "GPT 4" (space) →
#     resolver anchors to existing page, plan emits update, commit adds
#     Session B's source as provenance
#
# Runs against a clean Docker stack (volumes wiped by integration-test Stage 0).
# Does NOT wipe volumes itself — re-running over existing data will likely fail
# assertions. `docker compose down -v && docker compose up -d` to reset.
#
# Prereqs:
#   - Docker stack healthy (app on :3000, nlp-service :8000, n8n :5678)
#   - GEMINI_API_KEY available in app container env (not this shell)
#   - entity_promotion_threshold will be set to 1 by this script

set -uo pipefail

# Windows Git Bash compatibility (same pattern as scripts/integration-test.sh):
# `python3` may resolve to a Windows Store redirect stub rather than a real
# interpreter. Fall back to `python` if `python3 --version` doesn't work.
if ! python3 --version 2>&1 | grep -q "Python 3"; then
    python3() { python "$@"; }
    export -f python3
fi

BASE="http://localhost:3000"
NOW=$(date +%s)
SESSION_A="split-A-$NOW"
SESSION_B="split-B-$NOW"
COMPILE_TIMEOUT=300   # seconds per compile

echo "=== Kompl split-session verification ==="
echo "Session A: $SESSION_A"
echo "Session B: $SESSION_B"
echo

pass() { echo "  PASS — $*" ; }
fail() { echo "  FAIL — $*" ; exit 1 ; }

# Run Python inside the app container so we read the real kompl.db on the
# named volume. Returns the script's printed output.
query_db() {
    docker exec komplcore-app-1 python3 -c "$1"
}

# Extract JSON field from a curl response via python.
json_field() {
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$1', ''))"
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

# ─── Step 1: set threshold=1 ────────────────────────────────────────────────
echo "[1] set entity_promotion_threshold=1"
resp=$(curl -sf -X POST "$BASE/api/settings" \
    -H 'Content-Type: application/json' \
    -d '{"entity_promotion_threshold":1}')
if [ -n "$resp" ]; then pass "settings updated"; else fail "settings POST returned empty"; fi

# ─── Step 2: stage session A ────────────────────────────────────────────────
echo "[2] stage session A with GPT-4 content"
# Salt with $NOW so SHA-256 content-hash dedup (findSourceByContentHash in
# ingest-texts.ts) doesn't skip source creation on re-runs.
A_BODY="[run-$NOW] GPT-4 is OpenAI's flagship large language model released in 2023. GPT-4 outperforms GPT-3.5 on reasoning benchmarks. GPT-4 supports multimodal input including images. GPT-4 is available via the OpenAI API and ChatGPT Plus. Developers use GPT-4 for coding, analysis, and creative tasks."
export SESSION_A A_BODY
stage_payload_a=$(python3 -c "
import json, os
print(json.dumps({
    'session_id': os.environ['SESSION_A'],
    'connector': 'text',
    'items': [{
        'markdown': os.environ['A_BODY'],
        'title_hint': 'GPT-4 Technical Overview',
        'source_type_hint': 'note',
    }]
}))
")
stage_resp=$(curl -s -X POST "$BASE/api/onboarding/stage" \
    -H 'Content-Type: application/json' \
    -d "$stage_payload_a")
stage_ids=$(echo "$stage_resp" | python3 -c "import sys,json; d=json.loads(sys.stdin.read() or '{}'); print(','.join(d.get('stage_ids',[])))")
if [ -n "$stage_ids" ]; then pass "staged ($stage_ids)"; else fail "stage returned no ids — resp=$stage_resp"; fi

# ─── Step 3: finalize session A ─────────────────────────────────────────────
echo "[3] finalize session A"
fin_resp=$(curl -sf --max-time 15 -X POST "$BASE/api/onboarding/finalize" \
    -H 'Content-Type: application/json' \
    -d "{\"session_id\":\"$SESSION_A\"}")
queued=$(echo "$fin_resp" | json_field queued)
if [ "$queued" = "1" ]; then pass "queued=1"; else echo "  NOTE: queued=$queued (may already be running)"; fi

# ─── Step 4: wait for session A compile ─────────────────────────────────────
echo "[4] poll session A compile until completed (max ${COMPILE_TIMEOUT}s)"
if ! wait_compile "$SESSION_A"; then
    echo "  logs:"
    docker logs komplcore-app-1 2>&1 | tail -20
    fail "session A did not complete"
fi
pass "session A compile completed"

# ─── Step 5: assert exactly one GPT-4 page exists ───────────────────────────
echo "[5] verify GPT-4 page exists"
gpt4_count=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"SELECT COUNT(*) FROM pages WHERE title = 'GPT-4' COLLATE NOCASE AND page_type = 'entity'\").fetchone()
print(row[0])
db.close()
")
if [ "$gpt4_count" = "1" ]; then pass "1 GPT-4 entity page"; else fail "expected 1 page, got $gpt4_count"; fi

gpt4_page_id=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"SELECT page_id FROM pages WHERE title = 'GPT-4' COLLATE NOCASE AND page_type = 'entity'\").fetchone()
print(row[0] if row else '')
db.close()
")
echo "    page_id=$gpt4_page_id"

# ─── Step 6: stage session B ────────────────────────────────────────────────
echo "[6] stage session B with GPT 4 content"
B_BODY="[run-$NOW] GPT 4 has become the default choice for coding agents. GPT 4 excels at tool use workflows. Developers pair GPT 4 with vector databases for RAG systems. GPT 4 context length is 128k tokens in the turbo variant. Many engineers prefer GPT 4 over other models for complex reasoning."
export SESSION_B B_BODY
stage_payload_b=$(python3 -c "
import json, os
print(json.dumps({
    'session_id': os.environ['SESSION_B'],
    'connector': 'text',
    'items': [{
        'markdown': os.environ['B_BODY'],
        'title_hint': 'Working With GPT 4',
        'source_type_hint': 'note',
    }]
}))
")
stage_resp_b=$(curl -s -X POST "$BASE/api/onboarding/stage" \
    -H 'Content-Type: application/json' \
    -d "$stage_payload_b")
stage_ids_b=$(echo "$stage_resp_b" | python3 -c "import sys,json; d=json.loads(sys.stdin.read() or '{}'); print(','.join(d.get('stage_ids',[])))")
if [ -n "$stage_ids_b" ]; then pass "staged ($stage_ids_b)"; else fail "stage B returned no ids — resp=$stage_resp_b"; fi

# ─── Step 7: finalize session B ─────────────────────────────────────────────
echo "[7] finalize session B"
fin_resp_b=$(curl -sf --max-time 15 -X POST "$BASE/api/onboarding/finalize" \
    -H 'Content-Type: application/json' \
    -d "{\"session_id\":\"$SESSION_B\"}")
queued_b=$(echo "$fin_resp_b" | json_field queued)
if [ "$queued_b" = "1" ]; then pass "queued=1"; else echo "  NOTE: queued=$queued_b"; fi

# ─── Step 8: wait for session B compile ─────────────────────────────────────
echo "[8] poll session B compile until completed (max ${COMPILE_TIMEOUT}s)"
if ! wait_compile "$SESSION_B"; then
    echo "  logs:"
    docker logs komplcore-app-1 2>&1 | tail -20
    fail "session B did not complete"
fi
pass "session B compile completed"

# ─── Step 9: no duplicate page ──────────────────────────────────────────────
echo "[9] verify NO duplicate page was created"
dup_count=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"SELECT COUNT(*) FROM pages WHERE page_type = 'entity' AND title IN ('GPT-4', 'GPT 4', 'gpt-4', 'gpt 4') COLLATE NOCASE\").fetchone()
print(row[0])
db.close()
")
if [ "$dup_count" = "1" ]; then
    pass "single entity page for GPT-4 family (no duplicate)"
else
    titles=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
for row in db.execute(\"SELECT title FROM pages WHERE page_type = 'entity' AND title IN ('GPT-4', 'GPT 4', 'gpt-4', 'gpt 4') COLLATE NOCASE\"):
    print(row[0])
db.close()
")
    fail "expected 1 entity page, got $dup_count. Titles: $titles"
fi

# ─── Step 10: alias row written + pinned ────────────────────────────────────
echo "[10] verify alias row {alias: 'GPT 4', canonical_name: 'GPT-4', canonical_page_id pinned}"
alias_info=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"\"\"
    SELECT canonical_name, canonical_page_id
      FROM aliases
     WHERE alias = 'GPT 4' COLLATE NOCASE
     LIMIT 1
\"\"\").fetchone()
if row:
    print(f'{row[0]}|{row[1]}')
else:
    print('MISSING|')
db.close()
")
IFS='|' read -r alias_canonical alias_page_id <<< "$alias_info"
if [ "$alias_canonical" = "GPT-4" ] && [ -n "$alias_page_id" ] && [ "$alias_page_id" != "None" ]; then
    pass "alias row OK (canonical=$alias_canonical, page_id=$alias_page_id)"
else
    fail "alias row wrong (canonical=$alias_canonical, page_id=$alias_page_id)"
fi

# ─── Step 11: entity_mentions re-canonicalized ──────────────────────────────
echo "[11] verify entity_mentions for session B's source is under canonical 'GPT-4'"
b_source=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"SELECT source_id FROM sources WHERE onboarding_session_id = '$SESSION_B' LIMIT 1\").fetchone()
print(row[0] if row else '')
db.close()
")
if [ -z "$b_source" ]; then fail "could not find session B source"; fi
echo "    session B source_id=$b_source"

mention_canonical=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
rows = db.execute(\"SELECT canonical_name FROM entity_mentions WHERE source_id = '$b_source'\").fetchall()
print('|'.join(r[0] for r in rows))
db.close()
")
echo "    mentions for B: $mention_canonical"
if echo "$mention_canonical" | grep -q "GPT-4"; then
    if echo "$mention_canonical" | grep -q "GPT 4"; then
        fail "entity_mentions still has 'GPT 4' row for session B — normalization didn't fire"
    else
        pass "entity_mentions re-canonicalized to 'GPT-4' (normalization helper worked)"
    fi
else
    fail "entity_mentions has neither 'GPT-4' nor 'GPT 4' for session B — something else went wrong"
fi

# ─── Step 12: both sources in provenance ────────────────────────────────────
echo "[12] verify provenance has both sessions' sources for the GPT-4 page"
prov_count=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"SELECT COUNT(DISTINCT source_id) FROM provenance WHERE page_id = '$gpt4_page_id'\").fetchone()
print(row[0])
db.close()
")
if [ "$prov_count" -ge "2" ]; then
    pass "provenance has $prov_count distinct source_ids (session A + B both present)"
else
    fail "provenance has only $prov_count source_ids (expected ≥ 2)"
fi

echo
echo "=== All 12 assertions passed — split-session canonicalization verified ==="
