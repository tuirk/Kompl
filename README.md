# Kompl

Turn scattered bookmarks, docs, and articles into a living wiki — automatically. Paste a URL, Kompl scrapes it, extracts knowledge, and updates your wiki. One source can touch 10–15 pages.

## Before you start

Install these two things:

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) — download, install, and make sure it's **running** before setup
- [Node.js](https://nodejs.org/) ≥ 18

You'll also need two API keys — both are free to get:

| | Get key | Free tier |
|---|---|---|
| **Gemini** (wiki compilation) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | 1500 req/day |
| **Firecrawl** (URL scraping) | [firecrawl.dev](https://firecrawl.dev) | 500 scrapes/month |

---

## Setup

```bash
git clone <repo-url> kompl
cd kompl
node setup.js
```

The script handles everything: creates your config, asks for the two API keys, installs the `kompl` CLI, and starts the stack. No other steps needed. Your system timezone is detected and written to `.env` as `KOMPL_TIMEZONE` automatically.

During setup you'll be asked how this instance is running: **personal device** (laptop/desktop that may be off) or **always-on server** (VPS, Railway, Raspberry Pi). This controls how scheduled jobs — lint, digest, and local backup — are triggered. Personal-device mode fires them on `kompl start` so nothing is skipped if your machine was off at the scheduled time; always-on mode relies on n8n's built-in cron schedule.

> **First start takes 5–10 minutes** — Docker is building images and downloading the local AI model. Make a coffee. Subsequent starts take ~15 seconds.

---

## After setup

Check when it's ready:

```bash
kompl status
```

Then open in your browser:

```bash
kompl open
```

The onboarding wizard will walk you through connecting your first sources.

---

## Day-to-day

```bash
kompl start      # start Kompl
kompl stop       # stop it
kompl open       # open in browser
kompl status     # health check: page count, NLP service, vector backlog
kompl logs       # stream logs if something looks wrong
kompl update     # pull latest version and restart
kompl backup     # download a full backup to ~/.kompl/backups/kompl-backup.kompl.zip
```

---

## Use with Claude Code or Claude Desktop

Kompl ships an MCP server that lets AI assistants search and read your wiki while you work. Once set up, you can ask Claude "what does my wiki say about X?" and it will query your compiled knowledge directly.

**Claude Code** — the `.mcp.json` in the repo root auto-registers it. Build once, then it's available in every Claude Code session:

```bash
cd mcp-server && npm install && npm run build
```

**Claude Desktop (Windows)** — add the server to `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "kompl-wiki": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/kompl/mcp-server/dist/index.js"],
      "env": { "KOMPL_URL": "http://localhost:3000" }
    }
  }
}
```

**Claude Desktop (Mac)** — same config at `~/Library/Application Support/Claude/claude_desktop_config.json`.

Kompl must be running (`kompl start`) for the MCP tools to respond. The server exposes four tools: `search_wiki`, `read_page`, `list_pages`, `wiki_stats`.

---

## Your data

Everything is stored in Docker volumes on your machine — nothing is sent anywhere except the two API calls (Gemini for wiki compilation, Firecrawl for scraping URLs). Chat can run fully locally via the built-in Ollama model with no API key.

---

## Backup and restore

Go to **Settings → Kompl Backup** to download a `.kompl.zip` that contains your entire wiki: all sources, compiled pages, provenance, extractions, and settings (Telegram credentials excluded). No LLM calls needed to restore.

To include your search index (embeddings) in the backup — so related-pages works immediately after restore without any re-processing — enable **Include vectors** before downloading. This adds ~a few MB to the ZIP depending on wiki size.

To restore on a fresh instance: run setup, skip onboarding, go to **Settings → Import Wiki**, upload the `.kompl.zip`. All pages are immediately browsable and searchable. If the ZIP includes vectors, they are restored directly; otherwise the search index is rebuilt automatically in the background.

**Automatic backup (personal-device mode)** — if you chose personal-device mode during setup, `kompl start` automatically saves a local backup to `~/.kompl/backups/kompl-backup.kompl.zip` (at most once every 36 hours, so it won't run on every start if you restart frequently). The Settings page shows when the last backup ran.

**CLI backup** — `kompl backup` downloads the same export without opening a browser:

```bash
kompl backup                        # save to ~/.kompl/backups/kompl-backup.kompl.zip (overwrites)
kompl backup --output ~/Desktop/my-wiki.kompl.zip   # save to a custom path
kompl backup --schedule             # register a Windows Task Scheduler entry (Monday 11:30, local timezone)
```

`--schedule` is idempotent and requires admin. The task uses `StartWhenAvailable`, so if your laptop was off at 11:30 it runs on the next login instead of being skipped.
