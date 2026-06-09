<p align="center">
  <img src="docs/assets/kompl-banner.png" alt="Kompl" width="800">
</p>

# Kompl

Knowledge compiler — turns scattered links, files, and bookmarks into a living wiki that compounds with every new source.

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![CI](https://github.com/tuirk/Kompl/actions/workflows/integration-test.yml/badge.svg)](https://github.com/tuirk/Kompl/actions)
[![Docker](https://img.shields.io/badge/Docker-Compose_Ready-2496ED?logo=docker&logoColor=white)](docker-compose.yml)
[![LLM](https://img.shields.io/badge/LLM-Gemini_%2B_DeepSeek-8E75B2)]()
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/tuirk/Kompl/badge)](https://scorecard.dev/viewer/?uri=github.com/tuirk/Kompl)

## Why Kompl?

Most tools save your stuff and forget about it. Kompl reads it, extracts the knowledge, and compiles it into an interlinked wiki, automatically.

- One new source can update 10+ wiki pages. Cross-references, contradictions, and synthesis are built at ingest time, not re-discovered on every query.
- Entity pages, concept pages, comparisons, and source summaries are wikilinked together. The wiki gets richer with every source you add.
- Runs locally via Docker. Outbound calls are limited to your own API keys (Gemini and/or DeepSeek for compilation, Firecrawl for scraping) and the URLs you choose to ingest.

Built with Next.js, Python NLP, n8n orchestration, and SQLite.

![Kompl Wiki](docs/assets/kompl-demo.gif)

## Before you start

You'll need three things on your machine:

- **Docker** — [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows/Mac) or [Docker Engine + Compose plugin](https://docs.docker.com/engine/install/) (Linux). Compose v2 is required (`docker compose`, not `docker-compose`). Make sure Docker is **running** before setup.
- **[Node.js](https://nodejs.org/) ≥ 24** — to install and run the `kompl` CLI.
- **~5 GB free disk and 4 GB free RAM** — Kompl runs three containers (app, NLP service, n8n) plus pulls a ~90 MB embedding model on first compile.

You'll also need API keys. Two are required, two are optional:

| | Required? | Get key | Free tier | Notes |
|---|---|---|---|---|
| **Gemini** (wiki compilation) | Required | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | 1500 req/day | Free works for the demo and your first few sources. **Paid Tier 1 is strongly recommended for real use** — Gemini's free per-minute throttle (~10 RPM) will rate-limit a normal ingest, even though daily quota is plenty. Default rate-limiter assumes Tier 1. Has a known truncation issue on dense inputs — see [issue #7](https://github.com/tuirk/Kompl/issues/7). |
| **Firecrawl** (URL scraping) | Required | [firecrawl.dev](https://firecrawl.dev) | 500 scrapes/month | Free tier covers normal personal use. |
| **YouTube Data API v3** (YouTube ingestion) | Optional | [console.cloud.google.com](https://console.cloud.google.com/apis/library/youtube.googleapis.com) | 10,000 units/day (1 unit per video) | Required to ingest YouTube URLs — without it, every YouTube URL hard-fails and routes to Saved Links. Restrict the key to "YouTube Data API v3" only in the GCP console. Set `YOUTUBE_API_KEY` in `.env`. |
| **DeepSeek V4 Pro** (alternative compile backend) | Optional | [api-docs.deepseek.com](https://api-docs.deepseek.com) | Pay-as-you-go | Selectable in Settings as an alternative to Gemini. Recommended for long/academic content — see [Known limitations](#known-limitations). Set `DEEPSEEK_API_KEY` in `.env`. |

## Setup

### Quick install (recommended)

**macOS / Linux / WSL / Git Bash:**

```bash
curl -fsSL https://raw.githubusercontent.com/tuirk/Kompl/main/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/tuirk/Kompl/main/install.ps1 | iex
```

The installer pre-flights Docker, Node 24, disk, and RAM, clones the repo, and hands off to `setup.js` for the API-key prompts. If anything's missing it fails fast with a copy-paste fix.

Prefer to inspect the script before running it? Download with `curl -fsSLO` (or `iwr -OutFile` on PowerShell), open it in your editor, then run with `bash install.sh` (or `.\install.ps1`).

### Manual install

```bash
git clone https://github.com/tuirk/Kompl.git kompl
cd kompl
node setup.js
```

Either path: the script handles everything — creates your config, asks for the two required API keys (and offers prompts for the two optional ones), installs the `kompl` CLI, and starts the stack. No other steps needed. Your system timezone is detected and written to `.env` as `KOMPL_TIMEZONE` automatically.

> Your API keys land in `.env` at the repo root. That file is gitignored — never commit it.

> **First start takes 5–10 minutes** — Docker is building images (~2 GB on first start) and downloading the local AI model from HuggingFace. Make a coffee. Subsequent starts take ~15 seconds.

## After setup

Check when it's ready:

```bash
kompl status
```

Then open in your browser:

```bash
kompl open
```

Or visit [http://localhost:3000](http://localhost:3000) directly.

The onboarding wizard will walk you through your first sources — paste a URL, drop a PDF, or import a Twitter bookmark export.

![Onboarding wizard](docs/assets/onboard.png)

If something looks stuck:

```bash
kompl logs       # stream service logs
kompl status     # health check
```

Common first-run issues: Docker isn't running, port 3000 is occupied, or the first-time image build is still pulling (~2 GB).

## Day-to-day

```bash
kompl start      # start Kompl
kompl stop       # stop it
kompl restart    # stop + start in one command
kompl open       # open in browser
kompl status     # health check: page count, NLP service, vector backlog
kompl logs       # stream logs if something looks wrong
kompl update     # pull latest version and restart
kompl backup     # download a full backup to ~/.kompl/backups/kompl-backup.kompl.zip
kompl init       # re-run the first-time setup wizard (rarely needed)
```

## Use with AI agents (MCP)

Kompl ships an MCP server so any MCP-capable agent — Claude Code, Claude Desktop, Cursor, or a custom client built on `@modelcontextprotocol/sdk` — can query your compiled wiki. Ask *"what does my wiki say about X?"* and the agent gets pre-synthesized pages with provenance back to the originals, not raw chunks.

> ⚠ **Single-tenant.** Kompl assumes you own the host. There's no multi-user auth — don't expose your instance to the public internet without putting your own auth in front.

### Build the MCP server

```bash
cd mcp-server && npm install && npm run build
```

Kompl must be running (`kompl start`) for the MCP tools to respond.

### Claude Code

Create `.mcp.json` in the repo root with:

```json
{
  "mcpServers": {
    "kompl-wiki": {
      "type": "stdio",
      "command": "node",
      "args": ["mcp-server/dist/index.js"],
      "env": { "KOMPL_URL": "http://localhost:3000" }
    }
  }
}
```

Claude Code picks it up automatically next session. Try: *"search my wiki for [topic]"* or *"read the relevant page from my wiki for [topic]."*

### Claude Desktop

| OS | Config file |
|---|---|
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux | `~/.config/Claude/claude_desktop_config.json` (no official Linux release; convention if a build is available) |

Add the same `mcpServers` block as above, but with the **absolute** path to `mcp-server/dist/index.js` instead of relative.

### Tools

The server exposes four: `search_wiki`, `read_page`, `list_pages`, `wiki_stats`.

### Non-MCP / direct HTTP

If you're not using an MCP client, hit the Next.js routes directly: `/api/pages/search`, `/api/wiki/{page_id}/data`, `/api/wiki/index`.

## Your data

Your wiki content lives in Docker volumes on your machine. Outbound network calls fall into three buckets:

**You drive these — your content goes to a third party:**
- **Gemini** (`generativelanguage.googleapis.com`) — wiki compilation when the Gemini backend is selected. Your source text is sent to Google.
- **DeepSeek** (`api.deepseek.com`) — wiki compilation when the DeepSeek backend is selected. Your source text is sent to DeepSeek. Only outbound if `DEEPSEEK_API_KEY` is configured and selected as the compile model.
- **Firecrawl** (`api.firecrawl.dev`) — URL scraping fallback. The URL you pasted is sent to Firecrawl.
- **GitHub public API** (`api.github.com`) — when you paste a GitHub repo URL, Kompl fetches the README + metadata.
- **YouTube** (`youtube.com` + `youtube.googleapis.com`) — when you paste a YouTube URL, transcripts are fetched via the public captions endpoint and metadata (title, channel, duration) via YouTube Data API v3. Requires `YOUTUBE_API_KEY`; without it, YouTube URLs route to Saved Links.
- **OG-tag preview** — pasted URLs are fetched once with `User-Agent: KomplBot/1.0` to grab title + description.

**One-time, on first use:**
- **HuggingFace Hub** (`huggingface.co`) — ~90 MB download of the `all-MiniLM-L6-v2` embedding model on the first compile. After that, no further HF traffic.

**Build-time only:** Docker image builds pull from PyPI, npm, Docker Hub, and apt mirrors. No runtime impact.

Kompl itself sends no analytics, no error reports, and no version pings. The bundled n8n container's upstream telemetry, version checks, templates, and personalization are disabled by default in `docker-compose.yml`.

## Backup and restore

Settings → **Kompl Backup** downloads a `.kompl.zip` containing your entire wiki: sources, compiled pages, provenance, extractions, and settings. API keys and third-party secrets are excluded. No LLM calls needed to restore.

To restore on a fresh instance: run setup, skip onboarding, go to Settings → **Import Wiki**, upload the `.kompl.zip`. All pages are immediately browsable and searchable. The search index rebuilds in the background after restore.

### Automatic backup

`kompl start` automatically saves a local backup to `~/.kompl/backups/kompl-backup.kompl.zip` (at most once every 36 hours).

> *⚠️ Auto-backup-on-start is an early feature, wired end-to-end but lacking regression tests on the start-time path. Flag any silent skips.*

### CLI backup

```bash
kompl backup                                          # save to ~/.kompl/backups/kompl-backup.kompl.zip (overwrites)
kompl backup --output ~/Desktop/my-wiki.kompl.zip     # save to a custom path
kompl backup --schedule                               # register a weekly backup schedule (Monday 11:30)
```

`--schedule` is idempotent. Platform-specific behavior:

- **Windows** — registers a Task Scheduler entry (requires Admin). `StartWhenAvailable` means it runs on next login if the laptop was off at 11:30.
- **Linux** — appends a crontab entry (`30 11 * * 1 kompl backup`) for the current user. Standard cron does not catch up if the machine was off.
- **macOS** — uses crontab, same as Linux. Same caveat applies (cron does not catch up if the machine was off). *Tested on Windows and Linux only — please [open an issue](https://github.com/tuirk/Kompl/issues) if you hit anything weird on Mac.*

## Heads up

**⚠️ Integration tests wipe the database.** `bash scripts/integration-test.sh` is destructive — it resets everything. Never run it on a wiki you want to keep. Use `kompl backup` first.

**Known limitations:**
- Single-tenant only — no user accounts or access control. Don't expose to the public internet without your own auth layer.
- Two LLM providers selectable per session: Gemini 2.5 (default) and DeepSeek V4 Pro. Anthropic and OpenAI-compatible providers are planned.
- **Gemini 2.5 + dense sources:** structured-output truncation on inputs above ~50K chars (commonly academic PDFs and surveys) causes `extract_llm_failed`. Workaround: switch the session to DeepSeek V4 Pro in Settings — it handles up to ~200K chars cleanly without this pathology. Kompl does **not** auto-chunk long sources; if you'd rather stay on Gemini, split the source into smaller files yourself before ingesting. Tracked in [issue #7](https://github.com/tuirk/Kompl/issues/7).
- **Current connectors:** URLs (YouTube transcripts and GitHub READMEs included), file uploads (PDF, DOCX, PPTX, XLSX, TXT, MD, HTML), browser bookmarks, Twitter JSON export, Upnote, Apple Notes.
- No mobile app. The web UI works on mobile browsers but isn't optimized for small screens.

## Security

Kompl runs on a personal computer behind a loopback or LAN. The security posture is calibrated for that model.

**Hardening shipped (4-commit security pass, April 2026):**
- SSRF protection on `/metadata/peek` — DNS-resolved IP pinning via httpx `sni_hostname` extension, scheme allowlist, cloud-metadata blocklist, manual redirect revalidation.
- Path-traversal hardening across nlp-service and Next.js — regex-validated IDs (`^[a-z0-9](?:[a-z0-9_-]{0,79})$`) + `Path.resolve().relative_to()` containment.
- Centralized YAML frontmatter escaping with C0/C1/U+2028/U+2029/BOM stripping.
- Log-forging protection on compile pipeline log lines.
- nlp-service port bound to `127.0.0.1` so the LAN cannot bypass the Next.js front door.

**Known security debt:**
- Markdown HTML output is not yet sanitized — Firecrawl-scraped content can carry XSS payloads. Even on a single-user install, an ingested bookmark can deliver a payload; needs DOMPurify in the render pipeline.
- `/convert/url` does not yet share the SSRF gate that protects `/metadata/peek`.

**CodeQL alerts.** Some `py/path-injection` and `js/path-injection` alerts re-fire on every push because CodeQL's taint tracker doesn't follow cross-function sanitizers. We dismiss these individually (rather than silencing in CodeQL config) so any genuinely new sink in those files surfaces for review. The audit trail and per-alert reasoning live at [docs/security/codeql-false-positives.md](docs/security/codeql-false-positives.md).

**Reporting an issue.** If you find something, please open a GitHub Security Advisory rather than a public issue.

## License

Kompl's source is **Apache-2.0** — see [LICENSE](LICENSE). You can use, modify, fork, and redistribute it freely under those terms.

**One caveat about the bundled n8n container.** Kompl runs `n8nio/n8n` as an unmodified runtime dependency for workflow orchestration. n8n itself is licensed under the [Sustainable Use License](https://docs.n8n.io/sustainable-use-license/), which is **not OSI-approved**. In practice:

- Self-hosting Kompl for personal or internal use → fully fine.
- Forking and redistributing Kompl source → fine (Apache-2.0 covers Kompl; n8n is a runtime dep users pull themselves).
- Offering **Kompl-as-a-hosted-service to third parties** → this is the line. n8n's SUL restricts hosting n8n as a service for others; if your offering bundles n8n, contact n8n first.

See [NOTICE](NOTICE) for full attribution.
