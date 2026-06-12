# AGENTS.md — Kompl operator guide

**For AI agents helping a user install, update, and use Kompl.**

Use [README.md](README.md) as the source of truth for prerequisites, install, day-to-day commands, updating, backup, MCP setup, data handling, security, and known limitations. Install path: `projectDir` in `~/.kompl/config.json`.

## What Kompl does

Kompl is a **knowledge compiler** — it turns scattered links, files, and bookmarks into an interlinked wiki at ingest time (one source may update many pages). Synthesis and cross-linking happen when sources are **compiled**, not on every browse. It also ships a minimal chat interface with basic RAG over compiled pages; most users query via MCP or their own agent.

---

## Agent rules — wiki safety (read before any Docker command)

The user's wiki (SQLite DB, page files, vectors) lives on the Docker named volume **`kompl-data`**. **You can destroy their entire wiki with one flag.** Treat that as irreversible until they restore from a `.kompl.zip`.

### NEVER without explicit user confirmation

**Do not run, suggest, or script any of the following unless the user has explicitly confirmed in this conversation that they accept losing their wiki** (or are on a fresh throwaway install with nothing to lose):

| Command / action | Why it wipes data |
|------------------|-------------------|
| `docker compose down -v` | `-v` deletes named volumes including `kompl-data` |
| `docker volume rm …` / deleting `kompl-data` in Docker Desktop | Direct volume deletion |
| `bash scripts/integration-test.sh` | Runs `docker compose down -v` by design |
| Re-installing into a new clone **and** removing old volumes | Orphaned or replaced `kompl-data` |

If the user has **not** clearly said they want a full wipe, **stop and ask**. Do not imply these are routine cleanup steps.

### If a destructive action is going to happen anyway

When the user **has** explicitly ordered a wipe **or** you must run a destructive command for a stated reason:

1. **Run `kompl backup` first** — no exceptions.
2. Confirm the backup file exists (default: `~/.kompl/backups/kompl-backup.kompl.zip`, or `--output` path they chose).
3. Tell the user where the backup is **before** running the destructive command.
4. Only then proceed.

Do not skip backup because auto-backup-on-start exists — it is best-effort and may be stale. **Always take a fresh `kompl backup` immediately before wipe.**

### Safe by default (wiki preserved)

These do **not** remove `kompl-data`: `kompl update`, `kompl start`, `kompl stop`, `kompl restart`, `docker compose up --build -d` (no `-v`), `docker compose down` without `-v`. Still recommend `kompl backup` before major upgrades.

**Restore after wipe:** Settings → **Import Wiki** → upload `.kompl.zip`. See [README § Backup and restore](README.md#backup-and-restore).

---

## Update pitfall agents miss

`git pull` updates files on disk but **not** the running `app` / `nlp-service` Docker images. If the user pulled but does not see new UI, run **`kompl update`** (or `docker compose up --build -d`) — do not assume the feature is missing from `main`. Full steps: [README § Updating](README.md#updating).

---

## Troubleshooting (agent-specific)

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| New UI missing after `git pull` | Stale Docker image | `kompl update` — see [Updating](README.md#updating) |
| YouTube URL on Saved Links | Missing `YOUTUBE_API_KEY`, no captions, or transcript blocked | [README prerequisites](README.md#before-you-start) |
| `extract_llm_failed` on long PDFs (Gemini) | Known truncation — [issue #7](https://github.com/tuirk/Kompl/issues/7) | Switch to DeepSeek in Settings or split the source |
| Wiki gone | `down -v`, integration tests, or volume delete | Restore from `.kompl.zip`; you should not have run destructive commands without explicit confirmation + `kompl backup` |

For everything else: `kompl logs`, `kompl status`, and [README troubleshooting cues](README.md#after-setup).

---

## Querying the wiki (MCP)

Once Kompl is **running**, query the compiled wiki via the MCP server. Setup and tools: [README § Use with AI agents (MCP)](README.md#use-with-ai-agents-mcp).

---

## Changing Kompl source code

If the user wants to **modify [tuirk/Kompl](https://github.com/tuirk/Kompl)** (not just run an install), see [CONTRIBUTING.md](CONTRIBUTING.md). After pulling code changes, run `docker compose up --build -d` from **`projectDir`**.

**Never run `bash scripts/integration-test.sh` on the user's live wiki** without explicit confirmation and a fresh `kompl backup`.
