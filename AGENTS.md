# AGENTS.md — Kompl operator guide

**For AI agents helping a user install, update, and use Kompl.**

Use [README.md](README.md) as the source of truth for prerequisites, install, day-to-day commands, updating, backup, MCP setup, data handling, security, and known limitations. Install path: `projectDir` in `~/.kompl/config.json`.

## What is Kompl?

Kompl is a compounding LLM-wiki: it turns saved links, files, and bookmarks into an interlinked wiki **when each source arrives**, not when you ask later. For the full product description, see [README.md](README.md).

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

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **Kompl** (5789 symbols, 9852 relationships, 258 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/Kompl/context` | Codebase overview, check index freshness |
| `gitnexus://repo/Kompl/clusters` | All functional areas |
| `gitnexus://repo/Kompl/processes` | All execution flows |
| `gitnexus://repo/Kompl/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
