# Scorecard Deferred Alerts

Last audited: 2026-07-26.

This file tracks only Scorecard findings that are currently open or intentionally
deferred. Historical false-positive ledgers were pruned; GitHub code scanning
keeps the dismissed alert records.

## Current State

| Alert | Rule | Status | Disposition |
|---|---|---|---|
| #27 | `BranchProtectionID` | Dismissed (`won't fix`) | Tracked solo-dev gap |
| #70 | `VulnerabilitiesID` | Dismissed (`false positive`) | GHSA range falsely flags patched brace-expansion 1.x/2.x |
| #74 | `PinnedDependenciesID` | Deferred | Dismiss as `won't fix` |
| #75 | `PinnedDependenciesID` | Deferred | Dismiss as `won't fix` |
| #90 | `PinnedDependenciesID` | Deferred | Dismiss as `won't fix` (integration-test harness) |
| #91 | `PinnedDependenciesID` | Deferred | Dismiss as `won't fix` (integration-test harness) |

## #70 — GHSA-mh99-v99m-4gvg (brace-expansion)

Scorecard reported GHSA-mh99-v99m-4gvg (DoS via unbounded expansion length).
The advisory lists a single range `<= 5.0.7` with `first_patched_version: 5.0.8`.

As of 2026-07-26 the GitHub dependency SBOM and lockfiles contain **no**
`brace-expansion` 5.x. Resolved versions are only:

- `1.1.16` (cli override `brace-expansion@1`)
- `2.1.2` (cli override `brace-expansion@2`)

Both `1.1.16` and `2.1.2` already ship `EXPANSION_MAX_LENGTH` (the same bound
introduced on the 5.x line in `5.0.8`). `5.0.7` does not. Scorecard's matcher
treats any version `<= 5.0.7` as vulnerable, so it falsely flags the already-
patched 1.x/2.x lines. Dependabot open alerts for this GHSA: **0**.

Defensive floor for a future 5.x pull: `cli/package.json` override
`brace-expansion@5: 5.0.8`. Re-open if a real unpatched 5.x (or missing
`EXPANSION_MAX_LENGTH` on 1.x/2.x) appears in the SBOM.

## #90 / #91 — Integration-test `downloadThenRun`

Scorecard flags `curl … | python3 -c …` patterns in
`scripts/integration-test.sh` (localhost compile progress / session polling)
as unpinned `downloadThenRun`.

These are CI harness helpers talking to `localhost:3000`, not production
supply-chain downloads. Pinning by hash is out of proportion; dismiss as
**won't fix** with this comment:

> Deferred: downloadThenRun in scripts/integration-test.sh is CI localhost
> harness noise, not production supply-chain. Same class as prior
> PinnedDependencies deferrals. See docs/security/scorecard-deferred.md.

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
required. The remaining gaps are solo-maintainer constraints. Dismissed as
**won't fix** (2026-09-01) with this comment:

> Deferred solo-dev branch-protection gaps (admins not bound, 1 reviewer, no
> CODEOWNERS, no last-push approval). Required status checks already on main.
> Re-open when a second maintainer joins. See docs/security/scorecard-deferred.md.

Re-open the GitHub alert if a second maintainer joins.
