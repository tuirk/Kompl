# Changelog

All notable changes to Kompl are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The application surface (Next.js API, CLI, MCP server, settings) follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The SQLite schema
uses a separate monotonic version (currently `v23`); breaking schema changes
ship with a `migrate.py` step that runs at boot.

## [Unreleased]

## [0.2.0] — 2026-05-11

Multi-provider + visibility + hardening. DeepSeek lands as a second LLM
backend selectable per session; the compile pipeline gains live per-step
progress, an orchestrator-driven recovery path for stranded sources, and a
range-based time estimate; a security pass closes SSRF / path-traversal /
log-forging surfaces and pins the Scorecard-flagged dependencies; and the
always-on/personal-device deployment toggle is gone — Kompl is now
single-mode personal-computer.

### Added

**Multi-provider LLM**

- **DeepSeek V4 Pro as a second selectable compile/chat backend** (#56).
  Provider abstraction layer (Phases 1–5) routes `gemini-*` and
  `deepseek-*` model IDs through a single `LLMProvider` interface; per-
  session model lock stamps the choice at session start so mid-flight
  Settings changes don't hot-swap. Tier-1 RPM caps and per-provider input
  caps live in `nlp-service/services/llm_client.py`.
- **DeepSeek prompt-drift hardening** (#64) — 4-layer JSON-contract block
  in the extract prompt, 28 new contract tests against the real provider
  response shape.

**Visibility & recovery**

- **Live compile-progress UI** (#66) — schema v23, new
  `/api/compile/progress/items` and `/api/compile/progress/events`
  endpoints, expand-to-reveal per-step item drill-down on the progress
  page.
- **Per-step `X/Y` progress detail** — `extract`, `draft`, `ingest_files`,
  `ingest_urls`, `ingest_texts`, `match`, `crossref`, `commit` all emit
  `${done}/${total}` mid-flight (the prior session-only `extract` counter
  is now the pattern everywhere it makes sense; atomic LLM-call steps
  `resolve` and `schema` deliberately remain status-only).
- **Stranded-source recovery** (#71 orchestrator re-plan + this release's
  commit-activation gate) — a source whose extract step fails mid-session
  no longer becomes unrecoverable. The orchestrator re-plans on retry;
  commit only marks `compile_status='active'` for sources with an
  `extractions` row, so both `/api/sources/[id]/recompile` and
  `/api/compile/retry-failed` can re-attempt the source.
- **Compile-model advisory** on `/onboarding/review` — dismissible banner
  recommending DeepSeek for long/academic content, with a deep link to
  `/settings#compile-model`. Generic — Kompl doesn't model-pick for the
  user.
- **Time-estimate range** on `/onboarding/progress` — `EST.` now shows
  `min–max min` (lower bound = `ceil(max / 3)`) rather than a single
  conservative value.

**New connectors / ingestion**

- **Paste-text connector** — raw text → source, no URL or file required.
- **YouTube direct-ingest** (#73) via `youtube-transcript-api` + YouTube
  Data API v3 `videos.list`. Replaces MarkItDown's silent fallback to
  scraping watch-page chrome on transcript-less videos. Strict: transcript
  unavailable OR `YOUTUBE_API_KEY` missing OR Data API error → 422 →
  routed to Saved Links via the app-side `onFailure` path. Covers `watch`
  / `youtu.be` / `shorts` / `embed` / `m.` / `music.` / `/v/` URL forms.
  27 new tests.

**Performance**

- **Parallel extract step** (#67) — `EXTRACT_CONCURRENCY=4`, file-upload
  cap raised to 100.
- **`DRAFT_CONCURRENCY` 5 → 10** (#68).
- **Per-session adaptive stale-session timeout** — replaces the flat
  30-min ceiling with `60 min + 6 min/source` so 50+ source compiles no
  longer get falsely marked failed by the stale-cleanup job.
- **LLM-call timeouts re-sized for DeepSeek** (#62 + #69) — orchestrator
  outer signals and undici dispatcher `headersTimeout` adjusted so
  DeepSeek's 30–400 s extract latency doesn't trigger `HeadersTimeoutError`.

**Setup**

- **One-line installers** — `install.sh` (Linux/macOS) + `install.ps1`
  (Windows). Bootstraps Docker, clones the repo, copies `.env.example`,
  and runs `kompl init`.

### Changed

- **Settings → Compile model** description now documents the Gemini-2.5
  truncation pathology on dense inputs (50K+ char academic PDFs), links
  to [issue #7](https://github.com/tuirk/Kompl/issues/7), and recommends
  DeepSeek for heavy content.
- **README** API-keys table cross-references the truncation issue from
  the Gemini row; Known limitations gains a bullet documenting that
  Kompl does NOT auto-chunk long sources — split manually if staying on
  Gemini.
- **Bulk delete is now batch-aware** (#46) — partial-survivor deletes no
  longer trigger per-page Gemini recompiles for every removed source.
- **`min_source_chars` setting honoured in delete cascade** (was
  hardcoded 500).
- **Archive timestamp gets microsecond suffix** — prevents collision when
  3+ versions of the same page archive in the same second.
- **Compile-progress estimate** uses a range, not a single value (see
  Added).
- **`undici` pinned to `^7`** — `undici 8`'s dispatcher composition is
  incompatible with `Agent` and broke long-running compile calls.

### Removed

- **Deployment-mode toggle** (`personal-device` vs `always-on`) (#57).
  Kompl now targets personal computers exclusively — the toggle, its CLI
  prompt (`kompl init` / `setup.js`), the `/api/settings` GET/POST
  surface for `deployment_mode`, the Settings page UI section, and the
  `runStartupTasks` early-return gate are all gone. The 36h `kompl
  start` startup hook now fires lint + local backup unconditionally on
  every install.
- **n8n `lint-wiki.json` workflow** (Mon 11:30 cron + manual
  `/webhook/lint`). The cron's only justification was always-on coverage;
  the universal startup hook subsumes it. `n8n/auto-import.sh` gains an
  idempotent `delete:workflow --id=kompl-lint-wiki` line so existing
  installs purge the orphan from `n8n-data` SQLite on next restart.
- **`thinking_budget` UI control + setting** (#59). Investigation against
  `google-genai` SDK confirmed the field is silently ignored by Gemini —
  toggling it changed nothing. Setting removed from `/api/settings`, UI
  section deleted, per-call-site overrides retired (issue #7).
- **`docs/plans/`** removed from the repo and gitignored — they're
  local-only working notes.
- **`isYouTubeUrl` helper** (`app/src/lib/nlp-convert.ts`) — dead after
  YouTube routing moved to the nlp-service side.

### Fixed

**Compile pipeline**

- Stranded sources after a partial-extract session (described in Added →
  Visibility & recovery above).
- Adaptive long-running sessions no longer flip to `failed` while
  legitimately running.
- `undici` pin (described in Changed).

**Sources & storage**

- Bulk-delete batching, `min_source_chars` cascade, archive-timestamp
  collisions (described in Changed).

**Chat / NLP**

- Chat `category`/`summary` regex scoped to YAML frontmatter (was
  capturing matches deeper in page bodies).
- Strict Pydantic on vector-router metadata (`extra='forbid'`) — catches
  drift at the contract boundary instead of producing silent runtime
  surprises.

### Security

- **SSRF hardening** — IP-pinned validation in `/metadata/peek`. Rejects
  cloud-metadata IPs, RFC1918 ranges, link-local, multicast.
- **Path-traversal hardening** — centralised in
  `nlp-service/services/_safe_paths.py` and Next.js storage layer.
- **YAML frontmatter escaping** — centralised in
  `app/src/lib/yaml-frontmatter.ts`; all draft-writer paths go through it.
- **Log-arg scrubbing** — `app/src/lib/log-safe.ts`. Prevents log
  forging via injected `\n` + crafted bracket structures in
  user-controlled fields (URLs, titles).
- **Scorecard-flagged dependency pins** — `a574c5f` audit pinned all
  Dependabot-monitored deps to specific versions or version ranges;
  deferred alerts documented in `docs/security/scorecard-deferred.md`.
- **`main` branch ruleset** strengthened — required-status-checks sub-gap
  of Scorecard #27 closed (`46ecfcc`).
- **mcp-server**: `hono >=4.12.16` (GHSA-69xw-7hcm-h432,
  GHSA-9vqf-7f2p-gf9v); `ip-address` overridden to `^10.1.1`
  (GHSA-v2v4-37r5-5v8g).
- **CI**: Scorecard schedule re-enabled now that GHA budget recovered;
  Scorecard + Tests badges restored on README.

### Migration notes

- **Schema v20 → v23** (incremental via `migrate.py` on boot, runs once
  per version step, idempotent on installs that already migrated):
  - **v21**: deletes the `deployment_mode` settings row.
  - **v22 / v23**: adds compile-progress per-step item + event tables
    backing the live-progress UI.
- **`YOUTUBE_API_KEY` env var** — optional. Without it, every YouTube URL
  fails ingest with `422 youtube_metadata_unavailable` and routes to
  Saved Links. Set in `.env` to enable YouTube ingest; see
  `.env.example` and README API-keys table.
- **`docker-compose.yml` `nlp-service.environment`** gained
  `YOUTUBE_API_KEY: ${YOUTUBE_API_KEY:-}`. Existing installs need to add
  this line for the new env var to plumb through.

### Known limitations at 0.2.0

- **Single-tenant only.** Same as 0.1.0.
- **Two LLM providers**: Gemini 2.5 (default) + DeepSeek V4 Pro.
  Anthropic and OpenAI-compatible providers planned.
- **n8n container ships under the [Sustainable Use License](https://docs.n8n.io/sustainable-use-license/)** — unchanged from 0.1.0.
- **Gemini 2.5 + dense sources**: structured-output truncation pathology
  on inputs above ~50K chars (academic PDFs, surveys). Workaround:
  switch the session to DeepSeek V4 Pro. Kompl does NOT auto-chunk.
  Tracked in [issue #7](https://github.com/tuirk/Kompl/issues/7).
- **No mobile app.** Same as 0.1.0.
- **Telegram weekly digest** — backend implementation complete, UI is
  gated as "Experimental" with the toggle locked OFF pending
  schedule/copy/credentials fixes.
- **Auto-backup-on-start** still lacks regression tests on the
  start-time path (carried over from 0.1.0).

## [0.1.0] — 2026-04-27

Initial public release.

### Added — pipeline

- **Compile pipeline** — `extract → resolve → draft → commit → match → schema`,
  one source can update 10+ wiki pages. Multi-pass LLM with TF-IDF relevance
  capping and corpus-wide dossier construction.
- **Six source connectors** — URLs (Firecrawl + GitHub README + YouTube
  transcripts + OG-tag preview), file uploads (PDF, DOCX, PPTX, XLSX, TXT, MD,
  HTML via MarkItDown), browser bookmarks, Twitter JSON export, Upnote export,
  Apple Notes export.
- **NLP service (FastAPI)** — spaCy NER, RAKE, YAKE, KeyBERT, TextRank, TF-IDF,
  all running locally. Embeddings via `sentence-transformers` `all-MiniLM-L6-v2`.
- **Wiki UI** — entity, concept, comparison, and overview pages auto-linked
  with `[[wikilinks]]` at compile time. Inline wikilink rendering in summaries
  and listing cards.
- **Chat over the wiki** — per-session model lock (Gemini 2.5 flash-lite /
  flash / pro). First message stamps `chat_messages.chat_model`; later turns
  in the session ignore Settings changes.
- **MCP server** — stdio, four tools: `search_wiki`, `read_page`, `list_pages`,
  `wiki_stats`. README ships a copy-paste `.mcp.json` template for Claude
  Code auto-discovery; the same config shape works in Claude Desktop (with
  absolute path), Cursor, and any `@modelcontextprotocol/sdk` client.
- **CLI (`kompl`)** — `init`, `start`, `stop`, `restart`, `status[--json]`,
  `open`, `logs`, `update`, `backup [--output] [--schedule]`. Schedule
  registers Linux cron / macOS cron / Windows Task Scheduler.

### Added — operations

- **Single-writer SQLite architecture** — Next.js holds the only DB handle;
  NLP and n8n talk to the DB only over HTTP to Next.js routes. WAL mode,
  named-volume storage, no Windows host bind-mounts.
- **Sync transaction commit** — `better-sqlite3.transaction()` wraps storage
  write + DB upsert + FTS update in one atomic step. No `await` inside ever.
- **History-preserving page writes** — `write_page()` moves the existing
  file to `{page_id}.{timestamp}.md.gz` before writing the new one, populating
  `pages.previous_content_path` from the storage layer.
- **Crash-safe ingest** — outbox pattern + atomic file writes + boot reconciler
  recovers from mid-pipeline crashes without losing in-flight sources.
- **Off-mode approval workflow** — `auto_approve='0'` queues content plans to
  `/drafts`; bulk `/api/drafts/approve-all` commits via `commitSinglePlan`.
- **n8n orchestration** — three workflows (`session-compile`, `lint-wiki`,
  `weekly-digest`). Per-node error routing logs failures via `/api/activity`.
  Session-compile triggered server-to-server only; the browser never POSTs
  to n8n directly.
- **kompl backup format** — `.kompl.zip` containing sources, compiled pages,
  provenance, extractions, settings. API keys excluded by design. No LLM
  calls needed to restore.
- **Personal-device vs. always-on deploy modes** — set during `kompl init`.
  Personal-device fires lint + local backup on `kompl start` if either has
  not run in 36 h, covering n8n's silent-skip behaviour when the laptop is
  off at schedule time.

### Added — schema (v20)

- **18 tables**, FTS5-backed search, Chroma vector store embedded.
- **`compile_progress.compile_model`** (v20) — per-session compile-model
  lock. Stamped at `/api/onboarding/finalize` time; mid-pipeline Settings
  changes never hot-swap an in-flight compile. Cancel + restart to switch
  models mid-session.
- **`chat_messages.chat_model`** (v19) — per-session chat-model lock,
  stamped only on the first message of each session.
- **Wiki-wide mention indexes** (v17) — `entity_mentions` and
  `relationship_mentions` populated at extract-commit time. Plan rules use
  corpus-wide thresholds so single-source ingests compound into the wiki
  instead of orphaning.
- **Onboarding v2 staging** (v18) — `collect_staging` holds connector
  intent before scraping; `ingest_failures` gained `session_id` for
  session-scoped retry.

### Added — quality controls

- **Two-gate length filter** — Gate 1 (`min_source_chars`, default 500)
  routes thin sources to a raw-content page (no LLM draft). Gate 2
  (`min_draft_chars`, default 800) rejects drafts as `draft_too_thin`
  at commit time. Both configurable in Settings.
- **Entity-promotion threshold** (default 2) — entity/concept pages only
  created if the topic appears in ≥ N distinct sources, counted corpus-wide
  via `entity_mentions`.
- **Comparison pages require ≥ 3 sources** mentioning the specific
  relationship, **and** both entities must already have promoted pages.
- **URL host blocklist** — bad sources blocked at intake instead of
  downstream cleanup.

### Added — repo & launch infrastructure

- **Apache-2.0 LICENSE**, **NOTICE** with n8n SUL attribution.
- **CONTRIBUTING.md**, **CODE_OF_CONDUCT.md**, **SECURITY.md**, **AUTHORS**.
- **`.github/`** — `dependabot.yml`, `CODEOWNERS`, issue templates (bug,
  feature, config), PR template.
- **`integration-test.yml`** workflow — unit tests (vitest, jest, pytest)
  + full Docker-Compose end-to-end. `permissions: contents: read` default.
- **OpenSSF Scorecard workflow** (`.github/workflows/scorecard.yml`) —
  manual-trigger only at v0.1.0; will move to scheduled once GHA billing
  recovers.
- **CodeQL Default Setup** enabled for JS/TS + Python.
- **Branch ruleset on `main`** — required PR + 1 approval, blocks force-push
  and deletion. Admin bypass for the two maintainers.

### Known limitations at 0.1.0

- **Single-tenant only.** No user accounts, no auth, no multi-tenant DB.
  Don't expose to the public internet without your own auth layer.
- **Gemini is the only LLM provider.** Anthropic and OpenAI-compatible
  providers planned. Free Gemini tier rate-limits during real ingests;
  paid Tier 1 recommended.
- **n8n container ships under the [Sustainable Use License](https://docs.n8n.io/sustainable-use-license/)**
  (not OSI-approved). Self-hosting Kompl is fine; offering Kompl as a hosted
  service to third parties needs n8n's permission.
- **Always-on-server mode** is a demo feature; the always-on path hasn't
  been hardened.
- **No mobile app.** Web UI works on mobile browsers but isn't optimised
  for small screens.
- **Telegram digest** is wired but Settings UI is locked until two known
  issues are resolved. No outbound Telegram calls on a default install.
- **Auto-backup-on-start** is end-to-end wired but lacks regression tests
  on the start-time path.

[Unreleased]: https://github.com/tuirk/Kompl/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/tuirk/Kompl/releases/tag/v0.2.0
[0.1.0]: https://github.com/tuirk/Kompl/releases/tag/v0.1.0
