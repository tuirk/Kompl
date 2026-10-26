# AGENTS.md — helping someone set up and run Kompl

**For AI agents (Claude Code, Codex, Cursor, Gemini CLI and others) helping a user
install, run, update or connect Kompl from this repo.**

[README.md](README.md) is the source of truth for every step. This file adds the
rules and pitfalls agents most often get wrong.

## What Kompl is

Kompl turns saved links, files and bookmarks into an interlinked wiki **when each
source arrives**, not when someone asks later. It runs locally as a Docker stack:
the app at `http://localhost:3000`, an NLP service and n8n. The user's wiki
lives on the Docker volume **`kompl-data`**, and the `kompl` CLI starts, stops,
updates and backs it up. Once installed, the repo path is `projectDir` in
`~/.kompl/config.json`.

---

## Installing

Needs Docker running, Node.js 24+, about 5 GB of disk and 4 GB of free RAM, a
Firecrawl key and a DeepSeek or Gemini key (YouTube is optional). See
[README § Quick start](README.md#quick-start) and
[README § API keys](README.md#api-keys).

`node setup.js` from the repo root asks for the API keys, writes `.env`,
installs the `kompl` CLI, builds the MCP server and starts the stack. It
prompts interactively, so in a shell that can't answer prompts:

1. Copy `.env.example` to `.env`.
2. Ask the user to paste their keys into `.env` **themselves**. Keys should not
   pass through your conversation, and `.env` must never be committed or shared.
3. Run `node setup.js`. With `FIRECRAWL_API_KEY` and one of `DEEPSEEK_API_KEY` /
   `GEMINI_API_KEY` already set, it skips the prompts.

The first start takes 5–10 minutes while Docker builds the images. Run
`kompl status` until the app is healthy, then `kompl open`.

---

## Wiki safety (read before any Docker command)

**One flag can delete the user's entire wiki** (database, pages and search
index). Treat that as irreversible unless they have a `.kompl.zip` backup.

### Never without explicit confirmation

Do not run, suggest or script any of these unless the user has said in this
conversation that they accept losing their wiki, or the install is a fresh one
with nothing to lose:

| Command / action | Why it wipes data |
|------------------|-------------------|
| `docker compose down -v` | `-v` deletes the volumes, including `kompl-data` |
| `docker volume rm …` / deleting `kompl-data` in Docker Desktop | Deletes the volume directly |
| `bash scripts/integration-test.sh` | A developer test that runs `docker compose down -v` by design |
| Reinstalling into a new clone **and** removing old volumes | Replaces or orphans `kompl-data` |

If they haven't clearly asked for a wipe, **stop and ask**. Never present these
as routine cleanup.

### If a wipe is going to happen anyway

1. **Run `kompl backup` first**, every time. The automatic backup on
   `kompl start` may be up to 36 hours old.
2. Check that the file exists (default `~/.kompl/backups/kompl-backup.kompl.zip`,
   or the `--output` path).
3. Tell the user where it is **before** running the destructive command.

### Safe (the wiki is kept)

`kompl start`, `kompl stop`, `kompl restart`, `kompl update`,
`docker compose up --build -d` and `docker compose down` without `-v`.
Restore a backup under **Settings → Backup & restore → Import wiki**
([README § Backup and restore](README.md#backup-and-restore)).

---

## Updating

`git pull` changes the files on disk but **not** the running images, so new
features don't appear until the images are rebuilt. Use **`kompl update`**: it
pulls, rebuilds and restarts, and keeps the wiki. Don't conclude a feature is
missing because it isn't visible after a pull. See
[README § Updating](README.md#updating).

---

## Connecting the user's agent to their wiki (MCP)

Kompl has no built-in chat; the user asks their wiki through an AI agent over
MCP. Once Kompl is running, register the server. For Claude Code:

```bash
claude mcp add --scope user kompl-wiki -- node <projectDir>/mcp-server/dist/index.js
```

Codex, Claude Desktop, Cursor, VS Code, Gemini CLI, Pi and Hermes are covered in
[README § Ask your wiki from your AI (MCP)](README.md#ask-your-wiki-from-your-ai-mcp).

- Kompl must be running (`kompl start`) for the tools to answer.
- After `kompl update`, restart the agent so it loads the rebuilt server.
- `add_source` is the only tool that changes the wiki. It is **off** until the
  user turns on *Let AI agents add sources* in **Settings → Connect your AI**.
  Each addition starts a compile, which uses their LLM key and counts toward
  their daily spend cap. Don't turn it on for them; let the user decide.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| New UI missing after `git pull` | Images not rebuilt | `kompl update` |
| MCP tools say Kompl isn't reachable | Kompl stopped, or `KOMPL_URL` points elsewhere | `kompl start`; `KOMPL_URL` defaults to `http://localhost:3000` |
| Agent still shows old MCP tools | Agent loaded the server before the update | Restart the agent |
| YouTube URL lands on Saved Links | No `YOUTUBE_API_KEY`, or the video has no captions | Add the key to `.env` ([README § API keys](README.md#api-keys)) |
| Extraction fails on long sources with a Gemini 2.5 model | Upstream Gemini 2.5 repetition bug ([issue #7](https://github.com/tuirk/Kompl/issues/7)) | Switch the compile model in **Settings → AI model & spend** |
| Wiki gone | `down -v`, the integration test, or a deleted volume | Restore the latest `.kompl.zip` |
| Every request answers `403 unknown_host` | Kompl is reached by a host name it doesn't know (a reverse proxy, `host.docker.internal`) | Add the name to `KOMPL_ALLOWED_HOSTS` in `.env`, then `kompl restart` |

For anything else: `kompl status`, `kompl logs` and
[README § Everyday use](README.md#everyday-use).

---

## Changing Kompl's code

If the user wants to modify Kompl itself rather than run it, see
[CONTRIBUTING.md](CONTRIBUTING.md). After code changes, rebuild with
`docker compose up --build -d` from `projectDir`, or `kompl update` for pulled
changes. Never run `bash scripts/integration-test.sh` against a wiki the user
cares about.
