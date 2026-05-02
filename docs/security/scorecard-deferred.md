# Scorecard deferred-alerts audit

Last audited: 2026-05-02 — covers the 41 open alerts after commit 8672980
restored the Scorecard schedule. 2026-05-02 update: alert #27 status-check
gap closed in ruleset `main-protection` (id 15607385); 4 solo-dev sub-gaps
remain open by design.

OpenSSF Scorecard runs weekly via `.github/workflows/scorecard.yml`. This
file documents which alerts are dismissed, which are deferred with rationale,
and which remain open as tracked TODOs. Mirrors the format of
[codeql-false-positives.md](codeql-false-positives.md).

## Alert ledger after commit (post-pinning)

| Bucket | Count | Disposition |
|---|---|---|
| Pinned (closes on next Scorecard run) | 12 | Action SHA pins (×8) + container digests (×3) + `npm ci` (×1) |
| Dismissed in UI as false positive | 20 | `downloadThenRun` heuristic on `curl localhost \| python3 -c '<literal>'` |
| Dismissed in UI as won't-fix | 5 | Structural alerts inapplicable to a solo-dev / single-user model |
| Deferred with documented rationale | 3 | `pip` hash-pinning across the ML stack — out of proportion to risk |
| Tracked TODO | 1 | `BranchProtectionID` — partially actionable in repo settings |

Total: 41.

## Bucket A — false positives (20 alerts, dismissed)

**Rule:** `PinnedDependenciesID` / `downloadThenRun`.

Scorecard's heuristic flags any `curl ... | <interpreter>` shape as
"download remote code and run it." Every flagged line in this repo is the
same pattern:

```bash
curl -sf "http://localhost:3000/api/..." \
  | python3 -c '<literal one-liner that calls json.load(sys.stdin)>'
```

The piped data is JSON from the local Next.js test server, not executable
code. `python3 -c '<literal>'` runs a hard-coded one-liner with stdin as
data — never `eval`/`exec`s the stdin content.

| Alert | File:Line |
|---|---|
| 42 | scripts/demo-comparison-wiki.sh:46 |
| 43 | scripts/demo-live-phases.sh:50 |
| 44 | scripts/demo-match-triage-boardgames.sh:50 |
| 45 | scripts/integration-test.sh:431 |
| 46 | scripts/integration-test.sh:1036 |
| 47 | scripts/integration-test.sh:1059 |
| 48 | scripts/integration-test.sh:1083 |
| 49 | scripts/integration-test.sh:1188 |
| 50 | scripts/integration-test.sh:1627 |
| 51 | scripts/integration-test.sh:1652 |
| 52 | scripts/integration-test.sh:1676 |
| 53 | scripts/integration-test.sh:1826 |
| 54 | scripts/integration-test.sh:1859 |
| 55 | scripts/integration-test.sh:1969 |
| 56 | scripts/integration-test.sh:1978 |
| 57 | scripts/manual-alias-dossier-test.sh:55 |
| 58 | scripts/manual-dossier-cap-test.sh:53 |
| 59 | scripts/manual-draft-update-test.sh:61 |
| 60 | scripts/manual-match-triage-test.sh:62 |
| 61 | scripts/manual-split-session-test.sh:67 |

**Persistence:** dismissals stick across Scorecard re-runs.
`github/codeql-action/upload-sarif` auto-generates `partialFingerprints`
from line content when the SARIF doesn't include them (Scorecard does not
emit them). The dismissal sticks as long as the line content at that path
is unchanged.

## Bucket B — structural alerts (5 alerts, dismissed as won't-fix)

These check repo-level policy that does not apply to a solo-developer,
single-user product.

| Alert | Rule | Reason |
|---|---|---|
| 63 | CodeReviewID | "0/26 approved changesets" — solo dev, no PR-mediated review. Standard OSSF gap (see [scorecard issue #4036](https://github.com/ossf/scorecard/issues/4036)). |
| 64 | MaintainedID | "Repository created within 90 days" — auto-resolves at the 90-day mark; pure age check. |
| 65 | CIIBestPracticesID | OpenSSF best-practices badge is a separate manual workflow on bestpractices.coreinfrastructure.org. Out of scope. |
| 66 | FuzzingID | Kompl is a deterministic content compiler — no fuzz-target shape. Adding OSS-Fuzz is not justified. |
| 67 | SASTID | "0/9 commits checked with SAST" — CodeQL was added recently; older commits will never be retroactively scanned. Future commits count. |

## Bucket C — deferred (3 alerts, left open)

**Rule:** `PinnedDependenciesID` / `pipCommand`.

Scorecard wants every `pip install` to use `--require-hashes` against a
hash-pinned lockfile. The `nlp-service` Python stack has ~200 transitive
dependencies through torch, sentence-transformers, spaCy, KeyBERT, RAKE,
YAKE, and FastAPI. A hash-pinned `requirements.txt` would:

1. Conflict with the CPU-only torch index-url pin in
   [nlp-service/Dockerfile:33-44](../../nlp-service/Dockerfile#L33-L44).
   `--require-hashes` mode disallows mixed index sources without
   regenerating hashes for every CUDA-vs-CPU wheel variant.
2. Break Dependabot's `pip` ecosystem auto-PRs (which assume
   non-hash-pinned input).
3. Require a `pip-compile --generate-hashes` regeneration on every
   single dependency bump — high churn, high break risk on
   platform-specific wheels.

The risk these alerts surface is "an upstream version is replaced
mid-release" — already mitigated by version pinning in `requirements.txt`
and weekly Dependabot freshness checks. Hash-pinning is a marginal
improvement at disproportionate maintenance cost for this project.

| Alert | File:Line |
|---|---|
| 40 | nlp-service/Dockerfile:44 — `pip install ... torch==2.5.1 --index-url <cpu>` |
| 41 | nlp-service/Dockerfile:46 — `pip install -r requirements.txt` |
| 62 | .github/workflows/integration-test.yml:67 — `pip install -r requirements.txt` |

Re-evaluate when:
- Migrating to a Railway / always-on deployment (supply-chain risk profile changes for hosted infra).
- Upstream PyPI compromise affects any pinned dependency.
- The pip dependency surface shrinks below ~30 transitive deps.

## Bucket D — tracked TODO (1 alert, left open)

**Alert 27 — `BranchProtectionID`.**

Scorecard wants:
- Branch protection settings apply to administrators ✗ (solo admin)
- Required approving review count ≥ 2 ✗ (solo dev)
- Codeowners review required ✗ (solo dev)
- Last-push approval enabled ✗ (no second reviewer)
- Required status checks present ✓ (added 2026-05-02)

**Status:** required-status-checks rule added to ruleset `main-protection`
(id 15607385) on 2026-05-02 with contexts `unit-tests-app`,
`unit-tests-cli`, `unit-tests-nlp`, `integration-test` and
`strict_required_status_checks_policy: true` (require branches up to date
before merging). Admin bypass remains enabled, so this never deadlocks a
solo-merge if CI breaks. Sub-gaps now down from 5 → 4. Branch-protection
sub-score remained 5/10 — Tier 2 structural failures (admins-bypass,
2-reviewer, codeowners, last-push) cap the score regardless of Tier 3
fixes. Scorecard composite stays ~5.9 until a second maintainer joins.
Real-world value of the change is the actual enforcement (status checks
must pass + branch must be current), not the score number.

## Re-audit triggers

Re-run /full-pipeline against this list if any of the following changes:

- A new `curl ... | <interpreter>` line is added that is **not** a
  `localhost` JSON parse — re-evaluate Bucket A scope.
- The `nlp-service` Python dependency surface shrinks meaningfully
  (e.g., torch is removed) — re-evaluate Bucket C.
- A second maintainer joins the project — re-evaluate Buckets B and D
  (codeowners, review counts, last-push approval all become satisfiable).

## See also

- [codeql-false-positives.md](codeql-false-positives.md) — companion
  audit for CodeQL alerts.
- `.github/dependabot.yml` — weekly bumps for npm, pip, github-actions,
  and docker ecosystems (this is what keeps pinned digests fresh).
- `.github/workflows/scorecard.yml` — the Scorecard workflow itself, with
  its own actions already SHA-pinned.
