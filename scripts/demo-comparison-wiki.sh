#!/usr/bin/env bash
#
# Temporary demo script — seeds 5 comparison pairs so the wiki has multiple
# "X vs Y" pages ready to show. Clone of Scenario C from
# manual-match-triage-test.sh, parameterised across pairs.
#
# Prereqs:
#   - Docker stack up (app, nlp-service, n8n)
#   - GEMINI_API_KEY present in the app container
#   - Clean DB recommended (so the new comparison pages are visibly new)
#
# Usage:  bash scripts/demo-comparison-wiki.sh
# Not wired into integration-test.sh or CI — demo-only.

set -uo pipefail

# Windows Git Bash compatibility for python3.
if ! python3 --version 2>&1 | grep -q "Python 3"; then
    python3() { python "$@"; }
    export -f python3
fi

BASE="http://localhost:3000"
NOW=$(date +%s)
COMPILE_TIMEOUT=480
FAILED=0

pass() { echo "  PASS — $*" ; }
warn() { echo "  FAIL — $*" ; FAILED=1 ; }

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

# stage_texts SESSION T1 B1 T2 B2 T3 B3  — stages 3 items in one session.
stage_texts() {
    local session="$1"
    export STG_SESSION="$session"
    export STG_T1="$2" STG_B1="$3" STG_T2="$4" STG_B2="$5" STG_T3="$6" STG_B3="$7"
    local payload
    payload=$(python3 -c "
import json, os
print(json.dumps({
    'session_id': os.environ['STG_SESSION'],
    'connector': 'text',
    'items': [
        {'markdown': os.environ['STG_B1'], 'title_hint': os.environ['STG_T1'], 'source_type_hint': 'note'},
        {'markdown': os.environ['STG_B2'], 'title_hint': os.environ['STG_T2'], 'source_type_hint': 'note'},
        {'markdown': os.environ['STG_B3'], 'title_hint': os.environ['STG_T3'], 'source_type_hint': 'note'},
    ],
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

# compile_pair LABEL SESSION ENTITY_A ENTITY_B T1 B1 T2 B2 T3 B3
compile_pair() {
    local label="$1" session="$2" a="$3" b="$4"
    shift 4
    echo
    echo "### $label ###"
    echo "[$label] stage 3 sources in session=$session"
    stage_texts "$session" "$@"
    echo "[$label] finalize"
    finalize_session "$session"
    echo "[$label] wait for compile"
    if wait_compile "$session"; then
        pass "$label compile completed"
    else
        warn "$label compile did not finish"
        return
    fi

    local hits
    hits=$(query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
row = db.execute('''
    SELECT COUNT(*) FROM pages
     WHERE page_type = 'comparison'
       AND title LIKE ? COLLATE NOCASE
       AND title LIKE ? COLLATE NOCASE
''', ('%$a%', '%$b%')).fetchone()
print(row[0])
db.close()
")
    if [ "${hits:-0}" -ge "1" ]; then
        pass "$label comparison page created"
    else
        warn "$label comparison page not found"
    fi
}

echo "=== Demo: comparison wiki ==="
echo
echo "[preflight] entity_promotion_threshold=1"
curl -s -X POST "$BASE/api/settings" \
    -H 'Content-Type: application/json' \
    -d '{"entity_promotion_threshold":1}' > /dev/null
pass "settings ready"

# ─── Pair 1: Claude vs GPT-4 ───────────────────────────────────────────────
P1_T1="Claude vs GPT-4 — state of play"
P1_B1="[run-$NOW] Claude 3.5 Sonnet and GPT-4 have become the two most capable general-purpose large language models on the market in 2024. Claude, developed by Anthropic, emphasises constitutional AI training and strong safety guarantees. GPT-4, from OpenAI, pioneered the frontier-scale LLM era with multimodal input and wide ecosystem reach. Both models offer 200k-class context windows, tool use, and vision capabilities. Enterprise buyers regularly evaluate Claude against GPT-4 head-to-head for coding assistants, customer-service bots, and document-processing pipelines. The competitive dynamic between Claude and GPT-4 has driven rapid capability improvements across the industry throughout 2024."
P1_T2="Claude vs GPT-4 — coding benchmarks"
P1_B2="[run-$NOW] On public coding benchmarks Claude 3.5 Sonnet pulls ahead of GPT-4 in SWE-bench Verified scores, with Claude posting above 49% on realistic repository-level code tasks. GPT-4, while still highly competent, trails Claude on agent-style software-engineering evaluations. Claude's instruction-following at long context outperforms GPT-4 in internal developer benchmarks published by Cursor and Replit. GPT-4 retains an edge in code-completion latency and native integrations with Microsoft Copilot. Teams comparing Claude against GPT-4 for pair-programming cite Claude's superior refactoring suggestions and GPT-4's wider IDE-plugin ecosystem as decisive factors."
P1_T3="Claude vs GPT-4 — pricing and ecosystem"
P1_B3="[run-$NOW] The pricing comparison between Claude and GPT-4 currently favours Claude 3.5 Sonnet for most workloads, with input tokens roughly half the cost of GPT-4 Turbo. GPT-4 compensates through tighter integration with OpenAI's broader product suite including ChatGPT, the Assistants API, and DALL-E. Claude distributes through Anthropic's API, Amazon Bedrock, and Google Vertex AI, giving enterprises already on AWS or GCP a clear procurement path. GPT-4 carries first-mover advantage on the Azure Marketplace via the Microsoft partnership. For greenfield projects comparing Claude vs GPT-4, cost-per-task tips toward Claude, while GPT-4 wins when ecosystem lock-in matters more than raw price."
compile_pair "Claude vs GPT-4" "demo-p1-$NOW" "Claude" "GPT-4" \
    "$P1_T1" "$P1_B1" "$P1_T2" "$P1_B2" "$P1_T3" "$P1_B3"

# ─── Pair 2: Bitcoin vs Ethereum ──────────────────────────────────────────
P2_T1="Bitcoin vs Ethereum — two dominant chains"
P2_B1="[run-$NOW] Bitcoin and Ethereum are the two dominant public blockchains by market capitalisation. Bitcoin, launched in 2009, is designed as a digital store of value and peer-to-peer electronic cash with a fixed supply cap of 21 million coins. Ethereum, launched in 2015, is a programmable smart-contract platform that hosts decentralised applications, stablecoins, and tokenised assets. Bitcoin prioritises security and monetary-policy immutability; Ethereum prioritises expressiveness and protocol upgradability. The Bitcoin vs Ethereum comparison frames most conversations about crypto — one is digital gold, the other is a world computer."
P2_T2="Bitcoin vs Ethereum — consensus and energy"
P2_B2="[run-$NOW] Consensus-mechanism differences are central to any Bitcoin vs Ethereum analysis. Bitcoin uses proof-of-work mining, consuming around 150 TWh of electricity per year and relying on specialised ASIC hardware. Ethereum migrated from proof-of-work to proof-of-stake in the 2022 Merge, dropping its energy consumption by over 99% and allowing validators to participate with 32 ETH stakes. The proof-of-stake move repositioned Ethereum against Bitcoin on environmental narratives — institutional investors pursuing ESG mandates now often prefer Ethereum over Bitcoin. Bitcoin supporters counter that proof-of-work is the only sufficiently decentralised security model."
P2_T3="Bitcoin vs Ethereum — use cases"
P2_B3="[run-$NOW] In practical use cases Bitcoin competes with Ethereum primarily as a monetary asset, while Ethereum dominates the application layer of crypto. Bitcoin Lightning Network enables fast, low-fee payments for remittances and micropayments. Ethereum, through its Layer 2 rollups like Arbitrum and Optimism, powers decentralised-finance protocols holding tens of billions of dollars of value. Stablecoins such as USDC and USDT run primarily on Ethereum, not Bitcoin. When investors weigh Bitcoin against Ethereum, the choice often reduces to whether they want exposure to the hard-money narrative or to programmable on-chain economic activity."
compile_pair "Bitcoin vs Ethereum" "demo-p2-$NOW" "Bitcoin" "Ethereum" \
    "$P2_T1" "$P2_B1" "$P2_T2" "$P2_B2" "$P2_T3" "$P2_B3"

# ─── Pair 3: React vs Vue ─────────────────────────────────────────────────
P3_T1="React vs Vue — two top frontend frameworks"
P3_B1="[run-$NOW] React and Vue are the two most widely used open-source JavaScript frameworks for building interactive user interfaces. React, developed by Meta and released in 2013, follows a library-first philosophy and leaves architectural choices to the developer. Vue, created by Evan You in 2014, is a progressive framework with a more opinionated, batteries-included approach. React has the larger ecosystem and commercial adoption, while Vue is frequently cited for its gentler learning curve and clearer conventions. The React vs Vue debate remains one of the most active discussions in frontend development, with both frameworks used at scale by major companies."
P3_T2="React vs Vue — reactivity models"
P3_B2="[run-$NOW] React and Vue differ significantly in how they track state changes. React uses immutable state plus explicit setState or hook-driven updates and recomputes the virtual DOM on every render. Vue, especially in version 3, uses a proxy-based reactive system that automatically tracks dependencies and only re-runs affected computations. Vue tends to feel more automatic for many developers — state mutations just work — while React demands more discipline around referential equality and useMemo. When comparing React against Vue for performance, both land in similar territory after typical optimisation, but Vue often requires fewer manual interventions."
P3_T3="React vs Vue — ecosystem and hiring"
P3_B3="[run-$NOW] The ecosystem comparison between React and Vue heavily favours React on sheer breadth. React has Next.js for full-stack rendering, React Native for mobile, and thousands of third-party UI libraries including Material UI, Chakra UI, and Ant Design. Vue has Nuxt.js as the Next.js equivalent, plus strong tooling like Pinia for state and Vite — originally created by Vue's author. Job markets disproportionately list React roles over Vue, particularly in North America. In Asia, especially China, Vue has stronger enterprise traction. Teams choosing between React vs Vue weigh ecosystem depth against framework ergonomics."
compile_pair "React vs Vue" "demo-p3-$NOW" "React" "Vue" \
    "$P3_T1" "$P3_B1" "$P3_T2" "$P3_B2" "$P3_T3" "$P3_B3"

# ─── Pair 4: PostgreSQL vs MySQL ─────────────────────────────────────────
P4_T1="PostgreSQL vs MySQL — two leading open-source databases"
P4_B1="[run-$NOW] PostgreSQL and MySQL are the two leading open-source relational database management systems. PostgreSQL, descended from the Ingres project at Berkeley, is known for strict SQL-standards compliance, advanced extensibility, and rich type support including JSONB and arrays. MySQL, originally from MySQL AB and now under Oracle, became popular through the LAMP stack and emphasises ease of setup, read performance, and horizontal scaling via replication. Engineering teams comparing PostgreSQL vs MySQL typically weigh feature depth against operational simplicity. Both databases power some of the largest web properties in the world."
P4_T2="PostgreSQL vs MySQL — feature depth"
P4_B2="[run-$NOW] Feature-wise, PostgreSQL pulls ahead of MySQL on advanced capabilities. PostgreSQL supports full ACID compliance across all operations, materialised views, recursive CTE queries, partial indexes, window functions, and native JSONB with GIN indexing. MySQL, particularly versions before 8.0, historically lagged on these features, though the MySQL 8 release closed many gaps. When application workloads require complex analytics, geospatial queries via PostGIS, or custom extension development, PostgreSQL clearly beats MySQL. MySQL still edges ahead in raw read throughput for simple key-value-style workloads and has broader managed-service offerings on legacy hosting providers."
P4_T3="PostgreSQL vs MySQL — replication and operations"
P4_B3="[run-$NOW] Operational differences between PostgreSQL and MySQL meaningfully shape deployment decisions. MySQL's asynchronous replication is battle-tested and supports straightforward read-replica scaling used heavily at places like Facebook and YouTube. PostgreSQL replication, while more feature-rich with logical replication and physical streaming, is often considered more complex to set up at scale. Failover tooling like Patroni narrows the gap for PostgreSQL. When comparing PostgreSQL against MySQL for SaaS platforms, teams with heavy analytical needs or rich data models lean PostgreSQL; teams valuing operational familiarity and huge online communities lean MySQL."
compile_pair "PostgreSQL vs MySQL" "demo-p4-$NOW" "PostgreSQL" "MySQL" \
    "$P4_T1" "$P4_B1" "$P4_T2" "$P4_B2" "$P4_T3" "$P4_B3"

# ─── Pair 5: Docker vs Kubernetes ────────────────────────────────────────
P5_T1="Docker vs Kubernetes — different layers of the container stack"
P5_B1="[run-$NOW] Docker and Kubernetes are the two cornerstone technologies of modern container-based infrastructure, though they operate at different layers. Docker popularised the Linux container as a developer-friendly packaging format in 2013, providing the image standard, build tool, and single-host runtime that reshaped software deployment. Kubernetes, open-sourced by Google in 2014, orchestrates containers across clusters of machines and handles scheduling, scaling, self-healing, and networking. The Docker vs Kubernetes comparison is often misframed — in most production deployments today they work together, with Docker building images that Kubernetes schedules."
P5_T2="Docker vs Kubernetes — scope differences"
P5_B2="[run-$NOW] Scope-wise, Docker and Kubernetes target different problems and should not be pitted as direct substitutes. Docker covers the developer inner loop — writing Dockerfiles, building images, running containers locally with docker-compose. Kubernetes covers the production outer loop — Deployments, Services, Ingress, Horizontal Pod Autoscalers, and multi-region failover. A small team with a single VM can ship entirely on Docker without Kubernetes. A fleet of hundreds of services requires Kubernetes or equivalent orchestration. Comparing Docker against Kubernetes therefore usually reduces to asking which stage of the infrastructure lifecycle a team is optimising for."
P5_T3="Docker vs Kubernetes — ecosystem shifts"
P5_B3="[run-$NOW] Ecosystem dynamics around Docker vs Kubernetes have shifted significantly since 2020. Kubernetes removed Docker as its default container runtime in favour of containerd and CRI-O — a change that surprised many but did not break user workflows because the image format remained identical. Docker responded by doubling down on developer experience with Docker Desktop, Docker Build Cloud, and Compose improvements. Kubernetes continues to expand through CNCF projects like Argo CD, Istio, and Knative. Teams planning infrastructure now rarely ask whether to pick Docker or Kubernetes — the real comparison is usually Kubernetes vs managed alternatives like ECS, Fly, or Railway."
compile_pair "Docker vs Kubernetes" "demo-p5-$NOW" "Docker" "Kubernetes" \
    "$P5_T1" "$P5_B1" "$P5_T2" "$P5_B2" "$P5_T3" "$P5_B3"

echo
echo "=== Summary ==="
query_db "
import sqlite3
db = sqlite3.connect('/data/db/kompl.db')
rows = db.execute('''
    SELECT p.title, (SELECT COUNT(*) FROM provenance pr WHERE pr.page_id = p.page_id) AS n
      FROM pages p
     WHERE p.page_type = 'comparison'
     ORDER BY p.title
''').fetchall()
print(f'Comparison pages: {len(rows)}')
for title, n in rows:
    print(f'  - {title}  ({n} source(s))')
db.close()
"

echo
if [ "$FAILED" = "0" ]; then
    echo "=== Demo seed complete — open http://localhost:3000/wiki ==="
    exit 0
else
    echo "=== Demo seed finished with failures (see above) ==="
    exit 1
fi
