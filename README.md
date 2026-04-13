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

The script handles everything: creates your config, asks for the two API keys, installs the `kompl` CLI, and starts the stack. No other steps needed.

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
kompl status     # health check + page count
kompl logs       # stream logs if something looks wrong
kompl update     # pull latest version and restart
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

To restore on a fresh instance: run setup, skip onboarding, go to **Settings → Import Wiki**, upload the `.kompl.zip`. All pages are immediately browsable and searchable.
