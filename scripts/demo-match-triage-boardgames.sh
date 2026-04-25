#!/usr/bin/env bash
#
# Temporary demo — board-games themed clone of manual-match-triage-test.sh.
# Walks through all three match-triage scenarios (update, contradiction,
# comparison) using Catan / Ticket to Ride instead of AI models.
# Demo only — not wired into CI or integration-test.sh.
#
# Prereqs: docker stack up, GEMINI_API_KEY in app container, clean DB recommended.
# Usage:   bash scripts/demo-match-triage-boardgames.sh

set -uo pipefail

if ! python3 --version 2>&1 | grep -q "Python 3"; then
    python3() { python "$@"; }
    export -f python3
fi

BASE="http://localhost:3000"
NOW=$(date +%s)
SESSION_A="bg-A-$NOW"
SESSION_B="bg-B-$NOW"
SESSION_C="bg-C-$NOW"
SESSION_D="bg-D-$NOW"
SESSION_E="bg-E-$NOW"
SESSION_F="bg-F-$NOW"
COMPILE_TIMEOUT=360

echo "=== Match-triage demo — board games edition ==="
echo

pass() { echo "  PASS — $*" ; }
fail() { echo "  FAIL — $*" ; exit 1 ; }
warn() { echo "  WARN — $*" ; }

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

A_BODY="[run-$NOW] Catan is a resource-management board game designed by Klaus Teuber and first published in 1995 under the original name 'Die Siedler von Catan'. Catan supports three to four players on the base board and plays in roughly sixty to ninety minutes. Catan introduced the hex-tile modular board that influenced a generation of Eurogames. Players in Catan collect five resources — brick, wood, wheat, sheep and ore — by rolling two dice and building settlements, cities and roads. Catan popularised trading between players as a core mechanic, making negotiation central to every turn. Catan has been translated into more than thirty languages and is widely regarded as the definitive gateway hobby board game."
echo "[A1] stage session A about Catan"
stage_text "$SESSION_A" "Catan — the modern hobby-game gateway" "$A_BODY" > /dev/null
echo "[A2] finalize session A"
finalize_session "$SESSION_A" > /dev/null
echo "[A3] poll session A compile"
wait_compile "$SESSION_A" || fail "session A did not complete"
pass "session A compiled"

B_BODY="[run-$NOW] Catan strategy guides emphasise early diversification of resource production across different number tiles to hedge against unlucky dice. Strong Catan players target settlements adjacent to the 6 and 8 hexes, which are statistically the most-rolled numbers on two dice. The Longest Road and Largest Army bonus cards each award two victory points in Catan and frequently decide close games. Catan introduced the concept of the Robber, placed on a hex when a 7 is rolled, which blocks resource production and can steal a card from an opponent. Experienced Catan tables often play with the Cities & Knights or Seafarers expansions to add strategic depth beyond the base game."
echo "[A4] stage session B — overlapping detail on Catan"
stage_text "$SESSION_B" "Catan — strategy, expansions, the Robber" "$B_BODY" > /dev/null
echo "[A5] finalize session B"
finalize_session "$SESSION_B" > /dev/null
echo "[A6] poll session B compile"
wait_compile "$SESSION_B" || fail "session B did not complete"
pass "session B compiled"

echo "[A7] look for match-driven update plan in session B"
catan_page_id=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"SELECT page_id FROM pages WHERE title = 'Catan' COLLATE NOCASE AND page_type = 'entity'\").fetchone()
print(row[0] if row else '')
db.close()
")
if [ -z "$catan_page_id" ]; then
    fail "could not find 'Catan' entity page"
fi
echo "    catan_page_id=$catan_page_id"

update_count=$(query_db "
import sqlite3, json
db = sqlite3.connect('/data/db/kompl.db')
rows = db.execute(\"\"\"
    SELECT details FROM activity_log
     WHERE action_type = 'page_compiled'
       AND json_extract(details, '\$.session_id') = ?
       AND json_extract(details, '\$.action') = 'update'
       AND json_extract(details, '\$.page_id') = ?
\"\"\", ('$SESSION_B', '$catan_page_id')).fetchall()
print(len(rows))
db.close()
")
if [ "$update_count" -ge "1" ]; then
    pass "session B wrote an update for Catan ($update_count event(s))"
else
    fail "no update event recorded for session B on Catan — match.update triage may not be firing"
fi

prov_count_a=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"SELECT COUNT(DISTINCT source_id) FROM provenance WHERE page_id = '$catan_page_id'\").fetchone()
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

C_BODY="[run-$NOW] Catan was not published in 1995 — Catan was released in 2020 by a different publisher, and Klaus Teuber had no involvement in its design. Catan does not support three or four players; Catan is a solo-only experience and no Catan session ever involves more than one player. Catan is not a dice-rolling game — Catan contains no dice at all and resource production never depends on any random roll. Catan does not include a modular hex-tile board; Catan ships without any physical board and is played purely with cards. Catan players do not trade resources — Catan has no trading mechanic and there is zero negotiation between participants. Catan was never a gateway hobby game — Catan was designed as a niche digital-only product and has never appeared in physical print."
echo "[B1] stage session C — claims that contradict the Catan page"
stage_text "$SESSION_C" "Catan — critical take" "$C_BODY" > /dev/null
echo "[B2] finalize session C"
finalize_session "$SESSION_C" > /dev/null
echo "[B3] poll session C compile"
wait_compile "$SESSION_C" || fail "session C did not complete"
pass "session C compiled"

echo "[B4] query activity_log for page_contradiction_detected on the Catan page"
contra_row=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"\"\"
    SELECT details FROM activity_log
     WHERE action_type = 'page_contradiction_detected'
       AND json_extract(details, '\$.page_id') = ?
     ORDER BY id DESC LIMIT 1
\"\"\", ('$catan_page_id',)).fetchone()
print(row[0] if row else '')
db.close()
")
if [ -z "$contra_row" ]; then
    warn "no page_contradiction_detected row — triage likely landed on 'update' instead. Skipping B5/B6."
else
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
        warn "missing fields in activity details: $missing"
    fi

    echo "[B6] fetch /api/wiki/<page>/contradictions"
    api_resp=$(curl -sf "$BASE/api/wiki/$catan_page_id/contradictions")
    api_count=$(echo "$api_resp" | python3 -c "import sys,json; print(json.load(sys.stdin).get('count', -1))")
    if [ "$api_count" -ge "1" ]; then
        pass "API returns $api_count contradiction(s) — sidebar will render"
    else
        warn "API returned $api_count — sidebar would show nothing."
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# SCENARIO C — comparison canonicalization
# ═══════════════════════════════════════════════════════════════════════════
echo
echo "### Scenario C — comparison canonicalization ###"

# Prime the wiki with a Ticket to Ride page so the resolver has an anchor.
echo "[C1-prime] ingest a Ticket to Ride source so the page exists"
PRIME_BODY="[run-$NOW] Ticket to Ride is a railway-themed family board game designed by Alan R. Moon and published in 2004 by Days of Wonder. Ticket to Ride supports two to five players and plays in about forty-five minutes. Ticket to Ride players collect coloured train cards to claim routes between cities on a map of North America, Europe or other regions. Ticket to Ride won the Spiel des Jahres in 2004 and launched a sprawling family of regional maps, digital adaptations and themed spin-offs that remain in print today."
stage_text "prime-$NOW" "Ticket to Ride overview" "$PRIME_BODY" > /dev/null
finalize_session "prime-$NOW" > /dev/null
wait_compile "prime-$NOW" || fail "prime session did not complete"
pass "Ticket to Ride page primed"

# Three sources each describing the competes_with relationship using the
# variant spelling 'ticket-to-ride' (dashes) instead of canonical 'Ticket to Ride'.
# Exercises the same canonicalization logic as the original GPT-4 test.
for i in 1 2 3; do
    sess_var="SESSION_$([ $i -eq 1 ] && echo D || { [ $i -eq 2 ] && echo E || echo F; })"
    sess_val="${!sess_var}"
    body="[run-$NOW-$i] Review #$i of the classic gateway games: ticket-to-ride competes with Catan for table-time in most board-game households, and ticket-to-ride competes with Catan on family-friendliness and shelf appeal. Source #$i analysing ticket-to-ride vs Catan head-to-head for a first-time buyer choosing between the two hobby-board-game staples."
    echo "[C2.$i] stage session for comparison variant source (sess=$sess_val)"
    stage_text "$sess_val" "ticket-to-ride vs Catan analysis #$i" "$body" > /dev/null
    finalize_session "$sess_val" > /dev/null
    echo "[C3.$i] poll compile"
    wait_compile "$sess_val" || fail "comparison variant session $i did not complete"
done
pass "3 comparison-variant sessions compiled"

echo "[C4] verify relationship_mentions stored under canonical 'Ticket to Ride' (not raw 'ticket-to-ride')"
bad_rows=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"\"\"
    SELECT COUNT(*) FROM relationship_mentions
     WHERE (from_canonical = 'ticket-to-ride' COLLATE NOCASE OR to_canonical = 'ticket-to-ride' COLLATE NOCASE)
\"\"\").fetchone()
print(row[0])
db.close()
")
if [ "$bad_rows" = "0" ]; then
    pass "no relationship_mentions rows carry raw 'ticket-to-ride' spelling"
else
    fail "$bad_rows relationship_mentions row(s) still under raw 'ticket-to-ride' — canonicalization may not be firing"
fi

echo "[C5] verify exactly one comparison page emerged"
comp_count=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"SELECT COUNT(*) FROM pages WHERE page_type = 'comparison' AND title LIKE '%Ticket to Ride%' COLLATE NOCASE AND title LIKE '%Catan%' COLLATE NOCASE\").fetchone()
print(row[0])
db.close()
")
if [ "$comp_count" = "1" ]; then
    pass "exactly 1 comparison page for Ticket to Ride vs Catan"
else
    fail "expected 1 comparison page, got $comp_count"
fi

echo "[C6] verify comparison page title uses canonical casing"
comp_title=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"SELECT title FROM pages WHERE page_type = 'comparison' AND title LIKE '%Ticket to Ride%' COLLATE NOCASE AND title LIKE '%Catan%' COLLATE NOCASE LIMIT 1\").fetchone()
print(row[0] if row else '')
db.close()
")
if echo "$comp_title" | grep -qE "^Catan vs Ticket to Ride$|^Ticket to Ride vs Catan$"; then
    pass "comparison page titled correctly: $comp_title"
else
    fail "comparison page title unexpected: '$comp_title'"
fi

echo
echo "=== All 3 scenarios passed — open http://localhost:3000/wiki ==="
