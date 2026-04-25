#!/usr/bin/env bash
#
# Live-demo script — three strictly-sequential phases that grow the wiki.
# Phase 1 (4 sources): baseline across AI, Lithuania, boardgames domains.
# Phase 2 (8 sources): match.update + match.contradiction fire; more relationships seeded.
# Phase 3 (6 sources): comparison pages emerge (Vilnius vs Kaunas, Claude vs GPT-4, Catan vs Ticket to Ride).
#
# Sources: synthesized in the voice of Karpathy, Simon Willison, Balaji, plus vibe-coding and
# boardgame text bodies, plus Lithuania travel excerpts. Pure text connector — no file ingestion,
# no URLs. Demo-only.
#
# Usage:
#   bash scripts/demo-live-phases.sh phase1
#   bash scripts/demo-live-phases.sh phase2
#   bash scripts/demo-live-phases.sh phase3
#   bash scripts/demo-live-phases.sh all       # runs 1 → 2 → 3
#
# Prereqs: docker stack up, GEMINI_API_KEY in app, clean DB for best demo effect.
# Strictly sequential: phase 2 and phase 3 assume phase 1 has already run.

set -uo pipefail

if ! python3 --version 2>&1 | grep -q "Python 3"; then
    python3() { python "$@"; }
    export -f python3
fi

BASE="http://localhost:3000"
COMPILE_TIMEOUT=600

pass() { echo "  PASS — $*" ; }
warn() { echo "  WARN — $*" ; }
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

# ── Batch staging helpers ──────────────────────────────────────────────────
# Accumulate titles + bodies, then POST once to /api/onboarding/stage with items[].
BATCH_TITLES=()
BATCH_BODIES=()
batch_reset() { BATCH_TITLES=(); BATCH_BODIES=(); }
batch_add()   { BATCH_TITLES+=("$1"); BATCH_BODIES+=("$2"); }

batch_stage() {
    local session="$1"
    export STG_SESSION="$session"
    export STG_COUNT="${#BATCH_TITLES[@]}"
    local i
    for i in "${!BATCH_TITLES[@]}"; do
        local idx=$((i+1))
        export "STG_TITLE_$idx=${BATCH_TITLES[$i]}"
        export "STG_BODY_$idx=${BATCH_BODIES[$i]}"
    done
    local payload
    payload=$(python3 -c "
import json, os
count = int(os.environ['STG_COUNT'])
items = []
for i in range(1, count + 1):
    items.append({
        'markdown': os.environ[f'STG_BODY_{i}'],
        'title_hint': os.environ[f'STG_TITLE_{i}'],
        'source_type_hint': 'note',
    })
print(json.dumps({
    'session_id': os.environ['STG_SESSION'],
    'connector': 'text',
    'items': items,
}))
")
    curl -s -X POST "$BASE/api/onboarding/stage" \
        -H 'Content-Type: application/json' \
        -d "$payload" > /dev/null
}

finalize_session() {
    curl -s --max-time 15 -X POST "$BASE/api/onboarding/finalize" \
        -H 'Content-Type: application/json' \
        -d "{\"session_id\":\"$1\"}" > /dev/null
}

set_threshold() {
    curl -s -X POST "$BASE/api/settings" \
        -H 'Content-Type: application/json' \
        -d '{"entity_promotion_threshold":2}' > /dev/null
}

# ── Summary helper — called at the end of each phase ───────────────────────
phase_summary() {
    local phase_label="$1"
    echo
    echo "=== $phase_label summary ==="
    query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
counts = {}
for pt, in db.execute(\"SELECT page_type FROM pages\").fetchall():
    counts[pt] = counts.get(pt, 0) + 1
total = sum(counts.values())
print(f'Total pages: {total}')
for pt, n in sorted(counts.items()):
    print(f'  {pt}: {n}')

print()
print('Entity + comparison pages:')
rows = db.execute(\"SELECT page_type, title FROM pages WHERE page_type IN ('entity','comparison') ORDER BY page_type, title\").fetchall()
for pt, t in rows:
    print(f'  [{pt}] {t}')

print()
print('Recent activity (last 10):')
rows = db.execute(\"SELECT action_type, json_extract(details, '\$.page_title') FROM activity_log ORDER BY id DESC LIMIT 10\").fetchall()
for at, pt in rows:
    print(f'  {at}  page_title={pt}')
db.close()
"
}

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 1 — baseline (4 sources)
# ═══════════════════════════════════════════════════════════════════════════
phase1() {
    local NOW SESSION
    NOW=$(date +%s)
    SESSION="demo-p1-$NOW"

    echo "=== Phase 1 — baseline corpus (4 sources) ==="
    echo "[preflight] entity_promotion_threshold=2"
    set_threshold
    pass "settings ready"

    batch_reset
    batch_add "The Ultimate Travel Guide to Vilnius Lithuania" \
"[run-$NOW] Vilnius is the capital of Lithuania and one of the most popular, widely well-known tourist destinations in Europe. Vilnius attracts millions of international visitors every year and has built a strong reputation as a must-see European capital on standard bucket lists. The Vilnius old city is on the UNESCO World Heritage Journeys list, and the capital was named the greenest capital in Europe with 46 percent of Vilnius covered by green space. Vilnius is also recognised as the third greenest capital in the world. Key sights include the Vilnius Cathedral and Bell Tower on Cathedral Square, the Gediminas Castle Tower with its panoramic observation deck, Gediminas Avenue for dining and parks, the Lithuanian National Drama Theater, the Palace of the Grand Dukes, and the Three Muses Sculpture. The city has chain supermarkets like IKI, Maxima and Rimi, and affordable accommodation at places like Vivulskio Hotel and Downtown Forest Hostel. Winters in Vilnius can hit minus 20 degrees, so layered clothing is essential."

    batch_add "Software 3.0 — thinking about LLM-native development — A. Karpathy" \
"[run-$NOW] Software 1.0 is hand-written code that compiles deterministically. Software 2.0 is trained neural-network weights that learn from data. Software 3.0 is prompt-driven LLM orchestration where the model itself is the interpreter. In a Software 3.0 world, Claude and GPT-4 are not just APIs — they are a new class of general-purpose computer. Building on top of LLMs means treating English as a programming language and treating context windows as memory. Vibe coding, a term increasingly used by practitioners, describes the new loop where you describe intent to an LLM, accept most of what it writes, and iterate through feel rather than type-check. The economics are shifting too: tokens replace CPU cycles and cost-per-task becomes the primary engineering metric. Claude competes with GPT-4 for developer mindshare in exactly this frame. The LLM itself is now part of the runtime."

    batch_add "LLMs as tools-with-opinions — Simon Willison on the Claude + GPT-4 era" \
"[run-$NOW] LLMs are not just text predictors — LLMs are tools with opinions, and treating them that way changes how useful they become. Claude and GPT-4 represent two distinct design philosophies: Claude, from Anthropic, leans into constitutional training and long-context reasoning; GPT-4, from OpenAI, leads on tool-use integration and ecosystem reach. Both Claude and GPT-4 now support structured output, function calling, and vision, but the prompt patterns that work best differ. LLMs reward specific system prompts, concrete examples, and well-scoped inputs. A useful mental model is that LLMs are collaborators, not oracles — you prompt, they draft, you revise, they explain. When comparing Claude vs GPT-4 for tool-heavy pipelines, the question is rarely raw capability but which model plays nicer with your orchestration framework."

    batch_add "Catan — the modern hobby-game gateway" \
"[run-$NOW] Catan is a resource-management board game designed by Klaus Teuber and first published in 1995 under the original name Die Siedler von Catan. Catan supports three to four players on the base board and plays in roughly sixty to ninety minutes. Catan introduced the hex-tile modular board that influenced a generation of Eurogames. Players in Catan collect five resources — brick, wood, wheat, sheep and ore — by rolling two dice and building settlements, cities and roads. Catan popularised trading between players as a core mechanic, making negotiation central to every turn. Catan has been translated into more than thirty languages and is widely regarded as the definitive gateway hobby board game, opening the door for titles like Ticket to Ride, Carcassonne, and Pandemic."

    echo "[p1.stage] staging 4 sources into session=$SESSION"
    batch_stage "$SESSION"
    echo "[p1.finalize]"
    finalize_session "$SESSION"
    echo "[p1.compile]"
    if wait_compile "$SESSION"; then
        pass "phase 1 compile completed"
    else
        fail "phase 1 compile did not finish"
    fi
    phase_summary "Phase 1"
    echo
    echo "→ Open http://localhost:3000/wiki to see the baseline corpus."
}

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 2 — updates + contradiction + more relationships (8 sources)
# ═══════════════════════════════════════════════════════════════════════════
phase2() {
    local NOW SESSION
    NOW=$(date +%s)
    SESSION="demo-p2-$NOW"

    echo "=== Phase 2 — updates, contradiction, comparison seeds (8 sources) ==="
    echo "[preflight] entity_promotion_threshold=2"
    set_threshold
    pass "settings ready"

    batch_reset

    # Overlaps with phase 1 Vilnius guide → match.update
    batch_add "30+ Places You Should See in Vilnius" \
"[run-$NOW] Vilnius has become a really popular tourist hub in recent years — the greenest capital in Europe and the third greenest capital in the world. Vilnius's old city is on the UNESCO World Heritage list. Among the thirty-plus must-see places are the Vilnius Cathedral and Bell Tower on Cathedral Square with its famous Miracle Tile, the Gediminas Castle Tower on a hill accessible by funicular, Gediminas Avenue with its shops and cafes including the Vincas Kudirka Square and the Lucky Belly sculpture, the Lithuanian National Drama Theater with its Three Muses Sculpture, the Palace of the Grand Dukes of Lithuania, and the Monument to Grand Duke Gediminas. Vilnius packs castles, museums, parks and alternative galleries into a compact walkable centre."

    # Contradiction — directly refutes the phase 1 "popular, widely well-known" framing
    batch_add "Why Vilnius is the G-spot of Europe — the vilniusgspot.com story" \
"[run-$NOW] Vilnius is NOT a popular tourist destination — most of the world has no idea where Vilnius is, and the claim that Vilnius is a widely well-known European city is simply incorrect. Despite being a thousand-year-old UNESCO-listed city, Vilnius remains largely unknown outside a tight ring of Baltic-adjacent countries. Lithuania's tourism agency has openly admitted this: in 2018 the Go Vilnius tourism board launched the self-aware vilniusgspot.com campaign, built around the premise that Vilnius is the G-spot of Europe — nobody knows where it is, but when you find it, it is amazing. The vilniusgspot.com campaign was a deliberate, humorous admission that Vilnius is not a famous city. The campaign stickers spread across European capitals as guerrilla marketing and went viral precisely because they lean into how unheard-of Vilnius actually is. There is also a dedicated joke domain at whereisvilnius.com built around the same premise. Search volumes, travel-agency bookings, and bucket-list surveys all confirm: Vilnius is NOT widely well-known, and Vilnius is NOT a popular tourist hub. The image of Vilnius as a heavily-visited European capital is marketing aspiration rather than reality. The vilniusgspot.com campaign remains one of the most-awarded European city-branding efforts of the 2010s precisely because it leaned into the city's obscurity."

    # Overlaps with phase 1 Karpathy → match.update
    batch_add "More on Software 3.0 — agents, context, and the browser moment — A. Karpathy" \
"[run-$NOW] Software 3.0 is still the useful frame: Claude and GPT-4 as general-purpose interpreters that take natural language as input and return structured behaviour. The agent loop — plan, act, observe, repeat — is the new outer control flow, and LLMs are the inner compute. Context windows are the new memory hierarchy: attention over 200k tokens is to Software 3.0 what RAM was to Software 1.0. Vibe coding is not a dismissive term — vibe coding is a working methodology where you trust the LLM for syntax and spend your cognitive budget on intent, architecture, and verification. The open question for the next phase is which of Claude or GPT-4 wins the agent-native tooling race, and whether an open-weight model catches up in time to commoditise the tier."

    # Crypto introduction — new domain, adds Bitcoin/Ethereum entities
    batch_add "The Network State and the case for Bitcoin — Balaji" \
"[run-$NOW] The Network State is a thesis: online communities with shared values, capital, and coordination tools will precede physical sovereignty. Bitcoin is the monetary layer that makes this possible — Bitcoin is digital gold, censorship-resistant, and independent of any legacy nation-state's currency. Ethereum plays a different role in this stack: Ethereum is the programmable layer, the settlement layer for stablecoins, tokenised assets, and decentralised applications. Bitcoin is the store of value; Ethereum is the computation layer. The network state needs both. Unlike legacy fiat, Bitcoin enforces its monetary policy in code: 21 million supply cap, halving every four years, proof-of-work settlement. Ethereum, by contrast, evolved through planned upgrades including the 2022 Merge to proof-of-stake. Between Bitcoin and Ethereum, the network-state thesis treats them as complementary rather than substitutes."

    # Vibe coding — AI overlap
    batch_add "Vibe coding in practice — building with Claude every day" \
"[run-$NOW] Vibe coding is what a lot of developers are actually doing now, whether they name it or not. The loop is: open Claude, describe the change you want, read the diff, accept or refine. You don't type the code; you curate it. This works remarkably well for prototypes, for glue code, for data-pipeline scripts — anywhere the cost of verification is low. Vibe coding works less well for tight-loop performance code, cryptography, or schema migrations, where you still need to understand every line. The skill being exercised in vibe coding is not typing speed but taste: knowing which outputs are good, which are subtly wrong, which to ship, which to throw away. Claude is currently the preferred tool for vibe coders because it refuses less and explains more; GPT-4 competes on integration surface and latency."

    # Simon Willison #2 — includes Claude vs GPT-4 comparison mention
    batch_add "Daily LLM workflow — Simon Willison on Claude vs GPT-4 in production" \
"[run-$NOW] My daily workflow now includes Claude or GPT-4 at several stops: drafting a design note, summarising a long PDF, writing a disposable Python script, translating an error message into a next step. LLMs work best when used as spec-followers rather than oracles. For longer-running tasks I still prefer Claude — 200k context and strong instruction-following at depth means I can paste an entire codebase chunk and ask for a refactor. GPT-4 shines on latency-sensitive autocomplete and inside IDE integrations where its plugin ecosystem has a head start. When comparing Claude vs GPT-4 for production pipelines the real question is less raw quality and more which tool API your orchestration layer already speaks — Claude competes with GPT-4 squarely on that axis."

    # Boardgames comparison seed #1
    batch_add "Gateway games head-to-head: ticket-to-ride competes with Catan" \
"[run-$NOW] For anyone buying their first hobby board game, the real decision is often between two titles: ticket-to-ride competes with Catan for the gateway slot in every board game shop. Both Catan and ticket-to-ride target three-to-five-player family audiences and play in about an hour. Catan leans into negotiation and resource trading while ticket-to-ride focuses on route planning and set collection. ticket-to-ride competes with Catan on shelf appeal, Spiel des Jahres credibility (ticket-to-ride won in 2004, Catan in 1995), and longevity — both games continue to dominate year-over-year hobby sales decades after release."

    # Boardgames comparison seed #2
    batch_add "Why ticket-to-ride competes with Catan in European markets" \
"[run-$NOW] In European retail data, ticket-to-ride competes with Catan for top-ten placement every holiday season. Both games share the gateway positioning — approachable to newcomers, deep enough for hobbyists. Catan's hex-tile board and dice rolling give ticket-to-ride a clear point of differentiation: ticket-to-ride uses a fixed city map and colour-matched train cards, removing dice variance entirely. ticket-to-ride competes with Catan not only on direct replacement but on the 'which do I teach my family' question. A review of 500 hobby-game group surveys found that ticket-to-ride competes with Catan most directly among first-time buyers with children, while Catan retains an edge with negotiation-heavy adult groups."

    echo "[p2.stage] staging 8 sources into session=$SESSION"
    batch_stage "$SESSION"
    echo "[p2.finalize]"
    finalize_session "$SESSION"
    echo "[p2.compile]"
    if wait_compile "$SESSION"; then
        pass "phase 2 compile completed"
    else
        fail "phase 2 compile did not finish"
    fi

    # Quick sanity checks — non-fatal
    local vilnius_id
    vilnius_id=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"SELECT page_id FROM pages WHERE title LIKE 'Vilnius%' COLLATE NOCASE AND page_type='entity' LIMIT 1\").fetchone()
print(row[0] if row else '')
db.close()
")
    if [ -n "$vilnius_id" ]; then
        local contra_count
        contra_count=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute(\"SELECT COUNT(*) FROM activity_log WHERE action_type='page_contradiction_detected' AND json_extract(details,'\$.page_id')=?\", ('$vilnius_id',)).fetchone()
print(row[0])
db.close()
")
        if [ "$contra_count" -ge "1" ]; then
            pass "Vilnius page has $contra_count contradiction event(s) — sidebar will render"
        else
            warn "no contradiction event on Vilnius page (triage landed on 'update' instead — still demo-worthy)"
        fi
    else
        warn "no Vilnius entity page found — phase 1 may not have run"
    fi

    phase_summary "Phase 2"
    echo
    echo "→ Refresh http://localhost:3000/wiki — see update events + contradiction sidebar."
}

# ═══════════════════════════════════════════════════════════════════════════
# PHASE 3 — comparison pages emerge (6 sources)
# ═══════════════════════════════════════════════════════════════════════════
phase3() {
    local NOW SESSION
    NOW=$(date +%s)
    SESSION="demo-p3-$NOW"

    echo "=== Phase 3 — comparison pages emerge (6 sources) ==="
    echo "[preflight] entity_promotion_threshold=2"
    set_threshold
    pass "settings ready"

    batch_reset

    batch_add "Museums of Kaunas" \
"[run-$NOW] Kaunas is an amazing city. Kaunas is not as big as Vilnius, but Kaunas has as much to offer as the Lithuanian capital. Kaunas boasts more than twenty museums, churches, and other symbols such as murals, statues, and art pieces. Key highlights in Kaunas include the St. Michael the Archangel's Church (Soboras) at the entrance of Laisves Aleja, the Vytautas the Great War Museum with its Unity Square and Tomb of the Unknown Soldier, the Kaunas City Museum located inside the Kaunas City Hall at Rotušės aikštė, the Ninth Fort and Fortress of Kaunas, the Mikalojus Konstantinas Čiurlionis National Museum of Art, the Devils' Museum, the House of Perkūnas, the Kaunas St. Peter and Paul Cathedral Basilica, and the Lithuanian House of Basketball."

    batch_add "Vilnius vs Kaunas — two Lithuanian cities, two personalities" \
"[run-$NOW] Vilnius competes with Kaunas for visitors every summer. Vilnius is Lithuania's capital and its most-visited city; Kaunas is the second-largest and holds a special interwar-modernist architectural status. Vilnius competes with Kaunas on old-town charm — both have historic centres, though Vilnius's old town is on the UNESCO World Heritage list. Kaunas competes with Vilnius on museum density, with more than twenty museums in a more walkable centre. Vilnius competes with Kaunas also on food and cafe culture, both cities offering affordable Lithuanian cuisine in restored historic buildings. For travellers, Vilnius competes with Kaunas as the headline destination while Kaunas competes with Vilnius as the quieter, cheaper alternative."

    batch_add "Vilnius vs Kaunas — planning a Lithuania trip" \
"[run-$NOW] For first-time visitors to Lithuania the question is simple: Vilnius competes with Kaunas as the primary base for a week-long trip. Vilnius competes with Kaunas on flight connectivity (Vilnius has the bigger airport) and on accommodation breadth (more hostels, hotels, and short-term rentals). Kaunas competes with Vilnius on lower prices, on proximity to the Ninth Fort historical site, and on the density of Čiurlionis-era national art. Vilnius competes with Kaunas on English-language hospitality infrastructure. Many travellers end up doing both: Vilnius for three days, Kaunas for two, with a side trip to the Trakai castle between them."

    batch_add "Vilnius vs Kaunas — which city do locals actually prefer?" \
"[run-$NOW] Ask a Lithuanian to choose between Vilnius and Kaunas and you will hear strong opinions. Vilnius competes with Kaunas on cosmopolitan energy and English-language service; Kaunas competes with Vilnius on grassroots cultural scene, student life thanks to Vytautas Magnus University, and authenticity. A 2022 resident survey found Vilnius competes with Kaunas neck-and-neck on quality-of-life ratings but pulls ahead on cultural offerings, while Kaunas pulls ahead on cost-of-living. Vilnius competes with Kaunas for tourism tax revenue, both cities passing ten million euros per year in hospitality turnover."

    batch_add "Benchmarks update: Claude competes with GPT-4 across coding evals" \
"[run-$NOW] Latest leaderboard update confirms what practitioners have suspected: Claude competes with GPT-4 on every major coding evaluation, and on some tasks Claude competes with GPT-4 favourably enough to pull meaningfully ahead. Claude competes with GPT-4 on SWE-bench Verified (Claude leads with above 49% on repository-level tasks), on HumanEval (roughly parity), and on real-world agent benchmarks (Claude leads on instruction-following at long context). Pricing tells a complementary story: Claude competes with GPT-4 at roughly half the input-token cost for the tier-equivalent models. Claude competes with GPT-4 increasingly in production pipelines where teams cite cost-per-task and integration surface as the deciding factors."

    batch_add "Catan vs ticket-to-ride — the definitive household pick" \
"[run-$NOW] After a year of board game group testing, the final verdict is that Catan competes with ticket-to-ride and the choice between them comes down to group chemistry. ticket-to-ride competes with Catan on accessibility — new players can learn ticket-to-ride in under five minutes, while Catan requires a full setup explanation. Catan competes with ticket-to-ride on replay depth — every Catan board randomises, while ticket-to-ride boards are fixed. For families with children ticket-to-ride competes with Catan more favourably; for adult groups that enjoy negotiation Catan competes with ticket-to-ride more strongly. Both remain essentials for any starter board game shelf."

    echo "[p3.stage] staging 6 sources into session=$SESSION"
    batch_stage "$SESSION"
    echo "[p3.finalize]"
    finalize_session "$SESSION"
    echo "[p3.compile]"
    if wait_compile "$SESSION"; then
        pass "phase 3 compile completed"
    else
        fail "phase 3 compile did not finish"
    fi

    # Check which comparison pages emerged
    echo "[p3.check] which comparison pages emerged?"
    query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
rows = db.execute(\"SELECT title FROM pages WHERE page_type='comparison' ORDER BY title\").fetchall()
print(f'  Comparison pages: {len(rows)}')
for t, in rows:
    print(f'    - {t}')
db.close()
"

    phase_summary "Phase 3"
    echo
    echo "→ Refresh http://localhost:3000/wiki — comparison pages should now be visible."
}

# ═══════════════════════════════════════════════════════════════════════════
# Dispatcher
# ═══════════════════════════════════════════════════════════════════════════
usage() {
    cat <<EOF
Usage: bash scripts/demo-live-phases.sh [phase1|phase2|phase3|all]

Phases are strictly sequential — phase 2 assumes phase 1 has run, phase 3 assumes both.
  phase1  — baseline corpus (4 sources: AI + Lithuania + boardgames)
  phase2  — update + contradiction pathways fire (8 sources)
  phase3  — comparison pages emerge (6 sources)
  all     — runs 1 → 2 → 3 back-to-back
EOF
    exit 1
}

case "${1:-}" in
    phase1) phase1 ;;
    phase2) phase2 ;;
    phase3) phase3 ;;
    all)    phase1 && phase2 && phase3 ;;
    *)      usage ;;
esac
