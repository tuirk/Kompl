# Scorecard Deferred Alerts

Last audited: 2026-07-06.

This file tracks only Scorecard findings that are currently open or intentionally
deferred. Historical false-positive ledgers were pruned; GitHub code scanning
keeps the dismissed alert records.

## Current State

| Alert | Rule | Status | Disposition |
|---|---|---|---|
| #27 | `BranchProtectionID` | Open | Tracked solo-dev gap |
| #70 | `VulnerabilitiesID` | Open | Closes as Dependabot PRs merge; nltk ignored via `osv-scanner.toml` |
| #74 | `PinnedDependenciesID` | Deferred | Dismiss as `won't fix` |
| #75 | `PinnedDependenciesID` | Deferred | Dismiss as `won't fix` |

## #70 — Known Vulnerabilities (re-opened)

Alert #70 was fixed on 2026-06-07 (transformers/torch pinning) but re-triggered
as new advisories were published. As of 2026-07-06 it lists 16 vulnerability
IDs, which map 1:1 onto the open Dependabot alerts plus one PyPI-side duplicate:

| Dependency | IDs | Fix path |
|---|---|---|
| `undici` (app, prod) | 7 GHSAs | Dependabot PR bumping undici to 7.28.0 |
| `hono` (mcp-server, transitive) | 5 GHSAs | Dependabot PR bumping hono to >= 4.12.25 |
| `js-yaml` (cli, dev-only transitive) | GHSA-h67p-54hq-rp68 | Manual lockfile bump to 3.15.0 (no Dependabot PR for transitive npm deps) |
| `@babel/core` (cli, dev-only transitive) | GHSA-4x5r-pxfx-6jf8 | Manual lockfile bump to >= 7.29.6 |
| `nltk` (nlp-service, prod via rake-nltk) | GHSA-p4gq-832x-fm9v + PYSEC-2026-597 (same CVE-2026-12243) | **No fixed release exists** — ignored via `nlp-service/osv-scanner.toml` |

nltk rationale: the vulnerability is a percent-encoded path traversal in
`nltk.data.load()`/`find()` that requires an attacker-controlled resource name.
Kompl only reaches nltk through rake-nltk's `Rake()` in
`nlp-service/routers/extraction.py`, which loads the static `stopwords` and
`punkt_tab` corpora baked into the Docker image at build time; user text is
passed to `extract_keywords_from_text()`, never to `data.load()`. Dismiss the
matching Dependabot alert (#47) as "vulnerable code is not actually used".
Re-evaluate when nltk ships a release newer than 3.9.4.

## #74 / #75 — Pip Hash Pinning

Scorecard wants every `pip install` to use `--require-hashes` against a
hash-pinned lockfile.

Current findings:

| Alert | Location | Finding |
|---|---|---|
| #74 | `nlp-service/Dockerfile:46` | `pip install ... torch==2.6.0 --index-url <cpu>` |
| #75 | `.github/workflows/integration-test.yml:69` | CI parity install for `torch==2.6.0 --index-url <cpu>` |

Rationale for deferral:

- The NLP stack has a large transitive dependency surface through torch,
  sentence-transformers, spaCy, KeyBERT, RAKE, YAKE, and FastAPI.
- The CPU-only torch index is intentional; without it pip resolves CUDA wheels
  and the Docker image grows dramatically.
- Hash-pinning this stack would require `pip-compile --generate-hashes` churn
  across platform-specific wheels and would fight Dependabot's pip workflow.
- The practical risk is already reduced by direct version pins plus weekly
  Dependabot freshness checks.

Dismiss #74 and #75 as **won't fix** with this comment:

> Deferred by documented policy: pip hash-pinning across the ML stack is out of
> proportion to risk for this project. See docs/security/scorecard-deferred.md.

Re-evaluate if the Python dependency surface shrinks materially, torch is
removed, or Kompl moves from single-user/local deployment to hosted multi-tenant
infrastructure.

## #27 — Branch Protection

Scorecard wants:

- Branch protection settings apply to administrators
- Required approving review count >= 2
- Codeowners review required
- Last-push approval enabled

Required status checks are already configured on `main` (`unit-tests-app`,
`unit-tests-cli`, `unit-tests-nlp`, `integration-test`) with up-to-date branches
required. The remaining gaps are solo-maintainer constraints. Keep #27 open as
the tracked repo-policy TODO until a second maintainer joins.
