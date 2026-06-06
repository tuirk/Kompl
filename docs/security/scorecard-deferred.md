# Scorecard Deferred Alerts

Last audited: 2026-06-07.

This file tracks only Scorecard findings that are currently open or intentionally
deferred. Historical false-positive ledgers were pruned; GitHub code scanning
keeps the dismissed alert records.

## Current State

| Alert | Rule | Status | Disposition |
|---|---|---|---|
| #27 | `BranchProtectionID` | Open | Tracked solo-dev gap |
| #74 | `PinnedDependenciesID` | Deferred | Dismiss as `won't fix` |
| #75 | `PinnedDependenciesID` | Deferred | Dismiss as `won't fix` |

Alert #70 (`VulnerabilitiesID`) is fixed as of 2026-06-07 by exact-pinning
`transformers==5.9.0` with `torch==2.6.0` CPU.

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
