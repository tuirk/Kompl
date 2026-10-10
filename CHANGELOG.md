# Changelog

All notable changes to Kompl are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The application surface (Next.js API, CLI, MCP server, settings) follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The SQLite schema
uses a separate monotonic version (currently `v27`); breaking schema changes
ship with a `migrate.py` step that runs at boot.

## [Unreleased]

### MCP server

- **Stays built.** Setup and `kompl update` now build the MCP server, and
  `kompl start` rebuilds it once when its build is older than its source, so
  AI agents run the code that matches the installed Kompl. Before, it was
  built by hand once at install and never again. Restart your AI agent after
  an update to load the new version.
- **`wiki_stats` no longer writes.** It read `/api/health`, which also repairs
  stuck compile sessions; it now reads `/api/wiki/stats` and shows active
  sources, entity and concept counts and the last ingest and compile times
  (instead of schema version and table count).
- **Failed calls are marked as errors** (`isError`) with a next step ("Start
  it with `kompl start`", "Use search_wiki to find page ids"), and every tool
  has a title and read-only annotations.
- **MCP SDK 1.32.1** (fixes an advisory affecting 1.12–1.30) with refreshed
  dependencies; `npm audit` reports none. The server has its own tests and CI
  job.

### Wiki readability

- **Numbered citations.** Pages cite sources as superscript numbers that
  jump to a numbered source list (cited sources first). Pages drafted
  earlier, which printed raw source UUIDs in assorted shapes, render the same
  way; their stored text is not changed. New drafts cite with `[S1]`-style
  labels that are stored as `[^source_id]` references, so a page never
  contains raw ids.
- **MCP `read_page`** returns the page body without frontmatter, with
  citations as `[n]` and a matching numbered, de-duplicated source list.
- **Piped wikilinks** (`[[Target|label]]`) render as links showing the label
  instead of literal text, and count as links for backlinks and the graph.
  Links from a page to itself render as plain text.
- **Source lists no longer double-count:** provenance gains a row per
  compile, so the page footer and the page-data API now show one row per
  source (Bitcoin: 6, was 15). Recompiles send each source once.
- **Search** finds hyphenated and possessive terms ("sha-256",
  "proof-of-work", "bitcoin's"), in the app and through MCP `search_wiki`.
- **Reading layout:** ~70-character lines (was ~100), larger body text,
  always-underlined links, full-contrast summary, `--fg-dim` and
  `--fg-subtle` raised to pass WCAG AA (were 2.5:1 and 4.2:1), a table of
  contents that stays below the top bar and highlights the current section,
  per-page tab titles ("Bitcoin · Kompl") and a proper "not found" page.
- **Collapsible wiki sidebar:** the left panel folds into a slim icon rail
  (the button at its top-left, or Ctrl+.) with links to all pages, the graph
  and activity, and the article widens to fill the space. The choice is
  remembered per browser, without flashing open on load; windows narrower
  than 1200px start folded. Expanded, it reads more easily: larger titles,
  the current page highlighted and scrolled into view, its category opened,
  full titles on hover, and visible keyboard focus.
- **Boot hook actually runs:** `instrumentation.ts` moved to `app/src/`.
  Next.js never loaded it from `app/`, so the outbox's pending-page
  reconciler had not run in any build; it now runs at every start, and the
  one-time wikilink resync runs on the first start.
- **README rewritten** around what Kompl does and MCP, with new screenshots
  of the dashboard, a compiled page, the graph and Settings.

### Page quality

- **Drafts stay within their sources.** The entity, concept, comparison and
  overview prompts now say to state only what the sources say (no added
  origins, causes, rankings or "firsts"), define a contradiction as two
  claims that cannot both be true (designed vs first released is not one),
  cap "Related Concepts" at 5 and ask for four frontmatter keys only.
  Citation labels are footnote markers, never words: "[S2] states that…"
  used to render as "² states that…".
- **Safety nets on every new draft**, whatever the model writes: a citation
  label used as a word is reworded ("One source² states…"); invented
  frontmatter (`sources: S1…`, `last_updated`, `status`, `contested`) is
  dropped; empty "Contradictions: None" sections are removed; source notes
  are never offered or kept as link targets; each page is linked once; and
  Related lists keep at most 5 entries that the page or its sources mention
  (entries a page already had are kept). The link injector no longer adds a
  second link to a page the draft already links.
- Existing pages are not changed on their own: the rules apply to pages
  drafted or updated after the upgrade, and older pages can be updated from
  Settings (below). A wiki's `schema.md` is not rewritten either; where it
  conflicts with these rules, the rules win.
- **Existing pages read cleaner right after the upgrade**, on display only
  (stored pages are unchanged): each page is linked once in the body
  (Related lists and tables keep their own links), links in headings and
  code show as text, and "Contradictions" sections that only say there are
  none are hidden.
- **Obsidian and Markdown exports** turn citations into numbered footnotes
  with definitions (`[^1]: Source title`), numbered like the page view, and
  heal legacy page wrappers the way the page view does. Obsidian `sources:`
  lists each source once (Bitcoin network: 5, was 12) and `date_updated` is
  a date again. JSON and `.kompl` backups are unchanged.
- **Saved Links** shows a readable reason for each failed link ("Reserved
  test domain (.test) — not a real website", "Firecrawl credits used up")
  instead of the raw error JSON; the raw error stays available on hover.
- **Entity merging no longer joins different things.** Names whose numbers
  differ never merge (Python 2 / Python 3, GPT-4 / GPT-4o, Windows 10 / 11),
  in any resolution layer; version pairs are answered "different" without an
  LLM call. A name that only adds words to another (Ethereum / Ethereum
  Foundation, Bitcoin / Bitcoin network) is left to the embedding and LLM
  layers instead of being merged on spelling, except people's names
  (Karpathy / A. Karpathy / Andrej Karpathy). A merged group is named after
  the name most sources use; for people, the fullest name.
- **Existing wikis:** saved aliases that merged different versions
  ("Python 3" → "Python 2", "Python" → "Python 2") are ignored from now on,
  so new sources about Python 3 get their own page; the alias rows are
  kept. Other saved merges keep routing as before.
- **Update pages to the v0.4 writing rules** (Settings → Wiki health): a
  compile only adds to a page, so pages written by an earlier version keep
  their text. The card lists what changed, how many pages were written by an
  earlier version, and what updating them costs and takes with the selected
  model (an estimate from each page's sources and current length, the
  model's prices and its measured speed, shown as a rounded range), with a
  warning when that can pass today's spending limit. **Update all** rebuilds
  them one at a time, oldest first, from all their current sources, with
  progress, spend so far and a Stop button; new compiles can't start
  meanwhile. A run only touches the pages counted when you confirmed, and
  stops by itself if it spends more than 1.5 × the high estimate, at the
  daily spending limit, after 3 failures in a row or when a compile starts.
  Pages it can't rebuild (sources too short for a full page, or unreadable)
  keep their text, are listed on the card, and aren't offered or charged
  again until a compile changes them. Each page's previous version is
  archived first, and **Restore this version** (under "View previous
  version" on the page, when that version is available) puts it back. A
  restored page keeps the text you chose: Update all doesn't rewrite it
  again. A restart ends a run; Update all again continues with the pages
  that are left, never charging a page twice. Leaving the pages is fine:
  they still improve as new sources arrive. A one-time notice after
  upgrading points to the card; a fresh install has no older pages, so it
  doesn't see one. With nothing to update, the card says how many pages
  follow the current rules and lists what changed. Schema v26 → v27 adds
  `pages.draft_rules` (the rules a
  page's text follows; NULL = written before v0.4, every existing page) and
  `page_plans.draft_rules` (so a draft made under older rules that is
  approved later is still offered for an update). Backups carry both; older
  backups import as NULL. The nlp-service gains `GET /llm/pricing` for the
  estimate. The rules version lives in one place (`lib/writing-rules.ts`):
  a later release that changes the writing rules sets it and lists what
  changed, and the card and the notice offer every page written under older
  rules again.

### Added

- **Disputes in the right panel and the activity feed.** When a page's
  text records a disagreement between its sources (a "Disputed: …" or
  "Contradictions" section citing two or more sources), the right panel
  lists it with how many sources disagree and a link to the section, next
  to new sources a compile flagged as contradicting the page. Compiles,
  approvals, page updates, restores and recompiles log each newly recorded
  dispute once (DISPUTE in the activity feed); a dispute reworded with the
  same sources is not logged again. No extra LLM calls.
- **Current models.** Compile model choices are now DeepSeek V4.1 Flash
  (`deepseek-flash`), DeepSeek V4 Pro, Gemini 3.8 Flash, Gemini 3.5
  Flash-Lite and Gemini 3.1 Pro (preview). Gemini 3 requests use
  `thinking_level` and the default temperature, as Google requires for 3.x;
  Gemini 2.5 requests are unchanged.

### Changed

- **Wiki right panel restyled to match the sidebar:** On this page,
  Disputes, Linked from (the first 8, then Show all), You might also read,
  and View original source on source notes, in readable 14px rows with
  hover and keyboard-focus states.
- **Wiki health checks run when you ask.** Settings → Wiki health has a
  **Run check** button and no longer a "Scheduled wiki health checks"
  switch. The schedule only ever ran from `kompl start`, at most once per 36
  hours, and its contradiction check spends LLM credit without asking.
  `kompl start` still saves a local backup; older CLIs that still request a
  check get it skipped. The `lint_enabled` setting is kept for older clients
  and backups.
- **Settings:** **Auto-approve wiki changes** moved into Advanced tuning, and
  the Review section, which only held that switch, is gone.
- **Wiki header:** a **Wiki | Graph** view switch replaces the Graph button
  on the wiki and on the graph page (which drops its "← Wiki" link), the
  search box that repeated the top bar's is gone, and **Add sources** is a
  compact + button with a tooltip.
- **Page history keeps the last 2 versions.** Each time a page is saved,
  its current text is archived as before, and archives beyond the newest
  2 are deleted. "View previous version" and "Restore this version" use
  the newest one. Pages that are never saved again keep the archives they
  already have.
- **Default compile model for new installs: DeepSeek V4.1 Flash.** Schema
  v25 → v26 writes an explicit `compile_model` row on every install:
  existing installs that never picked a model are pinned to
  `gemini-2.5-flash` (what they ran on), fresh installs get
  `deepseek-flash`. Any model you already picked is kept.
- **Gemini 2.5 and DeepSeek V4 Flash are now "legacy".** They stay valid and
  selectable: Google only serves Gemini 2.5 to API projects that used it
  before, and DeepSeek serves `deepseek-v4-flash` requests with V4.1 Flash
  (Kompl now sends those as `deepseek-flash`).
- **DeepSeek thinking is set explicitly on every call.** Steps with a zero
  thinking budget (crossref, triage) now run with thinking disabled instead
  of DeepSeek's default (on, high effort), which could use up triage's
  512-token output limit.
- **DeepSeek prices** updated to the current peak-hour list rates, so the
  daily cap counts DeepSeek spend at what the invoice shows (2–4× more than
  before). Off-peak hours cost half, so the cap now errs on the safe side.
- **Settings page reorganised** into one page ordered by importance (AI model
  & spend, Connect your AI, Review, Wiki health, Backup & restore, Advanced
  tuning). The sidebar highlights the current section, every setting shows
  its default, longer help moved behind "Details", and the five compile
  tuning knobs are collapsed under Advanced. Removed the dead "Automation &
  delivery" link.
- **`setup.js`** asks for the DeepSeek key first and states Node ≥ 24.

### Removed

- **In-app chat.** The Chat button, chat drawer, `/chat` page, `/api/chat`,
  `/api/chat/history`, `/api/chat/save-draft`, the nlp-service
  `/chat/select-pages` and `/chat/synthesize` endpoints and the Settings
  "Chat model" selector are gone. Query your wiki through the MCP server
  instead (Settings → Connect your AI). `/chat` now redirects there.
- **Global footer bar.** Layout offsets that reserved its 32px are gone too.

### Kept for existing installs

- Chat history stays in the `chat_messages` table and in exports; old
  `.kompl.zip` backups (including their `db/chat_messages.json`) import
  unchanged.
- Chat drafts still awaiting approval keep their dashboard label, their
  approve-all scoping and their cleanup when a cited page is deleted.
- `GET /api/wiki/stats` stays as a read-only stats endpoint.

### Fixed

- **Extracted contradictions and concept definitions reach the draft:** the
  draft step read field names the extractor never writes, so every "this
  source disputes X" note and every concept definition was dropped before
  the drafting model saw them. Each contradiction line now says which side
  the source takes, so the model can't cite a source for the view it
  rejects.
- **Page summaries no longer show citation labels:** a draft that cited
  inside its summary ("…dining and parks [S1][S2].") kept the raw labels
  wherever the summary appears. The frontmatter clean-up every draft,
  recompile and page update passes through now removes them.
- **Related pages ("You might also read"):** archived pages are no longer
  suggested, matches below 0.25 similarity no longer fill the list (it can
  show fewer than five pages), the panel gives up after 3 seconds so a slow
  NLP service can't hold up a wiki page, and failed searches are logged.
  The Settings text now says what it counts: sources that aren't archived;
  0 shows the panel whenever similar pages exist.
- **Search vectors stay current:** page updates, restores and recompiles
  refresh a page's vector with the same retries as a compile, and a page
  whose save is completed at startup gets its vector refreshed too.
- **CLI tests no longer overwrite your backup:** the `kompl start` tests ran
  against the real home folder and could replace
  `~/.kompl/backups/kompl-backup.kompl.zip` with an empty file. They now use a
  temporary folder.
- **CLI on a fresh clone:** `cli/package.json` gains a `prepare` script, so
  `npm install` (run by `setup.js` and `kompl update`) builds `dist/`.
  Before this, `kompl` failed with `Cannot find module '../dist/index.js'`
  on any machine without an old local build.
- **Importing an older backup** no longer overwrites the database's
  `schema_version` (which made `/api/health` report the DB as broken until
  the next restart). Backups from before v26 that kept the default model
  import pinned to `gemini-2.5-flash`.
- **Restoring a new backup on an older release** (up to v0.3.2.1) no longer
  leaves that install "degraded": backups keep the schema version in
  `manifest.json` only, so an older import can't copy it over its own.
  Checked against the May–October 2026 backups: every one imports into this
  release, upgrades from v0.3.2.1 keep every row, and a backup made here
  restores into v0.3.2.1 with all pages.

## [0.3.2.1] — 2026-09-01

Security and docs patch over 0.3.2: nanoid CVE override, README intro
restructure, Scorecard #27 dismissal, and a Dependabot minor/patch roll-forward.

### Fixed

- **nanoid (CVE-2026-67213):** `app/package.json` override to `^3.3.18`.

### Changed

- **README / AGENTS.md:** product-first intro (timing, pipeline, MCP);
  operator guide follows the removed heading.
- **Scorecard #27:** dismissed `won't fix` (solo-dev branch-protection
  gaps). Ledger updated in `docs/security/scorecard-deferred.md`.
- **Dependency roll-forward (#184, #185, #189, #208–#210, #212, #214–#218):**
  Next 16.3.1; google-genai 2.19; MCP SDK 1.30; fastapi / uvicorn /
  markitdown / spacy / nltk; CLI jest/ts-jest/open; Actions patches.

### Known limitations at 0.3.2.1

- `better-sqlite3` remains on 12.x (v13 major held back).
- Chroma/numpy migration still deferred. Server-mode Chroma CVEs do not
  apply to embedded PersistentClient.
- Pip hash-pinning and integration-test `downloadThenRun` unchanged.
  See `docs/security/scorecard-deferred.md`.

## [0.3.2] — 2026-07-26

UX and docs release over 0.3.1: chat drawer, wiki sidebar/search fixes,
Gemini-or-DeepSeek setup clarity, and security dependency roll-forward.

### Added

- **Chat drawer (#177):** TopNav opens chat in a right drawer (`ChatDrawer` /
  `ChatPanel`); dedicated `/chat` route remains available.
- **README “What is Kompl?” (#182):** replaces “Why Kompl?”; notes MCP ships
  four tools for now with more planned. `AGENTS.md` slimmed to a pointer.

### Fixed

- **Wiki sidebar (#176):** remembers open sections via
  `kompl_wiki_sidebar_open`; defaults all open when uncached.
- **Wiki search (#175):** `/wiki/search?q=` seeds the search input
  (Suspense-wrapped for Next prerender).

### Changed

- **Compile providers (#178):** install/README/setup accept Gemini **or**
  DeepSeek (or both).
- **Credits (#180):** project credits and CODEOWNERS cleanup.
- **Dependency roll-forward (#174, #179, #181 + Dependabot batch):** Next
  16.2.11; sharp 0.35.3; postcss 8.5.18; brace-expansion 1.1.16 / 2.1.2 /
  `@5` floor 5.0.8; `@hono/node-server` ≥2.0.5; MCP body-parser / fast-uri;
  CI actions setup-node/setup-python/upload-sarif bumps; nlp minor/patch group.
- **Scorecard ledger (#183):** #70 brace-expansion GHSA false-positive
  disposition; #90/#91 integration-test `downloadThenRun` deferred.

### Known limitations at 0.3.2

- Same deferred items as 0.3.1: branch-protection Scorecard #27, pip
  hash-pinning, Chroma/numpy migration. See `docs/security/scorecard-deferred.md`.

## [0.3.1] — 2026-07-07

Security and reliability release over 0.3.0: audit hardening, wiki lint drill-down,
`kompl update` rebuild fix, weekly digest removal, and dependency roll-forward.

### Added

- **Wiki lint v1.1 (#137):** drill-down lint reporting — `WikiLintResults`
  component, richer `/api/wiki/lint-pass`, and structured lint result model.
- **`AGENTS.md` (#142):** operator guide for AI agents (wiki-safety rules,
  update pitfalls, destructive-command guardrails).

### Fixed

- **`kompl update` (#142):** now runs `git pull --ff-only`, rebuilds and
  relinks the CLI, pulls registry images, and `docker compose up --build -d`
  so app and nlp-service pick up source changes. README **Updating** section
  documents the stale-Docker-image gotcha.
- **Provider-aware health check (#138):** `/api/health` requires the selected
  compile provider's API key, not just any provider key.
- **Security audit (#143):** SSRF guard on URL conversion, loopback bind for
  app port, compile flush durability (`flush_failures` / boot reconciler), XSS
  hardening in markdown rendering, path traversal fixes on import/previous
  routes, LLM disambiguate cap, cost-cap lock, provenance hash consistency,
  migration v23/v24 guards, integration-test stage 11d fail-closed.
- **Dev-dep advisories (#155):** js-yaml and @babel/core lockfile bumps; nltk
  CVE disposition documented in `nlp-service/osv-scanner.toml`.

### Removed

- **Weekly Telegram digest (#137):** digest API route, n8n workflow, NLP
  digest-summary endpoint, and Settings UI. Activity feed and wiki lint remain
  the supported ways to review wiki health.

### Changed

- **Dependency roll-forward (#152, #154, #159, #160):** app Next 16.2.10 and
  vitest toolchain; MCP server `hono` 4.12.27; CI `actions/checkout` v7,
  setup-python 6.3.0, setup-buildx-action 4.2.0, CodeQL upload-sarif 4.36.3;
  `json-repair>=0.61.2` floor in nlp-service.

### Known limitations at 0.3.1

- Same deferred items as 0.3.0: branch-protection Scorecard #27, pip
  hash-pinning, Chroma/numpy migration. See `docs/security/scorecard-deferred.md`.

## [0.3.0] — 2026-06-07

Security and dependency-maintenance release over 0.2.2. Clears the Scorecard
vulnerability alert, closes the Hono CVE chain in the MCP server, and tightens
Dependabot policy around intentionally deferred major migrations.

### Fixed

- **Compile cancellation (#119):** queued compile rows orphaned by cancel are
  now cleared so cancelled sessions do not stay visible as active work.
- **YouTube ingest (#121):** direct `youtube-transcript-api` install is upgraded
  to 1.2.x in the Docker image, restoring transcript fetches that broke on
  1.0.x timedtext responses.
- **Embedding import drift (#121, #136):** Docker and CI now install CPU torch
  before `requirements.txt`, and the import smoke test catches
  torch/transformers incompatibilities that normal pytest stubs would miss.

### Security

- **MCP server Hono CVEs (#122):** `hono` override raised to `^4.12.21`
  (resolved lockfile: 4.12.23), closing CVE-2026-47673 through CVE-2026-47676
  in the unused HTTP transport path of `@modelcontextprotocol/sdk`.
- **Scorecard #70 / OSV (#136):** `torch` bumped to 2.6.0 (CPU) and
  `transformers` exact-pinned to 5.9.0, clearing 27 OSV IDs reported against
  the previous 4.x transformer range.
- **Scorecard pip hash-pinning (#133, #136):** deferred pip hash-pinning alerts
  are documented in `docs/security/scorecard-deferred.md`; current open
  security-scanning state is intentionally reduced to branch-protection #27.

### Changed

- **Dependabot policy (#124, #133):** ignore rules now document blocked major
  migrations for `chromadb >=0.5.0`, `marked >=13`, `transformers >=5.10.0`,
  and `pyrate-limiter >=4.0.0`.
- **Dependency roll-forward (#100, #125-#128):** app, CLI, MCP server, CodeQL,
  and checkout actions received minor/patch maintenance updates, including
  `next` 16.2.7, `react` 19.2.7, `better-sqlite3` 12.10.0,
  `github/codeql-action` 4.36.2, and `actions/checkout` 6.0.3.

### Known limitations at 0.3.0

- **Branch-protection Scorecard alert #27** remains open by design for solo-dev
  policy gaps (admin bypass, two-reviewer approval, codeowners, last-push
  approval).
- **Pip hash-pinning** remains deferred for the NLP ML stack; see
  `docs/security/scorecard-deferred.md`.
- **Chroma/numpy migration** is still deferred: `chromadb==0.4.24` and
  `numpy<2` remain pinned until a deliberate vector-store migration.

## [0.2.2] — 2026-05-30

Incremental release over 0.2.1: pre-compile health checks, DeepSeek V4 Flash,
smarter file-upload titles, clearer YouTube failure messages, per-item URL
blocklist skipping, dependency roll-forward (including `google-genai` 2.x),
and an mcp-server `qs` security pin. Schema v24 → v25.

### Added

**Onboarding health (#114)**

- **`/onboarding/health`** — pre-compile checklist after source selection.
  Red/green rows for NLP service reachability, selected compile-model provider
  key, Firecrawl, and YouTube. **Next** stays blocked until red rows are fixed.
- **`GET /api/health`** extended additively with `selected_compile_model`,
  `selected_compile_provider`, and `integration_keys`.
- Provider registries (`LLM_PROVIDERS`, `INTEGRATION_KEYS`) and pure-function
  evaluator (`onboarding-health-evaluator.ts`).
- Structured pre-stage error codes in `service-errors.ts`
  (`selected_provider_key_missing`, `firecrawl_key_missing`,
  `youtube_key_missing`).

**DeepSeek V4 Flash (#117)**

- **`deepseek-v4-flash`** as a third selectable compile and chat model in
  Settings, API validation, NLP provider registry, and per-session model lock.
- Chat routes fixed to accept DeepSeek SKUs on `/chat/select-pages` and
  `/chat/synthesize`.
- Phase 8 validation harness under
  `validation/2026-05-22-deepseek-flash/` (report template; corpus run
  still marked pending in `REPORT.md`).

**File-upload titles (#86)**

- **Phase 1 (zero LLM cost):** body-heading title extraction on
  `/convert/file-path` — first usable H1/H2 in the first 4 KB of converted
  markdown (skips fenced code, rejects section labels like `Abstract`).
- **Phase 2 (piggybacks existing extract LLM call):** one-shot title rescue
  when `title_source` is `filename`/`stem` or title matches garbage heuristics;
  `title_rescued_at` prevents recompile title churn.
- **`ConvertResponse.title_source`** — always-populated contract field (9 known
  values); cascade-winner telemetry log on every file conversion.
- **`title_rescued` activity event** registered for the feed.

**YouTube / Saved Links copy (#84)**

- **`ingest-error-copy.ts`** maps known ingest error codes to friendly
  one-liners; unwraps the FastAPI `{"detail":"..."}` envelope that was
  leaking into Saved Links.

### Changed

- **Bookmark / URL staging (#85):** blocked-host URLs (X/Twitter/t.co) are
  skipped **per item** instead of failing the whole batch with HTTP 422.
  `blocked_count` / `blocked_urls` returned on 200; BookmarksConnector
  pre-filters at file-pick with a toast; `onboarding_blocked_urls_skipped`
  activity event.
- **`service-errors` entries** reshaped to `{ title, body, fix }` while
  preserving the `toUserMessage` string contract (#114 groundwork).
- **Dependabot (#94):** bundled roll-forward — `google-genai` 1.73.1 → **2.4.0**,
  `uvicorn[standard]` 0.46 → 0.47, `sentence-transformers` 5.4.1 → 5.5.0,
  `youtube-transcript-api` floor → `>=1.2.4`, `json-repair` floor →
  `>=0.59.10`, `codeql-action` 4.35.4 → 4.35.5.
- **Dependabot (#110):** `github/codeql-action` 4.35.5 → **4.36.0**,
  `docker/setup-buildx-action` → **4.1.0**, `@types/node` patch in
  mcp-server.
- **Dependabot config:** ignore `chromadb >=1.0.0` and `numpy >=2` (blocked by
  `chromadb==0.4.24` + `numpy<2` pin until deliberate migration).

### Fixed

- **YouTube ingest errors (#84):** cloud-IP / bot-detection empty transcript
  responses now return **`422 youtube_transcript_blocked`** instead of
  **`youtube_no_transcript`**.
- **Chat DeepSeek routing (#117):** `/chat/select-pages` and `/chat/synthesize`
  no longer reject DeepSeek model IDs.

### Security

- **mcp-server `qs` (#105, GHSA-q8mj-m7cp-5q26 / CVE-2026-8723):** npm
  override `>=6.15.2 <7.0.0` on transitive `qs` via
  `@modelcontextprotocol/sdk` → `express` (6.15.1 → 6.15.2).

### Migration notes

- **Schema v24 → v25** (incremental via `migrate.py` on boot):
  - **`sources.title_source TEXT`** — which cascade step produced the title.
  - **`sources.title_rescued_at TIMESTAMP`** — idempotency marker for LLM
    title rescue.
  - Pre-v25 rows stay `NULL`; extract route falls back to legacy
    `isGarbageTitle` behaviour.
- **No new required env vars.** `DEEPSEEK_API_KEY` and `YOUTUBE_API_KEY`
  remain optional; onboarding health surfaces when they are missing for the
  selected model or YouTube ingest.

### Known limitations at 0.2.2

- **Three compile/chat backends:** Gemini 2.5 (default), DeepSeek V4 Pro,
  DeepSeek V4 Flash (opt-in, lower cost/latency; Phase 8 corpus validation
  report not yet filled in).
- **Single-tenant only.** Same as prior releases.
- **YouTube from datacenter IPs:** `youtube_transcript_blocked` is expected;
  residential proxy not wired (deferred).
- **chromadb 0.4.24 / numpy <2** pin unchanged; Dependabot PRs for chromadb 1.x
  and numpy 2.x remain blocked.

## [0.2.1] — 2026-05-14

Security patch release. Closes all 26 open Dependabot alerts (14 high,
8 medium, 4 low — 13 unique GHSAs, all in `next`) by bumping Next.js to
16.2.6, and rolls forward the rest of the weekly minor-and-patch
floor across the app and nlp-service surfaces. CI green throughout;
no API, schema, or behavioral changes.

### Security

- **Next.js 16.2.4 → 16.2.6** (#81, #82). Closes 13 GHSAs:
  - High (7): GHSA-8h8q-6873-q5fj (Server Components DoS),
    GHSA-c4j6-fc7j-m34r (WebSocket-upgrade SSRF),
    GHSA-492v-c6pp-mqqv (dynamic-route middleware bypass),
    GHSA-36qx-fr4f-26g5 (Pages-Router i18n middleware bypass),
    GHSA-267c-6grr-h53f and GHSA-26hh-7cqf-hhc6 (segment-prefetch
    middleware bypass + incomplete-fix follow-up — the latter is
    why 16.2.6 is required and 16.2.5 was insufficient),
    GHSA-mg66-mrh9-m8jx (Cache-Components connection-exhaustion DoS).
  - Medium (4): GHSA-ffhc-5mcf-pf4q (CSP-nonce XSS),
    GHSA-gx5p-jg67-6x7h (beforeInteractive XSS),
    GHSA-h64f-5h5j-jqjh (Image-Optimization-API DoS),
    GHSA-wfc6-r584-vfw7 (RSC cache poisoning).
  - Low (2): GHSA-vfv6-92ff-j949 (RSC cache-buster collisions),
    GHSA-3g8h-86w9-wvmq (middleware-redirect cache poisoning).
- **`github/codeql-action` 4.35.3 → 4.35.4** (#79). Rolls the bundled
  CodeQL engine to 2.25.4. SHA pin in `.github/workflows/scorecard.yml`
  re-anchored per the project's Scorecard-pinning convention.

### Changed

- **`better-sqlite3` 12.9.0 → 12.10.0** (#82). Bundled SQLite engine
  3.x → 3.53.1. Adds Node 26 prebuilds; drops EOL Node 20/23 prebuilds.
  No API change — sync-only `transaction()` and pragma usage unaffected.
  Version 12.9.1 (a poison release flagged by upstream) is correctly
  skipped.
- **React 19.2.5 → 19.2.6** (#82). RSC type hardening + perf.
  `react-dom` paired.
- **`pydantic` 2.13.3 → 2.13.4** (#74). `RootModel` core-metadata
  preservation fix; macOS linker-flag and libc bumps in
  `pydantic-core`.
- **`vitest` / `@vitest/ui` 4.1.5 → 4.1.6** (#82). Bug-fix release;
  deprecation of the `sequential` test API does not affect this repo
  (no usage in `app/vitest.config.ts` or any test file).
- **`lucide-react` 1.11.0 → 1.14.0** (#82). Additive icons
  (`repeat-off`, `waves-vertical`, `astroid`, `folder-bookmark`).
- **`@types/node` 24.12.2 → 24.12.4** (#82). Types only.

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
- **Auto-backup-on-start** is end-to-end wired but lacks regression tests
  on the start-time path.

[Unreleased]: https://github.com/tuirk/Kompl/compare/v0.3.2.1...HEAD
[0.3.2.1]: https://github.com/tuirk/Kompl/releases/tag/v0.3.2.1
[0.3.2]: https://github.com/tuirk/Kompl/releases/tag/v0.3.2
[0.2.2]: https://github.com/tuirk/Kompl/releases/tag/v0.2.2
[0.2.1]: https://github.com/tuirk/Kompl/releases/tag/v0.2.1
[0.2.0]: https://github.com/tuirk/Kompl/releases/tag/v0.2.0
[0.1.0]: https://github.com/tuirk/Kompl/releases/tag/v0.1.0
