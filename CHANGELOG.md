# Changelog

All notable changes to Kompl are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The application surface (Next.js API, CLI, MCP server, settings) follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The SQLite schema
uses a separate monotonic version (currently `v20`); breaking schema changes
ship with a `migrate.py` step that runs at boot.

## [Unreleased]

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

[Unreleased]: https://github.com/tuirk/Kompl/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/tuirk/Kompl/releases/tag/v0.1.0
