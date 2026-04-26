# Contributing to Kompl

Thanks for thinking about contributing. Kompl is a small open-source project maintained on a best-effort basis — every meaningful PR helps, and we'd rather get yours merged than find reasons to nitpick it.

This guide is intentionally short. If something here is unclear, open an issue or just ask.

## Looking for something to work on?

- **The "What's next" panel** in the bottom-left footer of the running Kompl app shows what we're planning to build but haven't yet. Examples include Google Drive and Notion connectors, image support via LLM vision, custom LLM provider support, and a Tauri tray app. Pick anything that catches your eye, expand on it, or use it as inspiration for your own idea.
- **GitHub issues** — anything labelled `good first issue` is a deliberately scoped entry point.
- **Bugs you hit yourself** — if you found it, you're already 80% of the way to fixing it.

If you're about to start something non-trivial, it helps to open an issue first so we can flag any conflicts or context you'd want before writing code.

## Dev setup

For installing and running Kompl locally, follow the [README](README.md). The repo layout once you're set up:

```
app/          — Next.js 16 frontend + API routes
cli/          — kompl CLI (TypeScript)
mcp-server/   — MCP server for Claude Code, Cursor, etc.
nlp-service/  — Python FastAPI service (compile pipeline, LLM client)
n8n/          — Workflow JSONs for orchestration
scripts/      — Integration test harness, demos
```

### Running tests

```bash
# App tests (Vitest)
cd app && npm test

# CLI tests (Jest)
cd cli && npm test

# NLP service tests (pytest)
cd nlp-service && python -m pytest
```

The integration test harness (`bash scripts/integration-test.sh`) is **destructive** — it runs `docker compose down -v` and wipes the local wiki. Run `kompl backup` first, or skip it unless you're explicitly testing the full pipeline.

### Building the MCP server

```bash
cd mcp-server && npm install && npm run build
```

## Commit style

We use [Conventional Commits](https://www.conventionalcommits.org/). Existing history follows this informally and we'd like new contributions to match:

- `feat: short description` — new feature
- `fix: short description` — bug fix
- `chore: short description` — maintenance, dependency bumps, tooling
- `docs: short description` — README, CONTRIBUTING, code comments
- `refactor: short description` — restructure without behavior change
- `test: short description` — adding or fixing tests

Scopes are optional but welcome: `fix(cli): rename --output flag`. Aim for a single sentence in the subject and a short body explaining *why* (not *what* — the diff already shows that).

## DCO sign-off — required

Every commit must include a `Signed-off-by` trailer certifying that you have the right to contribute the code. This is the [Developer Certificate of Origin](https://developercertificate.org/). Adding it is a one-liner:

```bash
git commit -s -m "feat: my new thing"
```

The `-s` flag appends `Signed-off-by: Your Name <your@email>` to the commit message automatically. To make `-s` your default for this repo:

```bash
git config alias.cs "commit -s"
# then use `git cs` instead of `git commit`
```

We run an automated DCO check on every PR. If a commit is missing the sign-off, the check fails and the PR can't merge. The fix is a one-line rebase:

```bash
git rebase HEAD~N --signoff && git push --force-with-lease
```

(Where `N` is the number of commits in your branch.)

We don't require a CLA. The DCO is enough.

## PR flow

1. Fork the repo, create a branch, write your changes.
2. Sign off every commit (`-s` flag).
3. Make sure tests pass locally.
4. Open a PR with a short description of what you changed and why.
5. CI runs (unit + integration tests) plus the DCO check.
6. We review. Iteration is normal — we'll tell you what would unblock the merge.
7. We merge.

Smaller PRs are easier to review and ship faster. If your idea is bigger than ~300 lines of diff, please open an issue first.

## Code of conduct

By contributing, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md) (Contributor Covenant 2.1). Be kind. Assume good intent. If something feels off, see [SECURITY.md](SECURITY.md) for the private reporting channel — it covers conduct concerns too.

## License

By submitting a PR you agree your contribution is licensed under [Apache-2.0](LICENSE), same as the rest of the project.

---

Thanks again. We'll get back to you as fast as we can.
