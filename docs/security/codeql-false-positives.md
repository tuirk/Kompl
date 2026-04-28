# CodeQL false-positive audit

Last audited: 2026-04-28 — after commit 6978be2 closed the original 22 alerts.

CodeQL re-flagged 17 alerts that look like the originals but are actually false
positives. Its taint trackers (`py/path-injection`, `js/path-injection`,
`py/incomplete-url-substring-sanitization`) cannot follow our cross-function
sanitizer chain and re-fire at every sink that consumes a validated path.

We dismiss them in the GitHub UI rather than silencing them in CodeQL config so
that any genuinely new sink in these files surfaces for review.

## The sanitizer chain

Two sanitizers gate every user-controlled path operation in nlp-service:

1. **`validate_page_id(page_id)` / `validate_source_id(source_id)`** at
   `nlp-service/services/_safe_paths.py:22-29`.
   Regex: `^[a-z0-9](?:[a-z0-9_-]{0,79})$`. Rejects all `.`, `/`, `\`, NUL,
   whitespace, and Unicode. Length-bounded to 1–80 ASCII chars.

2. **`safe_join(base, user_path)`** at `nlp-service/services/_safe_paths.py:32-52`.
   Computes `(base / user_path).resolve(strict=False).relative_to(base.resolve())`.
   `Path.relative_to()` raises `ValueError` on escape, caught and converted to
   `path_escape`. CodeQL recognises this as a path-injection sanitizer barrier
   *within a single function* but does not propagate the result across function
   boundaries.

The TypeScript equivalent is **`assertSafeId(id, kind)`** at
`app/src/lib/safe-paths.ts`. Same regex, throws `TypeError` on mismatch.

## Per-alert disposition

| # | File:Line | Sanitizer that runs first |
|---|---|---|
| 2 | file_store.py:69 | `validate_page_id` (60) + `safe_join` (63) |
| 4 | file_store.py:72 | Same as #2 (previous_path from `safe_join` at 71) |
| 5 | file_store.py:72 | Same as #2 |
| 6 | file_store.py:84 | `current_path` validated (63); `tmp_path` from `tempfile.mkstemp(dir=_PAGES_DIR)` is system-generated and inside `_PAGES_DIR` by construction |
| 7 | file_store.py:99 | `validate_page_id` (97) + `safe_join` (98) |
| 9 | conversion.py:463 | `safe_join(_DATA_ROOT, req.file_path)` (459) |
| 11 | storage.py:147 | `_safe_path` → `safe_join` (37) |
| 12 | storage.py:150 | Same as #11 |
| 13 | storage.py:162 | Same as #11 |
| 14 | storage.py:163 | Same as #11 |
| 15 | storage.py:180 | Same as #11 |
| 21 | db.ts:223 | `assertSafeId` inside `rawFilePath` (194); URL-param routes also short-circuit on `getSource()` returning null |
| 22 | db.ts:224 | Same as #21 |
| 24 | _safe_paths.py:43 | `relative_to` (48) — three lines later, in same function |
| 25 | _safe_paths.py:45 | Same as #24 |
| 26 | file_store.py:70 | `validate_page_id` (60) + `safe_join` (63) |

**Special case — `_safe_paths.py:43, 45`:** these are inside the sanitizer
itself. The `Path.resolve(strict=False)` calls are followed by
`relative_to(base_resolved)` three lines later. No sink (open/read/write/stat
of contents) runs between them — only metadata operations during symlink
resolution, which stay inside the function. CodeQL flags any `.resolve()` of
user-controlled string regardless of immediate downstream containment.

## Test alert #23 — `test_metadata_peek.py:223`

Rule: `py/incomplete-url-substring-sanitization`.

Flagged statement: `assert "http://safe.test/" in seen_urls`. `seen_urls` is a
`list[str]` (test fixture, populated by the `_validate` mock at line ~196).
The `in` operator performs list-membership equality, not substring matching on
a URL. CodeQL's heuristic misfires on "URL-shaped string + `in` operator".

## Bypass attempts

The /investigate skill ran on each alert with five bypass categories:

- **Regex tricks** — `..`, `/`, `\`, NUL, percent-encoding, Unicode confusables
  → all rejected by the byte-level character class.
- **Absolute paths** — `/etc/passwd`, `C:\Windows\...` → caught by `relative_to`.
- **Traversal** — `../`, `subdir/../escape`, deep traversal → caught by
  `relative_to` after `resolve()` normalises the path.
- **Symlinks** — `/data/foo` → `/etc/passwd` → resolve follows, relative_to
  catches.
- **TOCTOU between resolve() and relative_to()** — no syscall between them,
  same Path object; not exploitable.

All blocked.

## Why we do not silence these in CodeQL config

A `query-filters` exclude in `.github/codeql/codeql-config.yml` would suppress
these specific alerts in future runs. We chose dismissal-with-note instead so
that any **new** sink added to these files (or the sanitizer changing shape)
re-triggers the alert and forces a fresh review. The cost is one-time
dismissal effort; the benefit is preserved audit signal.

## Re-audit triggers

Re-run /investigate against this list if any of the following changes:

- The regex in `_safe_paths.py:18-19` is loosened (e.g., adds `.`, `/`, or
  uppercase).
- `safe_join` no longer calls `relative_to`.
- A new sink is introduced in a file listed above and CodeQL flags it.
- `assertSafeId` regex in `app/src/lib/safe-paths.ts` is loosened.

## See also

- Commit `6978be2` — original path-traversal hardening (closes alerts #2-#15,
  #21, #22 from the first scan).
- Commit `e5305cd` — SSRF hardening with IP-pinning.
- `docs/security/launch-readiness.md` (planned) — full audit report and the
  remaining launch-blocker items for always-on deployments.
