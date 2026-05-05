# Kompl v2 Multi-Provider LLM (Phase 1) — DeepSeek V4 Pro as second backend behind Settings dropdown

**Date:** 2026-05-05
**Status:** Active. Supersedes the streaming-detector mitigation plan (`~/.claude/plans/plan-the-streaming-detector-ancient-candle.md`, **never executed**, dropped after Stage C live-precision validation failed — issue #7). No prior commits to reference. Old draft lives outside the repo's `docs/plans/` and does not need deletion.
**Branch:** `feat/multi-provider-llm`

---

## North Star

Add DeepSeek V4 Pro as a second, operator-selectable LLM provider behind a Settings dropdown — Gemini stays the default, every existing extraction/lint/disambiguate/draft/synthesize/digest call site routes through a `LLMProvider` abstraction whose model→provider dispatch is locked in for an Anthropic Phase 2.

**Scope (in):** `nlp-service/services/providers/` (new package); refactor of `nlp-service/services/llm_client.py` from monolithic Gemini client to dispatcher; 7 system-prompt `"json"` trailers; conversion of 8 schema-bound call sites to `messages=[system, user]` shape; Settings UI dropdown expansion gated by `/api/health` provider-key flags; `docker-compose.yml` env wiring; `nlp-service/test_corpus/` end-to-end re-validation.

**Scope (out, hard):**
- Anthropic backend (Phase 2 — separate plan after this ships clean for ≥1 week)
- Streaming on either provider (Stage C precision validation failed — does not return without a different approach; the deleted repetition-detector code stays deleted)
- Halved-input fallback for DeepSeek (Gemini-bug-specific rationale doesn't apply)
- Provider-specific prompt overlays beyond the minimum (`"json"` trailer + inlined JSON-format hint only; one shared core prompt)
- Migrating non-LLM call sites
- Onboarding-flow strictness changes (key probing limited to `/api/health`)
- Schema migration (`compile_model`/`chat_model` columns already accept any string)
- Renaming the `GEMINI_*` env vars to `LLM_*` — operator-facing breaking change, deferred

**Operating constraints:**
- Single-writer SQLite rule (CLAUDE.md #1) — no DB access in providers, only HTTP through Next.js
- Strict service boundaries (CLAUDE.md #2) — Pydantic `extra='forbid'` on FastAPI surfaces, no bare `dict`, no `||` fallbacks
- LLM-per-item expansion loops keep their hard iteration cap + feature flag (CLAUDE.md #7) — not relaxed for DeepSeek
- Single-key constraint per operator: dropdown is "operator picks one provider per session," not a fallback chain
- Per-session model lock (CLAUDE.md gotcha) — mid-session Settings changes never hot-swap; cancel + restart to switch
- Daily LLM spend cap is dollar-denominated and shared across providers (the existing `/data/llm-cap.json`)
- DeepSeek RPM defaults conservatively to 60 (their documented per-minute cap); each provider owns its own pyrate-limiter bucket
- DeepSeek discount window: prices are 75% off through 2026-05-31T15:59:00Z; after that the code path takes list pricing automatically — no manual edit at deadline

---

## Execution drill for every phase

1. **Spec first:** write `docs/plans/phase_X_spec.md` before implementation (`phase_X_Y_spec.md` for sub-phases). Spec covers scope, data contracts, public API/tool/config changes, success criteria, out-of-scope items, safety constraints, test strategy.
2. **Tests first:** write failing tests, fixtures, or harness assertions against the spec before implementation. No implementation without a red test. For eval-only work, the red test is the fixture/harness expectation that proves the missing behavior.
3. **Implement:** smallest code/docs/config changes that make the tests pass. No scope creep. Helper work ships inside the phase that needs it, not as a detached cleanup track.
4. **Spec alignment review:** diff implementation against the phase spec, this plan, ROADMAP, eval docs, test-site docs, tool schemas, config docs, and touched skill/prompt contracts. Update docs or record explicit drift.
5. **Code quality review:** naming, dead code, abstractions, error boundaries, type coverage, lint/format, logging/observability, can-it-fail-safely.
6. **Final code review:** integration/eval checks green, no TODOs remain, docs updated, `gitnexus_detect_changes` reviewed, ready-to-merge recorded.

---

## What's already done — do not redo

| Capability | Source / Commit |
|---|---|
| Streaming code paths cleanup (no live streamer remains) | confirmed by inspection on `feat/multi-provider-llm` HEAD |
| Preserved validation corpus for side-by-side runs | `nlp-service/test_corpus/` — 7 sources + manifest |
| Per-session model lock infrastructure | `app/src/lib/db.ts:1447` `getEffectiveCompileModel()`; `compile_progress.compile_model` column already accepts arbitrary string (migration v20) |
| `_salvage_extraction` is provider-agnostic and stays at the dispatch layer | `nlp-service/services/llm_client.py:446` |
| `httpx` already pinned in nlp-service (no new pip dependency for DeepSeek HTTP client) | `nlp-service/requirements.txt:6` `httpx==0.28.1` |
| Empirical 28-call spike validates DeepSeek V4 Pro on our exact prompt shape | 28/28 ok, 0 parse failures, 0 salvage attempts, including 95K-char Open Standards source — see plan Context |

---

## Context — multi-provider LLM

### Decision rationale — why DeepSeek V4 Pro and not the alternatives

| Option | Verdict | Reason |
|---|---|---|
| **DeepSeek V4 Pro (`deepseek-v4-pro`)** | **Default pick for second provider** | Empirical 28-call spike at `max_tokens=16000` on our exact prompt shape: 28/28 ok, 0 parse failures, 0 salvage attempts. Cleanly extracts the 95K-char Open Standards source that Gemini cannot. OpenAI-compatible HTTP API → `httpx` already pinned, no new dep. Discount window 75% off through 2026-05-31T15:59:00Z, list still cheaper than Gemini Flash on equivalent calls. |
| Gemini 3.x family | Stay on 2.5 default; do not promote 3.x as alternative | Same upstream sampler-bug pathology that breaks 2.5 Flash on `temperature=0.0` + `response_schema=PydanticClass` now also reproduces on 3.x in our internal repro. New provider, not new Gemini SKU, is the answer. |
| Streaming-detector mitigation (prior plan) | Rejected | Stage C live precision validation failed: legitimate JSON enumerations (`mentions: ["Vilnius", ...]`, `entities: [{"name":"…"}, ...]`) are indistinguishable from sampler loops at the detector's level — two intrinsic FP modes that re-tuning cannot eliminate. Gemini's streaming endpoint has its own truncation bug too (Vilnius source: 3K tokens non-streamed → 1.5K streamed, same prompt). Two stacking upstream bugs. |
| Anthropic (Claude family) | Deferred to Phase 2 | Out of scope for this plan. The `gemini-*` / `deepseek-*` model-prefix dispatch in `providers/__init__.py` is pre-committed to `anthropic-*`, so Phase 2 adds one provider class + one `__init__.py` factory entry + one `CHAT_MODELS` row + one optgroup. No structural rework. |
| `openai` Python SDK as DeepSeek client | Avoid | Adds a new pip dependency for a small call surface we can hit directly via the already-pinned `httpx`. The conversion service already proves `httpx` is sufficient. |
| Floating DeepSeek model aliases (`deepseek-chat`, `deepseek-reasoner`) | Avoid in dropdown | The thinking-on/off split is already driven by per-call-site `thinking_budgets` in `/data/llm-config.json` (default values at `app/src/lib/db.ts:2589-2600`); exposing two pseudo-models would split cost/quality reasoning across two knobs that mean the same thing. Single explicit pin `deepseek-v4-pro` only. |

### Quirks that bite when adding DeepSeek as a second provider

| # | Trap | File:line where it bites | Fix in phase |
|---|---|---|---|
| 1 | DeepSeek `response_format={"type":"json_object"}` requires the literal word `"json"` somewhere in the prompt — silently degrades to free-form text otherwise | 7 system prompts in `nlp-service/services/llm_client.py` (`:490, :634, :864, :882, :1269, :1519, :1616`) | Phase 1 |
| 2 | DeepSeek's `reasoning_effort` field is an enum `{disabled, low, medium, high, max}`, not the integer `thinking_budget` Gemini expects. Same ask, different shape. | new `nlp-service/services/providers/__init__.py` `translate_thinking_budget()` | Phase 4 |
| 3 | Gemini's `usage_metadata` field names (`prompt_token_count`, `candidates_token_count`, `cached_content_token_count`, `thoughts_token_count`) are NOT what DeepSeek returns (`prompt_tokens`, `completion_tokens`, `prompt_cache_hit_tokens`). Wrong field names silently zero out cost. | `_record_usage` at `nlp-service/services/llm_client.py:297` (Gemini-specific) and new equivalent in `providers/deepseek.py` | Phase 2 + Phase 4 |
| 4 | Many call sites today concatenate system+user into one prompt string instead of using `messages=[system, user]`, e.g. `nlp-service/services/llm_client.py:537, :702, :1559`. Both providers cache better with `messages` shape; DeepSeek handles JSON-mode reliably only with explicit roles. | All 8 schema-bound call sites in `nlp-service/services/llm_client.py` | Phase 3 |
| 5 | `docker-compose.yml` only substitutes `.env` into `environment:` blocks that explicitly name the var — adding `process.env.DEEPSEEK_API_KEY` reads in Node code without an `app.environment:` entry results in `undefined` at runtime, not a crash | `docker-compose.yml` `app.environment` (~line 45) AND `nlp-service.environment` (~line 80); regression-guarded by `scripts/integration-test.sh` Stage 1 env loop | Phase 5 |
| 6 | DeepSeek's documented per-minute cap is 60 RPM — ours-default `_GEMINI_RPM=800` would 13× burst over DeepSeek's bucket. Each provider must own its own rate limiter. | new `providers/deepseek.py` (`DEEPSEEK_RPM` env, default 60) | Phase 4 |
| 7 | Existing `_salvage_extraction` at `nlp-service/services/llm_client.py:446` works on raw JSON text — already provider-agnostic. Do not duplicate it inside providers, do not move it. | `nlp-service/services/llm_client.py:446` (keep) | Phase 2 (verify it stays at dispatcher layer) |
| 8 | Per-session lock: a session locked to `deepseek-v4-pro` will hard-fail mid-run if operator removes `DEEPSEEK_API_KEY`; lifespan check is per-process, not per-call. Documented operator-facing footgun. | `app/src/lib/db.ts:1447` `getEffectiveCompileModel()` resolves the lock | Phase 6 (UI tooltip) |
| 9 | `_DEFAULT_MODEL = "gemini-2.5-flash"` at `nlp-service/services/llm_client.py:121` is the safety-net default when a call site forgets to pass `model`. Real call sites all pass it from the per-session lock; do not casually rename it (it is the historical hardcode). | `nlp-service/services/llm_client.py:121` | not touched |
| 10 | `_thinking_cache` at `nlp-service/services/llm_client.py:183` is 30s; a newly-set provider key takes up to 30s to be picked up via `/data/llm-config.json` reads | `nlp-service/services/llm_client.py:183` | not touched (acceptable per CLAUDE.md gotcha pattern) |
| 11 | Gemini system_instruction parameter is already used at `:1333` and `:1487`. Six other schema-bound call sites still concatenate. Do not assume system_instruction works — verify per-call-site. | `nlp-service/services/llm_client.py` all 8 schema-bound sites | Phase 3 |
| 12 | DeepSeek discount window expires at a hardcoded UTC instant; a wall-clock comparison in `deepseek.py` flips to list pricing automatically — but only if the container clock is UTC. Docker containers default to UTC; verify at deploy. | new `providers/deepseek.py` `DISCOUNT_UNTIL` constant | Phase 4 |

### File-touch matrix

| File | Change | Phase | Why |
|---|---|---|---|
| `nlp-service/services/llm_client.py:490, :634, :864, :882, :1269, :1519, :1616` | Append `"json"` trailer to 7 system prompts | Phase 1 | DeepSeek json_object mode requires the keyword; Gemini ignores it |
| `nlp-service/services/providers/__init__.py` (NEW) | `get_provider(model)` factory; `translate_thinking_budget()` helper | Phase 2 | Single source of truth for model→provider dispatch and the thinking-budget shape difference |
| `nlp-service/services/providers/base.py` (NEW) | `LLMProvider` Protocol; `LLMRequest`/`LLMResult` dataclasses; `ProviderError` hierarchy | Phase 2 | Normalised return shape so dispatch layer is provider-agnostic |
| `nlp-service/services/providers/gemini.py` (NEW) | `GeminiProvider`: client construction, `_with_retry` with `_genai_errors.APIError`, `_record_usage` on Gemini fields, `_log_usage`, `_was_truncated` MAX_TOKENS check, `_MODEL_PRICES` for `gemini-*`, `ThinkingConfig` mapping | Phase 2 | Behaviour-preserving extract from `nlp-service/services/llm_client.py:62, :89-116, :297-443, :471-483` |
| `nlp-service/services/providers/test_providers.py` (NEW) | pytest unit tests: factory dispatch, JSON-format injection, reasoning_effort translation, price-discount boundary, retry semantics | Phase 2 + Phase 4 | Six-gate "tests first" |
| `nlp-service/services/llm_client.py:62, :89-116, :297-443, :471-483, :325-336` | Move Gemini-specific helpers into `providers/gemini.py`; module shrinks from 1794 → ~1100 lines | Phase 2 | One file = one responsibility (skill section 7) |
| `nlp-service/services/llm_client.py:287, :217` | Generalise `"Daily Gemini spend limit"` error message and the docstring `"daily Gemini $ cap"` to `"Daily LLM spend"` / `"daily LLM $ cap"` | Phase 2 | Per Risks table — the cap is dollar-denominated and shared across providers |
| `nlp-service/services/llm_client.py` 8 schema-bound call sites (incl. `:537, :702, :1559`) | Convert from concatenated prompt strings to `messages=[system, user]` shape | Phase 3 | Both providers cache better; DeepSeek json_object mode requires explicit roles. Quirk #4. |
| `nlp-service/services/llm_client.py` (new constant) | Add `_DEEPSEEK_INPUT_CHAR_CAP = 200000` alongside `_GEMINI_EXTRACT_INPUT_CAP = 50000` (`:68`) | Phase 3 | Empirical: DeepSeek extracted clean from the 95K source; cap reflects that |
| `nlp-service/services/llm_client.py:793-838` | Skip halved-input fallback when provider is DeepSeek | Phase 3 | Halved-path rationale is Gemini-bug-specific; 28/28 spike says salvage covers the rare DeepSeek failure |
| `nlp-service/services/providers/deepseek.py` (NEW) | OpenAI-compatible `httpx` client targeting `https://api.deepseek.com`; `response_format={"type":"json_object"}`; `extra_body.thinking={type:enabled}`; `reasoning_effort` translation; retry on 408/429/5xx; usage parsing (`prompt_tokens`, `completion_tokens`, `prompt_cache_hit_tokens`); per-call cost with discount-window logic; own rate limiter at `DEEPSEEK_RPM` (default 60) | Phase 4 | Quirks #1, #2, #3, #6, #12 |
| `nlp-service/main.py:86` | `startup_check` warns if neither `GEMINI_API_KEY` nor `DEEPSEEK_API_KEY` is set; deprecated `@app.on_event("startup")` decorator stays in Phase 1 | Phase 5 | Operators discover misconfig at boot |
| `nlp-service/main.py:102` | `/health` response gains `provider_keys: {gemini: bool, deepseek: bool}` | Phase 5 | UI gating relies on this |
| `docker-compose.yml` `app.environment` (~line 45) AND `nlp-service.environment` (~line 80) | Add `DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY:-}` adjacent to existing `GEMINI_API_KEY` | Phase 5 | Quirk #5 |
| `docker-compose.yml` repo root `.env.example` (if exists) | Append `DEEPSEEK_API_KEY=` empty default + one-line comment with `https://api-docs.deepseek.com` | Phase 5 | Operator self-discovery |
| `scripts/integration-test.sh` Stage 1 env loop | Regression-guard `DEEPSEEK_API_KEY` alongside `GEMINI_API_KEY` and `FIRECRAWL_API_KEY` | Phase 5 | CLAUDE.md gotcha — every new `process.env.X` read needs a Stage 1 guard |
| `app/src/lib/db.ts:2530-2534` | Expand `CHAT_MODELS` const: add `'deepseek-v4-pro'` (single explicit pin, no floating aliases) | Phase 6 | Decision rationale — single SKU, not chat/reasoner split |
| `app/src/lib/db.ts` (new helper) | `getProviderForModel(m: string): 'gemini' | 'deepseek'` based on prefix | Phase 6 | UI uses this for optgroup placement |
| `app/src/app/api/settings/route.ts:228, :238` | Update error strings to list expanded model set (validation already routes through `isChatModel`) | Phase 6 | Fix follows from `CHAT_MODELS` expansion |
| `app/src/app/api/health/route.ts` | Extend response with `provider_keys: { gemini_present: !!process.env.GEMINI_API_KEY, deepseek_present: !!process.env.DEEPSEEK_API_KEY }` (presence-only; no outbound probe) | Phase 5 | UI gating |
| `app/src/app/settings/page.tsx:1095-1112, :1160-1177` | Restructure both `<select>` blocks with grouped `<optgroup label="Gemini">` and `<optgroup label="DeepSeek">`; DeepSeek option `disabled={!healthData?.provider_keys?.deepseek_present}` + `title=` tooltip | Phase 6 | Manual matrix walked in verification |
| `app/src/app/settings/page.tsx:1083-1092, :1152-1156` | Drop the word "Gemini" from copy ("Which model the compile pipeline uses…") | Phase 6 | Provider-neutral copy |

---

## Sub-agent execution rules

| Phase | Parallel? | Pattern |
|---|---|---|
| Phase 1 | No | Single-file mechanical change in `nlp-service/services/llm_client.py` (7 trailer appends). Coordination overhead exceeds time savings. |
| Phase 2 | No | Behaviour-preserving extract — every helper moves out of `llm_client.py` into `providers/gemini.py`. Single write set on `llm_client.py`. Sequential. |
| Phase 3 | No | All 8 schema-bound call sites converge on `llm_client.py`; sub-agent split would race the same file. Sequential. |
| Phase 4 | No | New `providers/deepseek.py` + new test file — could parallelise with Phase 5 in principle, but Phase 5's `main.py` `/health` change depends on Phase 4 having committed `DeepSeekProvider` class so the health check has a callable to import. Sequential. |
| Phase 5 | No | Wires `docker-compose.yml`, `main.py`, `scripts/integration-test.sh`, `app/src/app/api/health/route.ts`. Small disjoint files; sequential within one operator session is faster than the agent-handoff overhead. |
| Phase 6 | No | UI changes converge on `app/src/lib/db.ts` and `settings/page.tsx`. Manual matrix walked at the end requires a single coherent state. |
| Phase 7 | No | End-to-end revalidation against `test_corpus/` is one observation, not a parallelisable workload. |

**Honest answer to "should we use sub-agents":** Not advisable for execution. Phases 1–3 all converge on `nlp-service/services/llm_client.py`; Phase 6 converges on `app/src/lib/db.ts` + `settings/page.tsx`. The disjoint write-set discipline isn't satisfied for any phase boundary, and the verification gates (especially Phase 7 live re-validation) require a coherent checkpoint to compare against the spike baseline. Sub-agents likely *did* help during the planning phase (parallel research on DeepSeek API shape, pricing window math, prompt-trailer test); they will not help during execution.

**Execution invariant for every sub-agent:** (Reserved for the unlikely case a future plan parallelises off this one.)

1. Isolated git worktree — no shared filesystem changes.
2. Six-gate drill applies — spec first, tests first, minimal implementation, spec alignment review, code quality review, final code review.
3. `gitnexus_impact` before edits, `gitnexus_detect_changes` after.
4. Agent does NOT merge its branch — reports back, controller (human + Claude) reviews diff and merges.
5. Bounded file allowlist per agent — touching anything outside list = stop and report.

---

## What's left

### Phase 1 — Append `"json"` trailer to 7 system prompts (no other changes)

**Why:** DeepSeek json_object mode silently degrades to free-form text without the keyword (Quirk #1). Gemini ignores the trailer. Doing this first lets us run the existing nlp-service test suite against Gemini under the new prompts and isolate "trailer changed prompt behaviour" as a single variable before any abstraction churn begins.

**Depends on:** None.

**Status:** Not started.

**1.1** Append the exact trailer string `"\n\nReturn the response as a single json object matching the schema described above. Do not include any text outside the json."` to the 7 prompts at `nlp-service/services/llm_client.py:490, :634, :864, :882, :1269, :1519, :1616`.

**Why sequential, not parallel:** All 7 edits land in the same file.

#### Phase 1 — File structure

- Modify: `nlp-service/services/llm_client.py:490` — `_LINT_SYSTEM_PROMPT` trailer
- Modify: `nlp-service/services/llm_client.py:634` — `_EXTRACTION_SYSTEM_PROMPT` trailer
- Modify: `nlp-service/services/llm_client.py:864` — `_DISAMBIGUATION_SYSTEM_PROMPT` trailer
- Modify: `nlp-service/services/llm_client.py:882` — `_DISAMBIGUATION_CONCEPT_SYSTEM_PROMPT` trailer
- Modify: `nlp-service/services/llm_client.py:1269` — `_CROSSREF_SYSTEM_PROMPT` trailer
- Modify: `nlp-service/services/llm_client.py:1519` — `_SELECT_PAGES_SYSTEM_PROMPT` trailer
- Modify: `nlp-service/services/llm_client.py:1616` — `_SYNTHESIZE_SYSTEM_PROMPT` trailer
- Test: `nlp-service/tests/test_llm_client.py` — existing extract/lint/disambiguate fixtures (no new test, regression-only)

#### Phase 1 — Tasks

##### Task 1.1: Trailer constant + first prompt

**Files:**
- Modify: `nlp-service/services/llm_client.py:490`

- [ ] **Step 1: Add the trailer constant just below `_DEFAULT_MODEL`**

```python
_JSON_TRAILER = (
    "\n\nReturn the response as a single json object matching the schema "
    "described above. Do not include any text outside the json."
)
```

- [ ] **Step 2: Append to `_LINT_SYSTEM_PROMPT` at the constant declaration**

```python
_LINT_SYSTEM_PROMPT = """\
You are a wiki knowledge auditor. […existing body…]
""" + _JSON_TRAILER
```

- [ ] **Step 3: Run an existing lint test to verify the prompt still parses**

Run: `pytest nlp-service/tests/test_llm_client.py -k lint -v`
Expected: PASS (same coverage as before — the trailer is additive)

- [ ] **Step 4: Commit**

```bash
git add nlp-service/services/llm_client.py
git commit -m "feat(llm): add json trailer to lint system prompt"
```

##### Task 1.2: Apply trailer to remaining 6 prompts

**Files:**
- Modify: `nlp-service/services/llm_client.py:634, :864, :882, :1269, :1519, :1616`

- [ ] **Step 1: Append `+ _JSON_TRAILER` to each of the 6 remaining `_*_SYSTEM_PROMPT` constants**

Pattern (apply to all 6):
```python
_EXTRACTION_SYSTEM_PROMPT = """\
…existing body…
""" + _JSON_TRAILER
```

- [ ] **Step 2: Run the prompt-touching tests**

Run: `pytest nlp-service/tests/test_llm_client.py -k "extract or disambiguate or crossref or select_pages or synthesize" -v`
Expected: PASS

- [ ] **Step 3: Smoke-compile a known-good source from `nlp-service/test_corpus/`**

Run: `bash scripts/integration-test.sh --stage 4`
Expected: PASS — pages compile, JSON parses, no salvage attempts logged.

- [ ] **Step 4: Commit**

```bash
git add nlp-service/services/llm_client.py
git commit -m "feat(llm): append json trailer to remaining system prompts"
```

#### Phase 1 PR checklist

- [ ] **Spec first:** `docs/plans/phase_1_spec.md` exists and covers the trailer string, the 7 target prompts, why both providers tolerate it, and the no-behaviour-change-for-Gemini guarantee
- [ ] **Tests first:** existing `test_llm_client.py` fixtures touched by these prompts were green before the change and stay green after
- [ ] **Implement:** trailer added to exactly 7 prompts, no other edits in `llm_client.py`
- [ ] **Spec alignment review:** trailer text matches phase spec verbatim; no other prompt edits crept in
- [ ] **Code quality review:** single `_JSON_TRAILER` constant (DRY), no inline trailer duplication
- [ ] **Final code review:** `gitnexus_detect_changes` shows only the prompt-constant edits in `llm_client.py`; ready to merge

#### Phase 1 kickoff checklist

- [ ] 1.1 — `_JSON_TRAILER` constant added
- [ ] 1.1 — `_LINT_SYSTEM_PROMPT` trailer appended; lint test green
- [ ] 1.2 — remaining 6 prompts get trailer
- [ ] 1.2 — full prompt-touching test suite green
- [ ] 1.2 — `scripts/integration-test.sh --stage 4` passes
- [ ] One commit per task, both pushed; CI green

---

### Phase 2 — Build `providers/base.py` + `providers/__init__.py` + extract Gemini logic into `providers/gemini.py`

**Why:** The `LLMProvider` abstraction is what every Phase ≥3 work item assumes. Moving the Gemini-specific surface out of `llm_client.py` while keeping behaviour byte-for-byte equivalent isolates the abstraction churn from any semantic change. After this phase, `llm_client.py` becomes a thin dispatcher; helpers move to `providers/gemini.py`. CLAUDE.md gotcha lists 12+ Gemini call-parameter sites in this file — this phase consolidates them behind one provider class.

**Depends on:** Phase 1 (trailers landed — so the prompts that move into providers are already in their final form).

**Status:** Not started.

**2.1** Create `providers/base.py` with `LLMProvider` Protocol, `LLMRequest`/`LLMResult` dataclasses, `ProviderError` hierarchy.

**2.2** Create `providers/gemini.py` and move:
- `_GEMINI_RPM` (`:62`), `_get_limiter` (`:325-336`)
- `_MODEL_PRICES` (`:89-116`), `_get_model_prices` (`:105`)
- `_record_usage` (`:297`), `_log_usage` (`:396`), `_was_truncated` (`:425`)
- `_with_retry` (`:354-393`) — keeping `_APIError` import + `_RETRYABLE_STATUSES` (`:351`) co-located
- `get_client()` (`:477-483`) — provider class owns its lazy client
- `ThinkingConfig` mapping helpers used at the call sites

**2.3** Create `providers/__init__.py` with `get_provider(model: str) -> LLMProvider` factory and `translate_thinking_budget(provider, call_site) -> Any` helper. Prefix dispatch: `gemini-*` → `GeminiProvider`, `deepseek-*` → raises `NotImplementedError` for now (Phase 4 wires it).

**2.4** Generalise the cost-cap error message at `nlp-service/services/llm_client.py:287` from `"Daily Gemini spend limit"` to `"Daily LLM spend"`; update the docstring at `:217` similarly. (Per-call cost lookup now goes through the provider, not the global `_get_model_prices`.)

**2.5** Update `nlp-service/tests/test_llm_client.py` mocks: every `mocker.patch("…client.models.generate_content")` becomes `mocker.patch("…providers.gemini.GeminiProvider.complete")` (or whichever public method the Protocol exposes).

**Why sequential, not parallel:** Single write set on `llm_client.py` and the new package is created top-down (base → gemini → __init__).

#### Phase 2 — File structure

- Create: `nlp-service/services/providers/__init__.py` — `get_provider` factory + `translate_thinking_budget`
- Create: `nlp-service/services/providers/base.py` — `LLMProvider` Protocol + `LLMRequest` + `LLMResult` + `ProviderError` hierarchy
- Create: `nlp-service/services/providers/gemini.py` — Gemini-specific extract from `llm_client.py`
- Create: `nlp-service/services/providers/test_providers.py` — pytest unit: factory dispatch (gemini-* OK, deepseek-* raises NotImplementedError, anthropic-* raises ValueError), price lookup
- Modify: `nlp-service/services/llm_client.py:62, :89-116, :217, :287, :297-443, :471-483, :325-336` — remove the moved sections, generalise cost-cap message
- Modify: `nlp-service/tests/test_llm_client.py` — repoint mocks at provider class

#### Phase 2 — Tasks

##### Task 2.1: `providers/base.py` Protocol + dataclasses

**Files:**
- Create: `nlp-service/services/providers/base.py`

- [ ] **Step 1: Failing test in `test_providers.py` for `LLMRequest`/`LLMResult` shape**

```python
# nlp-service/services/providers/test_providers.py
from nlp_service.services.providers.base import LLMRequest, LLMResult, LLMProvider

def test_llm_request_minimal_shape():
    req = LLMRequest(
        model="gemini-2.5-flash",
        messages=[{"role": "system", "content": "hi"}, {"role": "user", "content": "ok"}],
        response_model=None,
        thinking_budget=0,
        max_output_tokens=2048,
        temperature=0.0,
        step="test_step",
    )
    assert req.model == "gemini-2.5-flash"

def test_llm_result_carries_text_parsed_usage_finish():
    res = LLMResult(text="ok", parsed=None, usage={}, finish_reason="STOP")
    assert res.text == "ok"
```

- [ ] **Step 2: Run to verify FAIL (module doesn't exist)**

Run: `pytest nlp-service/services/providers/test_providers.py -v`
Expected: FAIL with `ModuleNotFoundError: providers`

- [ ] **Step 3: Write `base.py`**

```python
# nlp-service/services/providers/base.py
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Protocol
from pydantic import BaseModel


class ProviderError(Exception): pass
class ProviderRateLimitedError(ProviderError): pass
class ProviderTransientError(ProviderError): pass


@dataclass
class LLMRequest:
    model: str
    messages: list[dict[str, str]]
    response_model: type[BaseModel] | None
    thinking_budget: int
    max_output_tokens: int
    temperature: float
    step: str
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class LLMResult:
    text: str
    parsed: BaseModel | None
    usage: dict[str, int]
    finish_reason: str


class LLMProvider(Protocol):
    name: str
    def complete(self, req: LLMRequest) -> LLMResult: ...
    def cost_usd(self, model: str, usage: dict[str, int]) -> float: ...
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `pytest nlp-service/services/providers/test_providers.py -v`
Expected: PASS — both shape tests

- [ ] **Step 5: Commit**

```bash
git add nlp-service/services/providers/__init__.py nlp-service/services/providers/base.py nlp-service/services/providers/test_providers.py
git commit -m "feat(llm): add provider Protocol + LLMRequest/Result dataclasses"
```

##### Task 2.2: Move Gemini-specific helpers into `providers/gemini.py`

**Files:**
- Create: `nlp-service/services/providers/gemini.py`
- Modify: `nlp-service/services/llm_client.py:62, :89-116, :297-443, :471-483, :325-336` (remove)

- [ ] **Step 1: Add a behaviour-equivalence test (RED)**

```python
# test_providers.py
def test_gemini_provider_log_usage_format(capsys, gemini_response_fixture):
    from nlp_service.services.providers.gemini import GeminiProvider
    p = GeminiProvider()
    p._log_usage("test_step", gemini_response_fixture)
    captured = capsys.readouterr()
    assert "[gemini] step=test_step finish=" in captured.err
```

Run: `pytest nlp-service/services/providers/test_providers.py::test_gemini_provider_log_usage_format -v` → FAIL (`gemini.py` doesn't exist).

- [ ] **Step 2: Create `providers/gemini.py` and copy** `_GEMINI_RPM`, `_get_limiter`, `_MODEL_PRICES`, `_get_model_prices`, `_log_usage`, `_record_usage`, `_was_truncated`, `_with_retry`, `_RETRYABLE_STATUSES`, `_APIError` import block, `get_client` from `llm_client.py` into a `GeminiProvider` class (former module-level functions become private methods or stay module-level if stateless and only Gemini uses them).

The `_log_usage` line `[gemini] step=…` stays Gemini-specific in the moved helper (the per-provider prefix is intentional — DeepSeek will emit `[deepseek] step=…` from its own equivalent helper).

- [ ] **Step 3: `GeminiProvider.complete()` adapter**

Method signature: `def complete(self, req: LLMRequest) -> LLMResult:` — translates `LLMRequest` to `genai.Client().models.generate_content(...)` call shape with `system_instruction` from `messages[0]["content"]` (when role=system) and `contents` from the user message; calls through `_with_retry`; reads `usage_metadata`; returns `LLMResult` with `parsed=req.response_model.model_validate_json(text)` if `req.response_model` else `parsed=None`.

- [ ] **Step 4: Run the equivalence test**

Run: `pytest nlp-service/services/providers/test_providers.py::test_gemini_provider_log_usage_format -v`
Expected: PASS

- [ ] **Step 5: Remove the moved code from `llm_client.py`**

Delete `:62, :89-116, :297-443, :471-483, :325-336` (the helper functions and constants now living in `gemini.py`). Keep `_DEFAULT_MODEL`, `_check_and_record_cost`, `_salvage_extraction`, `_read_thinking_budget`, all `_*_SYSTEM_PROMPT` constants, all 11 call sites.

- [ ] **Step 6: Replace each call site's direct `client.models.generate_content(...)` invocation with `provider = get_provider(model); provider.complete(LLMRequest(...))`**

(Defer the `messages=[system, user]` shape change to Phase 3 — for Phase 2, build `messages` from the existing system+user split as it stands today; no semantic change for Gemini.)

- [ ] **Step 7: Run the full nlp-service test suite**

Run: `pytest nlp-service/tests/ nlp-service/services/providers/ -v`
Expected: PASS — repointed mocks pass, behaviour-equivalence holds.

- [ ] **Step 8: Smoke compile**

Run: `bash scripts/integration-test.sh --stage 4`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add nlp-service/services/llm_client.py nlp-service/services/providers/gemini.py nlp-service/services/providers/test_providers.py nlp-service/tests/test_llm_client.py
git commit -m "refactor(llm): extract GeminiProvider into providers/gemini.py"
```

##### Task 2.3: `providers/__init__.py` factory + cost-cap message generalisation

**Files:**
- Create: `nlp-service/services/providers/__init__.py`
- Modify: `nlp-service/services/llm_client.py:217, :287`

- [ ] **Step 1: RED test for prefix dispatch**

```python
# test_providers.py
def test_get_provider_dispatches_by_prefix():
    from nlp_service.services.providers import get_provider
    from nlp_service.services.providers.gemini import GeminiProvider
    assert isinstance(get_provider("gemini-2.5-flash"), GeminiProvider)
    import pytest
    with pytest.raises(NotImplementedError):
        get_provider("deepseek-v4-pro")
    with pytest.raises(ValueError, match="unknown provider"):
        get_provider("anthropic-claude-4-7")
```

Run: `pytest …::test_get_provider_dispatches_by_prefix -v` → FAIL (factory not implemented).

- [ ] **Step 2: Implement factory**

```python
# nlp-service/services/providers/__init__.py
from .base import LLMProvider, LLMRequest, LLMResult, ProviderError, ProviderRateLimitedError, ProviderTransientError
from .gemini import GeminiProvider

_REGISTRY: dict[str, LLMProvider] = {}

def get_provider(model: str) -> LLMProvider:
    if model.startswith("gemini-"):
        return _REGISTRY.setdefault("gemini", GeminiProvider())
    if model.startswith("deepseek-"):
        raise NotImplementedError("DeepSeek provider lands in Phase 4")
    raise ValueError(f"unknown provider for model {model!r}")

def translate_thinking_budget(provider: str, call_site: str, raw: int) -> object:
    if provider == "gemini":
        return raw  # passthrough (int)
    if provider == "deepseek":
        if raw == 0:    return "disabled"
        if raw <= 1024: return "low"
        if raw <= 2048: return "medium"
        if raw <= 8192: return "high"
        return "max"
    raise ValueError(f"unknown provider {provider!r}")
```

- [ ] **Step 3: GREEN**

Run: `pytest nlp-service/services/providers/test_providers.py::test_get_provider_dispatches_by_prefix -v`
Expected: PASS

- [ ] **Step 4: Generalise cost-cap message**

Edit `nlp-service/services/llm_client.py:287`:
- old: `f"Daily Gemini spend limit (${daily_cap:.2f}) reached. "`
- new: `f"Daily LLM spend limit (${daily_cap:.2f}) reached. "`

Edit the surrounding docstring at `:217`:
- old: `daily Gemini $ cap`
- new: `daily LLM $ cap`

- [ ] **Step 5: Commit**

```bash
git add nlp-service/services/providers/__init__.py nlp-service/services/providers/test_providers.py nlp-service/services/llm_client.py
git commit -m "feat(llm): add provider factory + generalise cost-cap error to LLM"
```

#### Phase 2 PR checklist

- [ ] **Spec first:** `docs/plans/phase_2_spec.md` exists and covers the Protocol surface (`LLMRequest`/`LLMResult` fields), the line ranges that move out of `llm_client.py`, the no-behaviour-change-for-Gemini guarantee, and the test-mock repointing
- [ ] **Tests first:** `test_providers.py` shape and dispatch tests written and red before implementation
- [ ] **Implement:** `providers/base.py`, `providers/gemini.py`, `providers/__init__.py` exist; `llm_client.py` shrinks (~1100 lines from 1794); `_salvage_extraction` and `_check_and_record_cost` stay at dispatcher layer
- [ ] **Spec alignment review:** every helper named in the spec line range moved exactly to the named target file; cost-cap message updated to the exact spec string
- [ ] **Code quality review:** single source of truth for model→provider dispatch; `[gemini]` log prefix preserved in moved helper; `_thinking_cache` not duplicated
- [ ] **Final code review:** `gitnexus_detect_changes` shows the expected file scope; `pytest nlp-service/tests/ nlp-service/services/providers/` green; ready to merge

#### Phase 2 kickoff checklist

- [ ] 2.1 — `base.py` Protocol + dataclasses; shape tests green
- [ ] 2.2 — `gemini.py` houses Gemini helpers; behaviour-equivalence test green
- [ ] 2.2 — `llm_client.py` call sites use `get_provider().complete(LLMRequest)` shim; full test suite green; integration-test stage 4 green
- [ ] 2.3 — `__init__.py` factory; dispatch test green
- [ ] 2.3 — cost-cap error generalised; docstring updated
- [ ] One commit per task; CI green

---

### Phase 3 — Convert 8 schema-bound call sites to `messages=[system, user]` shape

**Why:** Both providers cache better with explicit roles; DeepSeek json_object mode requires it (Quirk #4); two of the 8 call sites already use `system_instruction` (`:1333`, `:1487`) so the pattern is proven. The other 6 today concatenate system+user into one prompt string (visible at `:537, :702, :1559`). Converting before the DeepSeek provider lands keeps "did the messages-shape change break Gemini" isolated as a single variable.

**Depends on:** Phase 2 (`LLMRequest.messages` shape exists).

**Status:** Not started.

**3.1** Convert all 8 schema-bound call sites in `nlp-service/services/llm_client.py` to construct `messages=[{"role":"system","content":<system_prompt>}, {"role":"user","content":<user_payload>}]`. The `GeminiProvider.complete()` adapter from Phase 2.2 already maps role=system → `system_instruction` parameter on the genai SDK call.

**3.2** Add `_DEEPSEEK_INPUT_CHAR_CAP = int(os.environ.get("DEEPSEEK_INPUT_CHAR_CAP", "200000"))` alongside `_GEMINI_EXTRACT_INPUT_CAP` at `:68`. Empirically warranted: DeepSeek extracted clean from the 95K source. The cap is read from `LLMRequest.extra["input_char_cap"]` or set at the call site based on `get_provider_for_model(model)` lookup.

**3.3** Skip the halved-input fallback path at `:793-838` when `provider_name == "deepseek"`. Wrap it in `if get_provider_for_model(model) == "gemini":` — the fallback's "different prompt path escapes the loop" rationale is Gemini-bug-specific.

**Why sequential, not parallel:** All 8 conversions land in the same file; halved-fallback skip is an `if`-gate at one site.

#### Phase 3 — File structure

- Modify: `nlp-service/services/llm_client.py` 8 schema-bound call sites (incl. `:537, :702, :1559`)
- Modify: `nlp-service/services/llm_client.py:68` — add `_DEEPSEEK_INPUT_CHAR_CAP`
- Modify: `nlp-service/services/llm_client.py:793-838` — gate halved-input fallback by provider
- Test: `nlp-service/tests/test_llm_client.py` — extend extract/lint tests to assert `messages` shape was passed through

#### Phase 3 — Tasks

##### Task 3.1: Convert all 8 schema-bound call sites

**Files:**
- Modify: `nlp-service/services/llm_client.py` (8 call sites)

- [ ] **Step 1: RED — assert messages shape at one call site**

```python
def test_extract_source_passes_messages_shape(mocker):
    captured = {}
    def fake_complete(self, req):
        captured["messages"] = req.messages
        from nlp_service.services.providers.base import LLMResult
        return LLMResult(text='{"items":[]}', parsed=None, usage={}, finish_reason="STOP")
    mocker.patch("nlp_service.services.providers.gemini.GeminiProvider.complete", fake_complete)
    from nlp_service.services.llm_client import extract_source
    extract_source("source text", page_id="p1", model="gemini-2.5-flash")
    assert captured["messages"][0]["role"] == "system"
    assert captured["messages"][1]["role"] == "user"
    assert captured["messages"][0]["content"].endswith("Do not include any text outside the json.")
```

Run: `pytest …::test_extract_source_passes_messages_shape -v` → FAIL (today the call site concatenates).

- [ ] **Step 2: GREEN — convert `extract_source` to messages shape**

At `:702` (and the other 7 schema-bound sites), replace the concatenated prompt build with:

```python
messages = [
    {"role": "system", "content": _EXTRACTION_SYSTEM_PROMPT},
    {"role": "user", "content": user_payload},
]
result = provider.complete(LLMRequest(
    model=model,
    messages=messages,
    response_model=LLMExtractionResponse,
    thinking_budget=_read_thinking_budget("extract"),
    max_output_tokens=32768,
    temperature=0.0,
    step="extract",
))
```

Repeat for `lint_scan` (`:537`), `disambiguate` (the two variants near the disambiguation prompts), `crossref` (`:1269` site), `select_pages` (`:1559`), `synthesize` (`:1616` site), and the remaining schema-bound site.

- [ ] **Step 3: Run the full test suite**

Run: `pytest nlp-service/tests/ nlp-service/services/providers/ -v`
Expected: PASS

- [ ] **Step 4: Diff JSON output against a recorded baseline from `nlp-service/test_corpus/`**

Pick one source, run `bash scripts/integration-test.sh --stage 4` end-to-end on Gemini. Compare the produced page JSON against a baseline saved to `validation/baseline/<source>.json` (or `/data/sv_results/` if the team prefers off-branch).

Tolerance: entity counts within ±10% of baseline (per Section 7 of the source spec). If not within tolerance, **stop and investigate** — likely a `system_instruction` regression at one of the 8 sites.

- [ ] **Step 5: Commit**

```bash
git add nlp-service/services/llm_client.py nlp-service/tests/test_llm_client.py
git commit -m "refactor(llm): use messages=[system,user] at all schema-bound call sites"
```

##### Task 3.2: Add `_DEEPSEEK_INPUT_CHAR_CAP` + gate halved-input fallback

**Files:**
- Modify: `nlp-service/services/llm_client.py:68, :793-838`

- [ ] **Step 1: RED — extract path uses 200K cap when provider is deepseek**

```python
def test_extract_uses_deepseek_cap_when_deepseek_model(mocker):
    captured = {}
    def fake_complete(self, req):
        captured["user_chars"] = len(req.messages[1]["content"])
        from nlp_service.services.providers.base import LLMResult
        return LLMResult(text='{"items":[]}', parsed=None, usage={}, finish_reason="STOP")
    # provider gets dispatched by model prefix; mock the deepseek provider class once Phase 4 lands
    # for now, mock get_provider directly
    ...
    extract_source("a" * 90000, page_id="p1", model="deepseek-v4-pro")
    assert captured["user_chars"] >= 80000  # not truncated to 50000
```

This test will compile after Phase 4 lands `DeepSeekProvider`. For Phase 3 in isolation, write the test so it XFAILs until Phase 4 — or stub the provider in the test fixture.

- [ ] **Step 2: GREEN — add the cap constant and use it**

```python
_DEEPSEEK_INPUT_CHAR_CAP = int(os.environ.get("DEEPSEEK_INPUT_CHAR_CAP", "200000"))

def _input_cap_for(model: str) -> int:
    if model.startswith("deepseek-"):
        return _DEEPSEEK_INPUT_CHAR_CAP
    return _GEMINI_EXTRACT_INPUT_CAP
```

At the extract truncation site, replace `_GEMINI_EXTRACT_INPUT_CAP` with `_input_cap_for(model)`.

- [ ] **Step 3: Gate halved-input fallback at `:793-838`**

Wrap the existing fallback block:

```python
if model.startswith("gemini-"):
    # existing halved-input retry path
    …
else:
    # DeepSeek path — _salvage_extraction handles the rare failure
    raise LLMCompileError(f"extract_failed: {e}") from e
```

- [ ] **Step 4: Commit**

```bash
git add nlp-service/services/llm_client.py
git commit -m "feat(llm): per-provider input-char cap and Gemini-only halved fallback"
```

#### Phase 3 PR checklist

- [ ] **Spec first:** `docs/plans/phase_3_spec.md` exists and lists the 8 schema-bound call sites by file:line + names + the exact `messages` shape, plus the per-provider input cap rule and halved-fallback gate
- [ ] **Tests first:** `test_extract_source_passes_messages_shape` (and equivalents per call site) red before implementation
- [ ] **Implement:** all 8 call sites converted; per-provider cap helper added; halved-fallback gated by `gemini-*` prefix
- [ ] **Spec alignment review:** baseline JSON diff within ±10% on entity counts; the 2 sites that already used `system_instruction` were not regressed
- [ ] **Code quality review:** no concatenated-prompt strings remain at any of the 8 sites; the `_input_cap_for` helper is used uniformly
- [ ] **Final code review:** `gitnexus_detect_changes` shows only `llm_client.py` + the test extension; CI green; ready to merge

#### Phase 3 kickoff checklist

- [ ] 3.1 — `messages` shape test added (RED)
- [ ] 3.1 — all 8 call sites converted (GREEN)
- [ ] 3.1 — baseline JSON diff within tolerance
- [ ] 3.2 — `_DEEPSEEK_INPUT_CHAR_CAP` + `_input_cap_for` helper added
- [ ] 3.2 — halved-fallback gated by `gemini-*` prefix
- [ ] One commit per task; CI green

---

### Phase 4 — Implement `providers/deepseek.py`

**Why:** This is the new code that the entire plan exists to add. Provider, retry, usage parsing, json_object mode, reasoning_effort translation, cost table with discount-window logic, own rate limiter at `DEEPSEEK_RPM`. Phases 1–3 set up the substrate; Phase 4 fills the second slot.

**Depends on:** Phase 2 (`LLMProvider` Protocol + factory exist), Phase 3 (`messages` shape used everywhere), Phase 1 (`"json"` trailer present).

**Status:** Not started.

**4.1** Implement `DeepSeekProvider` class in `providers/deepseek.py`: constructor reads `DEEPSEEK_API_KEY`, builds an `httpx.Client(base_url="https://api.deepseek.com")`; `complete()` posts to `/v1/chat/completions` with `model`, `messages`, `response_format={"type":"json_object"}` when `req.response_model is not None`, `extra_body.thinking={"type":"enabled"}` when `req.thinking_budget > 0`, `reasoning_effort` translated via the Phase 2.3 helper.

**4.2** Retry semantics: 408/429/500/502/503/504 with exponential backoff (mirror `_with_retry`), max 3 attempts, base delay 0.5s — own copy of `_RETRYABLE_STATUSES`. Rate limiter: in-process pyrate-limiter bucket at `DEEPSEEK_RPM` (env, default 60).

**4.3** Usage parsing: read `prompt_tokens`, `completion_tokens`, `prompt_cache_hit_tokens` from response; emit `[deepseek] step=… finish=… in=… out=… cache_hit=…` log line; record cost via the dispatcher's `_check_and_record_cost`.

**4.4** Cost computation with discount window. Constants:
```python
DISCOUNT_UNTIL = datetime(2026, 5, 31, 15, 59, 0, tzinfo=timezone.utc)
_DEEPSEEK_PRICES_DISCOUNT = {"input": 0.07, "output": 0.27, "cache": 0.014}
_DEEPSEEK_PRICES_LIST     = {"input": 0.27, "output": 1.10, "cache": 0.054}
```
With env overrides `DEEPSEEK_INPUT_USD_PER_M` / `DEEPSEEK_OUTPUT_USD_PER_M` / `DEEPSEEK_CACHE_USD_PER_M` taking precedence.

**4.5** Update `providers/__init__.py` factory: `deepseek-*` now returns `DeepSeekProvider()`.

**4.6** Unit tests in `test_providers.py`: factory dispatch (`deepseek-v4-pro` → `DeepSeekProvider`), JSON-format injection (assert request body has `response_format={"type":"json_object"}` when `response_model` is set), reasoning_effort translation (5 mapping cases), price-discount boundary (one second before `DISCOUNT_UNTIL` returns discount, one second after returns list), retry on 408/429/5xx (mocked `httpx`).

**4.7** Live smoke call: when `DEEPSEEK_API_KEY` is present, run one extract on a small fixture from `test_corpus/` and assert no salvage attempts logged.

**Why sequential, not parallel:** Single new file, single test extension; no parallel write surface.

#### Phase 4 — File structure

- Create: `nlp-service/services/providers/deepseek.py` — `DeepSeekProvider` class, retry, usage parsing, cost table
- Modify: `nlp-service/services/providers/__init__.py` — wire `deepseek-*` to `DeepSeekProvider`
- Modify: `nlp-service/services/providers/test_providers.py` — extend with DeepSeek-specific tests

#### Phase 4 — Tasks

##### Task 4.1: `DeepSeekProvider.complete()` happy path

**Files:**
- Create: `nlp-service/services/providers/deepseek.py`
- Modify: `nlp-service/services/providers/test_providers.py`

- [ ] **Step 1: RED — JSON-format injection test (mocked `httpx`)**

```python
def test_deepseek_complete_injects_json_response_format(mocker):
    from nlp_service.services.providers.deepseek import DeepSeekProvider
    from nlp_service.services.providers.base import LLMRequest
    from pydantic import BaseModel

    class Out(BaseModel):
        ok: bool

    captured = {}
    class FakeResp:
        status_code = 200
        def json(self):
            return {
                "choices": [{"message": {"content": '{"ok": true}'}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "prompt_cache_hit_tokens": 0},
            }
    def fake_post(self, url, json=None, **kw):
        captured["body"] = json
        return FakeResp()
    mocker.patch("httpx.Client.post", fake_post)

    p = DeepSeekProvider()
    req = LLMRequest(model="deepseek-v4-pro", messages=[{"role":"system","content":"… json …"},{"role":"user","content":"go"}], response_model=Out, thinking_budget=0, max_output_tokens=2048, temperature=0.0, step="t")
    res = p.complete(req)
    assert captured["body"]["response_format"] == {"type": "json_object"}
    assert res.parsed.ok is True
```

Run: `pytest …::test_deepseek_complete_injects_json_response_format -v` → FAIL.

- [ ] **Step 2: GREEN — minimal `DeepSeekProvider`**

```python
# nlp-service/services/providers/deepseek.py
from __future__ import annotations
import os, sys, time
from datetime import datetime, timezone
from typing import Any
import httpx
from pyrate_limiter import Duration, InMemoryBucket, Limiter, Rate
from .base import LLMProvider, LLMRequest, LLMResult, ProviderError, ProviderRateLimitedError

_DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "").strip()
_DEEPSEEK_RPM     = int(os.environ.get("DEEPSEEK_RPM", "60"))
_RETRYABLE_STATUSES = frozenset({408, 429, 500, 502, 503, 504})

DISCOUNT_UNTIL = datetime(2026, 5, 31, 15, 59, 0, tzinfo=timezone.utc)
_PRICES_DISCOUNT = {"input": 0.07, "output": 0.27, "cache": 0.014}
_PRICES_LIST     = {"input": 0.27, "output": 1.10, "cache": 0.054}


def _prices_now() -> dict[str, float]:
    base = _PRICES_DISCOUNT if datetime.now(timezone.utc) < DISCOUNT_UNTIL else _PRICES_LIST
    return {
        "input":  float(os.environ.get("DEEPSEEK_INPUT_USD_PER_M",  base["input"])),
        "output": float(os.environ.get("DEEPSEEK_OUTPUT_USD_PER_M", base["output"])),
        "cache":  float(os.environ.get("DEEPSEEK_CACHE_USD_PER_M",  base["cache"])),
    }


class DeepSeekProvider:
    name = "deepseek"

    def __init__(self) -> None:
        if not _DEEPSEEK_API_KEY:
            raise RuntimeError("DEEPSEEK_API_KEY not set")
        self._client = httpx.Client(
            base_url="https://api.deepseek.com",
            headers={"Authorization": f"Bearer {_DEEPSEEK_API_KEY}"},
            timeout=60.0,
        )
        self._limiter = Limiter(
            InMemoryBucket([Rate(_DEEPSEEK_RPM, Duration.MINUTE)]),
            raise_when_fail=False, max_delay=60_000,
        )

    def complete(self, req: LLMRequest) -> LLMResult:
        body: dict[str, Any] = {
            "model": req.model,
            "messages": req.messages,
            "max_tokens": req.max_output_tokens,
            "temperature": req.temperature,
        }
        if req.response_model is not None:
            body["response_format"] = {"type": "json_object"}
        if req.thinking_budget > 0:
            body["extra_body"] = {"thinking": {"type": "enabled"}}
            from . import translate_thinking_budget
            body["reasoning_effort"] = translate_thinking_budget("deepseek", req.step, req.thinking_budget)
        return self._post_with_retry(body, req)

    def _post_with_retry(self, body: dict, req: LLMRequest) -> LLMResult:
        last_exc: Exception | None = None
        for attempt in range(3):
            if not self._limiter.try_acquire("deepseek"):
                raise ProviderRateLimitedError(f"llm_rate_limited: bucket exhausted on {req.step}")
            try:
                r = self._client.post("/v1/chat/completions", json=body)
                if r.status_code == 200:
                    data = r.json()
                    text = data["choices"][0]["message"]["content"]
                    finish = data["choices"][0]["finish_reason"]
                    usage = data.get("usage", {})
                    self._log_usage(req.step, finish, usage)
                    parsed = req.response_model.model_validate_json(text) if req.response_model else None
                    return LLMResult(text=text, parsed=parsed, usage=usage, finish_reason=finish)
                if r.status_code in _RETRYABLE_STATUSES:
                    last_exc = ProviderError(f"deepseek http {r.status_code}: {r.text[:200]}")
                else:
                    raise ProviderError(f"deepseek http {r.status_code}: {r.text[:500]}")
            except httpx.RequestError as e:
                last_exc = e
            if attempt < 2:
                delay = 0.5 * (2 ** attempt)
                print(f"[llm-retry] deepseek {req.step} attempt {attempt+1}/3 after {type(last_exc).__name__}: sleeping {delay}s",
                      file=sys.stderr, flush=True)
                time.sleep(delay)
        assert last_exc is not None
        raise last_exc

    def _log_usage(self, step: str, finish: str, usage: dict) -> None:
        try:
            in_  = usage.get("prompt_tokens", 0)
            out_ = usage.get("completion_tokens", 0)
            hit_ = usage.get("prompt_cache_hit_tokens", 0)
            print(f"[deepseek] step={step} finish={finish} in={in_} out={out_} cache_hit={hit_}",
                  file=sys.stderr, flush=True)
        except Exception:
            pass

    def cost_usd(self, model: str, usage: dict[str, int]) -> float:
        prices = _prices_now()
        prompt = usage.get("prompt_tokens", 0)
        cached = usage.get("prompt_cache_hit_tokens", 0)
        out_   = usage.get("completion_tokens", 0)
        return ((prompt - cached) / 1_000_000) * prices["input"] \
             + (cached            / 1_000_000) * prices["cache"] \
             + (out_              / 1_000_000) * prices["output"]
```

- [ ] **Step 3: GREEN test**

Run: `pytest nlp-service/services/providers/test_providers.py::test_deepseek_complete_injects_json_response_format -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add nlp-service/services/providers/deepseek.py nlp-service/services/providers/test_providers.py
git commit -m "feat(llm): add DeepSeekProvider with json_object mode + cost table"
```

##### Task 4.2: Reasoning-effort translation + retry semantics + price-boundary tests

**Files:**
- Modify: `nlp-service/services/providers/test_providers.py`

- [ ] **Step 1: Translation table tests**

```python
@pytest.mark.parametrize("budget,expected", [(0, "disabled"), (1024, "low"), (2048, "medium"), (8192, "high"), (32768, "max")])
def test_translate_thinking_budget_for_deepseek(budget, expected):
    from nlp_service.services.providers import translate_thinking_budget
    assert translate_thinking_budget("deepseek", "extract", budget) == expected
```

Run: PASS already from Phase 2.3 — re-asserting the contract.

- [ ] **Step 2: Retry on 429**

```python
def test_deepseek_retries_on_429(mocker):
    calls = {"n": 0}
    class Resp:
        def __init__(self, status):
            self.status_code = status
            self.text = "rate"
        def json(self):
            return {"choices":[{"message":{"content":"{}"},"finish_reason":"stop"}],"usage":{}}
    def fake_post(self, url, json=None, **kw):
        calls["n"] += 1
        return Resp(429) if calls["n"] < 2 else Resp(200)
    mocker.patch("httpx.Client.post", fake_post)
    mocker.patch("time.sleep", lambda *_: None)
    from nlp_service.services.providers.deepseek import DeepSeekProvider
    from nlp_service.services.providers.base import LLMRequest
    p = DeepSeekProvider()
    p.complete(LLMRequest(model="deepseek-v4-pro", messages=[{"role":"user","content":"x"}], response_model=None, thinking_budget=0, max_output_tokens=10, temperature=0.0, step="t"))
    assert calls["n"] == 2
```

- [ ] **Step 3: Discount-boundary test**

```python
def test_deepseek_pricing_flips_at_discount_until(monkeypatch):
    from nlp_service.services.providers.deepseek import _prices_now, DISCOUNT_UNTIL
    import datetime as _dt
    class _F(_dt.datetime):
        @classmethod
        def now(cls, tz=None): return DISCOUNT_UNTIL - _dt.timedelta(seconds=1)
    monkeypatch.setattr("nlp_service.services.providers.deepseek.datetime", _F)
    assert _prices_now()["input"] < 0.10  # discount
    class _A(_dt.datetime):
        @classmethod
        def now(cls, tz=None): return DISCOUNT_UNTIL + _dt.timedelta(seconds=1)
    monkeypatch.setattr("nlp_service.services.providers.deepseek.datetime", _A)
    assert _prices_now()["input"] >= 0.20  # list
```

- [ ] **Step 4: Run all and commit**

Run: `pytest nlp-service/services/providers/test_providers.py -v`
Expected: PASS — all DeepSeek tests green.

```bash
git add nlp-service/services/providers/test_providers.py
git commit -m "test(llm): cover DeepSeek retry and discount-boundary"
```

##### Task 4.3: Wire `DeepSeekProvider` into `providers/__init__.py` factory

**Files:**
- Modify: `nlp-service/services/providers/__init__.py`

- [ ] **Step 1: RED — flip the existing dispatch test**

Update `test_get_provider_dispatches_by_prefix` (Phase 2.3 wrote it) so `deepseek-v4-pro` now expects `DeepSeekProvider`, not `NotImplementedError`. The test goes RED.

- [ ] **Step 2: GREEN**

Replace the `NotImplementedError` branch with:
```python
if model.startswith("deepseek-"):
    from .deepseek import DeepSeekProvider
    return _REGISTRY.setdefault("deepseek", DeepSeekProvider())
```

- [ ] **Step 3: Run a live smoke call (gated)**

Skip if `DEEPSEEK_API_KEY` not set. When set, run one extract on the smallest source in `test_corpus/`; assert response carries `_log_usage` line `[deepseek] step=extract`.

- [ ] **Step 4: Commit**

```bash
git add nlp-service/services/providers/__init__.py nlp-service/services/providers/test_providers.py
git commit -m "feat(llm): wire DeepSeekProvider into provider factory"
```

#### Phase 4 PR checklist

- [ ] **Spec first:** `docs/plans/phase_4_spec.md` exists and covers `DeepSeekProvider` shape, retry semantics, the `DISCOUNT_UNTIL` constant + env overrides, the `DEEPSEEK_RPM=60` default and rationale, and the `_log_usage` `[deepseek]` prefix
- [ ] **Tests first:** JSON-format injection, reasoning-effort translation, retry on 429, discount-boundary tests all red before implementation
- [ ] **Implement:** `providers/deepseek.py` exists; factory wires `deepseek-*`; live smoke call passes when key is present
- [ ] **Spec alignment review:** prices match published rates as of fetch date (record fetch URL + date in the spec); `DISCOUNT_UNTIL` matches DeepSeek's published deadline 2026-05-31T15:59:00Z
- [ ] **Code quality review:** own rate limiter (not borrowed from Gemini); own retry loop semantics; usage field names match DeepSeek's actual response shape
- [ ] **Final code review:** `gitnexus_detect_changes` shows `providers/deepseek.py`, `providers/__init__.py`, `providers/test_providers.py` only; CI green; ready to merge

#### Phase 4 kickoff checklist

- [ ] 4.1 — JSON-format injection test (RED → GREEN); `DeepSeekProvider.complete` shipped
- [ ] 4.2 — translation, retry, discount-boundary tests green
- [ ] 4.3 — factory wired; live smoke call (when key present) green
- [ ] One commit per task; CI green

---

### Phase 5 — Wire `docker-compose.yml` + `main.py` startup_check + `/api/health` flags

**Why:** Without these wirings, the Settings UI in Phase 6 can't gate the dropdown options, and operators get a silent `undefined` instead of a clear startup warning when the key is missing (Quirk #5).

**Depends on:** Phase 4 (`DeepSeekProvider` exists so `main.py` can import-check it).

**Status:** Not started.

**5.1** Edit `docker-compose.yml`: add `DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY:-}` to both `app.environment` (~line 45) and `nlp-service.environment` (~line 80) blocks adjacent to the existing `GEMINI_API_KEY` lines.

**5.2** If `.env.example` exists at repo root, append `DEEPSEEK_API_KEY=` (empty default) with a one-line comment pointing to `https://api-docs.deepseek.com`.

**5.3** Update `scripts/integration-test.sh` Stage 1 env loop to regression-guard `DEEPSEEK_API_KEY` alongside the existing `GEMINI_API_KEY` and `FIRECRAWL_API_KEY` checks.

**5.4** Edit `nlp-service/main.py:86`: `startup_check` warns if neither `GEMINI_API_KEY` nor `DEEPSEEK_API_KEY` is set; logs an info line if both are present (only one is consulted per call). The deprecated `@app.on_event("startup")` decorator stays in Phase 1 — switch to FastAPI lifespan in a separate cleanup PR.

**5.5** Edit `nlp-service/main.py:102`: `/health` response gains `provider_keys: {gemini: bool, deepseek: bool}`.

**5.6** Edit `app/src/app/api/health/route.ts`: extend response with `provider_keys: { gemini_present: !!process.env.GEMINI_API_KEY, deepseek_present: !!process.env.DEEPSEEK_API_KEY }` (presence-only, no outbound network probe).

**Why sequential, not parallel:** Each file is small, but they form a chain (compose → integration-test → backend health → frontend health). Sequencing avoids reasoning about partial states.

#### Phase 5 — File structure

- Modify: `docker-compose.yml` `app.environment` (~line 45) AND `nlp-service.environment` (~line 80)
- Modify: `.env.example` (if present at repo root)
- Modify: `scripts/integration-test.sh` Stage 1 env loop
- Modify: `nlp-service/main.py:86, :102`
- Modify: `app/src/app/api/health/route.ts`

#### Phase 5 — Tasks

##### Task 5.1: docker-compose + .env.example + integration-test guard

- [ ] **Step 1: Edit `docker-compose.yml`**

Add to `app.environment`:
```yaml
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY:-}
```
Add the same line to `nlp-service.environment`.

- [ ] **Step 2: If `.env.example` exists, append**

```bash
# https://api-docs.deepseek.com
DEEPSEEK_API_KEY=
```

- [ ] **Step 3: Update `scripts/integration-test.sh` Stage 1**

Add `DEEPSEEK_API_KEY` to the env-loop array alongside `GEMINI_API_KEY` and `FIRECRAWL_API_KEY`.

- [ ] **Step 4: Validate compose**

Run: `docker compose -f docker-compose.yml config`
Expected: exit 0; both `GEMINI_API_KEY` and `DEEPSEEK_API_KEY` substituted.

- [ ] **Step 5: Run integration-test stage 1**

Run: `bash scripts/integration-test.sh --stage 1`
Expected: PASS — env-presence checks pass with both keys set, fail loudly with either missing (loop covers both).

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example scripts/integration-test.sh
git commit -m "chore(env): wire DEEPSEEK_API_KEY through compose + integration test"
```

##### Task 5.2: `nlp-service/main.py` startup + /health

**Files:**
- Modify: `nlp-service/main.py:86, :102`

- [ ] **Step 1: RED — `/health` test asserts `provider_keys` shape**

```python
def test_health_exposes_provider_keys():
    from fastapi.testclient import TestClient
    from nlp_service.main import app
    c = TestClient(app)
    r = c.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert "provider_keys" in body
    assert set(body["provider_keys"].keys()) == {"gemini", "deepseek"}
```

Run: `pytest nlp-service/tests/test_main.py::test_health_exposes_provider_keys -v` → FAIL.

- [ ] **Step 2: GREEN**

Today the route returns a Pydantic `HealthResponse(status="ok")` model — extend that model with the `provider_keys` field, don't switch to a bare dict.

```python
# extend HealthResponse model in the same file
class _ProviderKeys(BaseModel):
    gemini: bool
    deepseek: bool

class HealthResponse(BaseModel):
    status: str
    provider_keys: _ProviderKeys

# at :86 startup_check, replace the existing single-key warning
gemini_key   = os.environ.get("GEMINI_API_KEY", "").strip()
deepseek_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
if not gemini_key and not deepseek_key:
    logger.warning("Neither GEMINI_API_KEY nor DEEPSEEK_API_KEY is set; LLM endpoints will fail.")

# at :103 /health response
return HealthResponse(
    status="ok",
    provider_keys=_ProviderKeys(gemini=bool(gemini_key), deepseek=bool(deepseek_key)),
)
```

- [ ] **Step 3: GREEN test**

Run: `pytest nlp-service/tests/test_main.py::test_health_exposes_provider_keys -v`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add nlp-service/main.py nlp-service/tests/test_main.py
git commit -m "feat(health): expose provider_keys flags in /health"
```

##### Task 5.3: `app/src/app/api/health/route.ts` mirror

- [ ] **Step 1: Read existing route**

```bash
cat app/src/app/api/health/route.ts
```

- [ ] **Step 2: Edit response body**

Add to the JSON the route returns:
```ts
provider_keys: {
  gemini_present: !!process.env.GEMINI_API_KEY,
  deepseek_present: !!process.env.DEEPSEEK_API_KEY,
},
```

- [ ] **Step 3: Verify**

Run (with the dev server up): `curl http://localhost:3000/api/health | jq .provider_keys`
Expected: `{"gemini_present": <bool>, "deepseek_present": <bool>}`.

- [ ] **Step 4: Commit**

```bash
git add app/src/app/api/health/route.ts
git commit -m "feat(health): expose provider_keys flags in Next.js /api/health"
```

#### Phase 5 PR checklist

- [ ] **Spec first:** `docs/plans/phase_5_spec.md` exists and lists the env wiring locations, the `/health` JSON schema delta, and the integration-test-stage-1 guard
- [ ] **Tests first:** `/health` provider_keys test red before backend implementation; integration-test stage 1 adapts to require `DEEPSEEK_API_KEY`
- [ ] **Implement:** docker-compose has both env entries in both services; `.env.example` updated; integration-test stage 1 covers both keys; nlp-service `/health` and Next.js `/api/health` both return provider_keys
- [ ] **Spec alignment review:** field names exactly `gemini` / `deepseek` (nlp-service) and `gemini_present` / `deepseek_present` (Next.js) — Phase 6 reads the latter; mismatch breaks the dropdown gate
- [ ] **Code quality review:** no outbound key probe in either health route; warnings only, no hard failure if both keys missing (operator may be running tests without LLMs)
- [ ] **Final code review:** `docker compose config` exits 0; both `curl` checks return expected shape; CI green; ready to merge

#### Phase 5 kickoff checklist

- [ ] 5.1 — docker-compose env entries added; .env.example updated; integration-test stage 1 guard extended; `docker compose config` exit 0
- [ ] 5.2 — nlp-service startup_check warns when neither key present; `/health` returns `provider_keys`; test green
- [ ] 5.3 — Next.js `/api/health` returns `provider_keys` with the `_present` suffix
- [ ] One commit per task; CI green

---

### Phase 6 — Settings UI: expand `CHAT_MODELS`, add optgroups, gate by health flag, expand validators, update copy

**Why:** This is the user-visible delivery. Operators discover DeepSeek via the dropdown, see disabled-with-tooltip when their key isn't set, and pick `deepseek-v4-pro` to opt in for that session. CLAUDE.md gotcha — per-session model lock already accepts arbitrary string, so no migration.

**Depends on:** Phase 5 (`/api/health` returns `provider_keys`).

**Status:** Not started.

**6.1** Edit `app/src/lib/db.ts:2530-2534`: add `'deepseek-v4-pro'` to `CHAT_MODELS` const (single explicit pin, no floating aliases). `isChatModel` validator at `:2538` picks up the new entry automatically. Add helper `getProviderForModel(m: string): 'gemini' | 'deepseek'` based on prefix.

**6.2** Edit `app/src/app/api/settings/route.ts:228, :238`: error strings now list expanded model set. Validation already routes through `isChatModel`.

**6.3** Edit `app/src/app/settings/page.tsx:1095-1112` (compile dropdown) and `:1160-1177` (chat dropdown): restructure both `<select>` blocks with grouped `<optgroup label="Gemini">` and `<optgroup label="DeepSeek">`. DeepSeek option: `disabled={!healthData?.provider_keys?.deepseek_present}`, `title="Set DEEPSEEK_API_KEY in your environment to enable"`.

**6.4** Edit `app/src/app/settings/page.tsx:1083-1092` (compile copy) and `:1152-1156` (chat copy): drop the word "Gemini" from descriptions ("Which model the compile pipeline uses…"). Health data fetched via existing settings page load (no new API call).

**Why sequential, not parallel:** All UI edits land in two files (`db.ts`, `settings/page.tsx`); manual matrix walk at the end requires a single coherent state.

#### Phase 6 — File structure

- Modify: `app/src/lib/db.ts:2530-2534, :2538` — `CHAT_MODELS` expansion + `getProviderForModel` helper
- Modify: `app/src/app/api/settings/route.ts:228, :238` — error strings
- Modify: `app/src/app/settings/page.tsx:1083-1112, :1152-1177` — copy + dropdown restructure

#### Phase 6 — Tasks

##### Task 6.1: Expand `CHAT_MODELS` + `getProviderForModel` helper

- [ ] **Step 1: Read current `CHAT_MODELS`**

```bash
sed -n '2525,2545p' app/src/lib/db.ts
```

- [ ] **Step 2: Edit `CHAT_MODELS` and add helper**

Replace `:2530-2534`:
```ts
export const CHAT_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'deepseek-v4-pro',
] as const;
```

Add below `isChatModel`:
```ts
export function getProviderForModel(m: string): 'gemini' | 'deepseek' {
  if (m.startsWith('deepseek-')) return 'deepseek';
  return 'gemini';
}
```

- [ ] **Step 3: Update settings POST validator error strings at `app/src/app/api/settings/route.ts:228, :238`**

The error strings list the valid model set. Update them to include `'deepseek-v4-pro'` so a 400 response remains accurate.

- [ ] **Step 4: Type-check**

Run: `cd app && npm run typecheck`
Expected: PASS — `'deepseek-v4-pro'` is now a valid `ChatModel`.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/db.ts app/src/app/api/settings/route.ts
git commit -m "feat(settings): allow deepseek-v4-pro in CHAT_MODELS + provider helper"
```

##### Task 6.2: Settings page dropdowns + copy

**Files:**
- Modify: `app/src/app/settings/page.tsx:1083-1112, :1152-1177`

- [ ] **Step 1: Read both dropdown blocks**

```bash
sed -n '1080,1115p' app/src/app/settings/page.tsx
sed -n '1150,1180p' app/src/app/settings/page.tsx
```

- [ ] **Step 2: Restructure compile dropdown with optgroups**

Pattern (apply to both compile and chat dropdowns):
```tsx
<select value={compileModel} onChange={…}>
  <optgroup label="Gemini">
    <option value="gemini-2.5-flash-lite">Flash Lite</option>
    <option value="gemini-2.5-flash">Flash</option>
    <option value="gemini-2.5-pro">Pro</option>
  </optgroup>
  <optgroup label="DeepSeek">
    <option
      value="deepseek-v4-pro"
      disabled={!healthData?.provider_keys?.deepseek_present}
      title={healthData?.provider_keys?.deepseek_present
        ? undefined
        : "Set DEEPSEEK_API_KEY in your environment to enable"}
    >
      V4 Pro
    </option>
  </optgroup>
</select>
```

- [ ] **Step 3: Update copy at `:1083-1092` and `:1152-1156`**

Drop the word "Gemini" — for example, "Which Gemini model the compile pipeline uses…" → "Which model the compile pipeline uses…".

- [ ] **Step 4: Manual matrix walk (the verification)**

Start the dev server: `cd app && npm run dev`. For each of the four key combinations:
- Only `GEMINI_API_KEY` set: DeepSeek option should appear disabled with tooltip; selecting Gemini saves cleanly
- Only `DEEPSEEK_API_KEY` set: Gemini options disabled; selecting `deepseek-v4-pro` saves cleanly; subsequent compile uses DeepSeek
- Both set: both selectable; switching saves cleanly
- Neither set: both groups disabled; settings save still works (per-session lock not engaged); banner / tooltip directs to env file

For each combination, kick off one small compile and assert the per-session lock at `compile_progress.compile_model` matches the selection.

- [ ] **Step 5: Commit**

```bash
git add app/src/app/settings/page.tsx
git commit -m "feat(ui): optgrouped Gemini/DeepSeek model dropdowns gated by health flags"
```

#### Phase 6 PR checklist

- [ ] **Spec first:** `docs/plans/phase_6_spec.md` exists and lists the four-corner manual matrix, the optgroup structure, the disabled+tooltip behaviour, and the copy edits
- [ ] **Tests first:** `npm run typecheck` is green pre-edit (so the type-error after `CHAT_MODELS` expansion is the RED signal); manual matrix is the integration-level "test"
- [ ] **Implement:** `CHAT_MODELS` expanded; `getProviderForModel` helper added; both dropdowns optgrouped; copy provider-neutral
- [ ] **Spec alignment review:** the per-session lock writes the model string (`deepseek-v4-pro`) verbatim to `compile_progress.compile_model`; `getEffectiveCompileModel` returns it on next call; subsequent extract dispatches to `DeepSeekProvider`
- [ ] **Code quality review:** no inline string lists of models in the page (uses `CHAT_MODELS`); no fake "free trial" / "estimated cost" copy that would falsify the discount window
- [ ] **Final code review:** the four manual-matrix corners walked and recorded in PR description; CI green; ready to merge

#### Phase 6 kickoff checklist

- [ ] 6.1 — `CHAT_MODELS` expanded; `getProviderForModel` helper added; settings POST validator error strings updated; typecheck green
- [ ] 6.2 — both dropdowns optgrouped; copy provider-neutral
- [ ] 6.2 — four-corner manual matrix walked: only-Gemini, only-DeepSeek, both, neither — recorded in PR description
- [ ] One commit per task; CI green

---

### Phase 7 — End-to-end re-validation against `nlp-service/test_corpus/`

**Why:** Spec section 7 demands a 28-call analogue against the preserved corpus through the new dispatched path. Each source extracts clean on Gemini AND DeepSeek; quality (entity counts) within ±10% of the spike baseline. This is the single observation that proves the abstraction churn didn't regress quality.

**Depends on:** Phases 1–6 all green and merged.

**Status:** Not started.

**7.1** Run the existing corpus through Gemini via the new dispatched path. Capture per-source entity counts. Diff against the spike baseline.

**7.2** Run the same corpus through DeepSeek. Capture per-source entity counts. Compare.

**7.3** Compare both against the original 28-call spike numbers. Tolerance: ±10% per source.

**7.4** Record results in `validation/2026-05-XX-multi-provider/` (or `/data/sv_results/`, per CLAUDE.md preference for not committing validation artifacts).

**Why sequential, not parallel:** End-to-end is one observation; parallel runs muddy the rate-limiter accounting.

#### Phase 7 — File structure

- Reuse: `nlp-service/test_corpus/` (7 sources + manifest)
- Create (off-branch or in `validation/`): `validation/2026-05-XX-multi-provider/results.json` — recorded baseline + per-source comparison
- No code changes; this phase is a verification phase

#### Phase 7 — Tasks

##### Task 7.1: Run corpus through Gemini and DeepSeek

- [ ] **Step 1: Set both keys, kick off the corpus runner**

Run: `bash scripts/integration-test.sh --stage 4 --corpus all --provider gemini`
Run: `bash scripts/integration-test.sh --stage 4 --corpus all --provider deepseek`

(If the runner doesn't take a `--provider` flag, run twice with the corresponding model-string env override.)

- [ ] **Step 2: Capture per-source entity counts**

Read produced page JSON. Tally entity count per source. Save to `validation/2026-05-XX-multi-provider/results.json` with shape:
```json
{
  "gemini":   {"<source_id>": {"entities": N, "concepts": M, "claims": K, "salvage_attempts": 0}, …},
  "deepseek": {"<source_id>": {"entities": N, "concepts": M, "claims": K, "salvage_attempts": 0}, …}
}
```

- [ ] **Step 3: Diff against spike baseline**

For each provider × source: assert entity count within ±10% of the recorded baseline. If any source breaches the tolerance, **stop and investigate** — open issue, do not merge Phase 7.

- [ ] **Step 4: Record outcome in PR description**

Single table per provider × source. Anything outside tolerance gets a remediation row.

- [ ] **Step 5: No commit (validation artifacts off-branch). Tag the verified-merge state.**

```bash
git tag -a feat-multi-provider-llm-verified -m "Phase 7 corpus revalidation green"
git push --tags
```

#### Phase 7 PR checklist

- [ ] **Spec first:** `docs/plans/phase_7_spec.md` defines the corpus surface (which 7 sources), the entity-count metric, the ±10% tolerance, and the recording format
- [ ] **Tests first:** the spike baseline is the test fixture; the new run is asserted against it
- [ ] **Implement:** N/A (verification only) — both providers run on the full corpus, results captured
- [ ] **Spec alignment review:** every source's count delta within tolerance; salvage_attempts == 0 on DeepSeek per spike
- [ ] **Code quality review:** N/A
- [ ] **Final code review:** results table embedded in the merge-PR description; CI green on the branch; ready to merge

#### Phase 7 kickoff checklist

- [ ] 7.1 — both providers run on the full corpus; entity counts captured
- [ ] 7.1 — every per-source delta within ±10% of spike baseline
- [ ] 7.1 — results recorded in `validation/…/results.json` (or `/data/sv_results/`)
- [ ] Tag pushed; branch ready for merge

---

## Risks + escape hatches

- **Risk:** Per-session lock with rotated keys: a session locked to `deepseek-v4-pro` fails mid-session if the operator removes `DEEPSEEK_API_KEY` (Quirk #8). **Hatch:** First-call returns a clear error from `DeepSeekProvider.__init__` (`RuntimeError: DEEPSEEK_API_KEY not set`); document in operator guide; lifespan-time check is per-process and cannot catch mid-run rotations — accept and document.
- **Risk:** Pricing-cap drift across providers — `/data/llm-cap.json` is dollar-denominated, so mixing providers within a day works correctly, but the hardcoded `"Daily Gemini spend"` message at `nlp-service/services/llm_client.py:287` would mislead an operator. **Hatch:** Phase 2.4 generalises the message to `"Daily LLM spend"`. Closed in this plan, not deferred.
- **Risk:** Free-form call sites (`draft_page`, `generate_schema`, `generate_digest`) carry no `response_format` requirement, so DeepSeek serves them — but creative-text style differs from Gemini. **Hatch:** Quality risk, not correctness. Manual eyeball review of one drafted page per provider before promoting in Settings UI; out of automated test scope; document in Phase 7 PR description.
- **Risk:** Stale 30s `_thinking_cache` (`nlp-service/services/llm_client.py:183`) means a newly-set provider key takes up to 30s to pick up. **Hatch:** Acceptable — document in operator guide; CLAUDE.md gotcha pattern (cache TTLs are intentional).
- **Risk:** `_RETRYABLE_STATUSES` (`nlp-service/services/llm_client.py:351`) was tuned for Gemini's error model. **Hatch:** DeepSeek docs confirm 408/429/500/502/503/504 retry semantics hold; same set works on DeepSeek (now lives in `providers/deepseek.py` with the same constant). Verified at Phase 4.2 retry test.
- **Risk:** The 8 schema-bound call-site conversion in Phase 3 is the highest-risk refactor; a `system_instruction` regression at any one of them would silently degrade output quality. **Hatch:** Phase 3.1 includes JSON-output baseline diff (±10% entity-count tolerance) on a known fixture from `nlp-service/test_corpus/`; any breach stops the phase before Phase 4 begins.
- **Risk:** The existing test fixtures use `mocker.patch` on Gemini-specific surfaces; after Phase 2 the patch targets must be repointed. **Hatch:** Phase 2.5 explicitly repoints all `client.models.generate_content` mocks at `providers.gemini.GeminiProvider.complete`; the `pytest -v` run gate at Phase 2.2 step 7 catches any miss.
- **Risk:** Discount-window math relies on container clock being UTC (Quirk #12). **Hatch:** Docker containers default to UTC; verify in Phase 4 spec; if a deploy ends up on local TZ, the env overrides `DEEPSEEK_INPUT_USD_PER_M` etc. let the operator pin pricing manually.
- **Risk:** DeepSeek's `prompt_cache_hit_tokens` field name might drift if their API changes; we'd silently undercount cache discount. **Hatch:** Phase 4.1's `_log_usage` emits `cache_hit=N` so an operator watching logs sees the value; if it's persistently 0 against expectations, the field name has drifted — fix-forward.
- **Risk:** The `npx gitnexus@1.6.1 analyze` re-index after phase commits — pinned 1.6.1 because 1.6.3 has Windows EPERM-symlinks and 1.6.2 fails arborist (CLAUDE.md). **Hatch:** Don't bump the gitnexus pin in this plan; if the version becomes blocking, separate plan.

---

## Done definition for the whole plan

- All 7 phases merged to `feat/multi-provider-llm`, then merged to `main`
- `pytest nlp-service/services/providers/test_providers.py` — green, including factory dispatch (gemini-* / deepseek-* / unknown), JSON-format injection, reasoning_effort translation, price-discount boundary, retry semantics
- `pytest nlp-service/tests/test_llm_client.py` — green; mocks repointed at `providers.gemini.GeminiProvider.complete`
- `docker compose -f docker-compose.yml config` — exits 0 with both `GEMINI_API_KEY` and `DEEPSEEK_API_KEY` substituted
- `curl http://localhost:3000/api/health | jq .provider_keys` — returns `{gemini_present: bool, deepseek_present: bool}`
- Settings UI four-corner matrix walked and recorded in the merge-PR description: only-Gemini, only-DeepSeek, both, neither — dropdown disabled-with-tooltip behaviour matches expectation in each
- All 7 sources in `nlp-service/test_corpus/` extract clean on Gemini AND on DeepSeek through the new dispatched path; entity count per source within ±10% of the spike baseline
- 0 salvage attempts logged on DeepSeek across the full corpus run (matches the 28-call spike result)
- `_log_usage` emits `[gemini] step=…` for Gemini calls and `[deepseek] step=… cache_hit=…` for DeepSeek calls
- `nlp-service/services/llm_client.py` shrinks from 1794 lines to ≤1200 lines (provider helpers moved out)
- `scripts/integration-test.sh --stage 1` regression-guards `DEEPSEEK_API_KEY` alongside `GEMINI_API_KEY` and `FIRECRAWL_API_KEY`
- `gitnexus_detect_changes` shows the expected file scope: `nlp-service/services/providers/`, `nlp-service/services/llm_client.py`, `nlp-service/main.py`, `app/src/lib/db.ts`, `app/src/app/settings/page.tsx`, `app/src/app/api/health/route.ts`, `app/src/app/api/settings/route.ts`, `docker-compose.yml`, `scripts/integration-test.sh`, `.env.example` (if present)
- Existing CI integration test stages 0,1,4,11,12,13,20,21 still pass

---

## References

- Capability roadmap: `docs/Tui-read.me`; execution source of truth: this plan
- CLAUDE.md project instructions: `d:\KomplCore\CLAUDE.md` — non-negotiable architecture rules, gotchas, n8n workflow map, gitnexus self-check
- Source spec / planning artifact (this plan formalises): `~/.claude/plans/plan-the-streaming-detector-ancient-candle.md` (the **superseded streaming-detector mitigation, never executed**, drafted 2026-04-XX)
- LLM call-parameter source of truth: `nlp-service/services/llm_client.py` (12+ call sites; CLAUDE.md gotcha)
- LLM-test second source of truth: `nlp-service/tests/test_llm_client.py` (asserts thinking_budget / max_output_tokens / temperature values)
- Per-session lock pattern: `app/src/lib/db.ts:1447` `getEffectiveCompileModel()`; per-session column `compile_progress.compile_model` (migration v20)
- Settings dropdown source of truth: `app/src/app/settings/page.tsx:1095-1112, :1160-1177` and `app/src/lib/db.ts:2530-2534`
- Health endpoints: `nlp-service/main.py:102` and `app/src/app/api/health/route.ts`
- Validation corpus: `nlp-service/test_corpus/` (7 sources + manifest preserved on `feat/multi-provider-llm`)
- Decision-rationale memory: `feedback_collab_working_style.md` (research-first for stale-prone tools, parallel-agent coordination)
- DeepSeek API docs (fetched 2026-05-05): `https://api-docs.deepseek.com/api/create-chat-completion` — `response_format`, `reasoning_effort`, `prompt_cache_hit_tokens` field
- DeepSeek pricing page (fetched 2026-05-05): `https://api-docs.deepseek.com/quick_start/pricing` — discount window through 2026-05-31T15:59:00Z, list rates after
- google-genai SDK retry context (research artifact section 3): `docs/research/2026-04-09-llm-compile.md`
- Skill source: `~/.claude/skills/implementation-plan-creator/SKILL.md` (canonical) and `~/Documents/implementation-plan-creator-rules.md` (working draft)
