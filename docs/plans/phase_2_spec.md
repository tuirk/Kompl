# Phase 2 Spec — Provider Protocol + extract Gemini logic into providers/gemini.py

**Plan:** [docs/plans/2026-05-05-deepseek-second-llm-provider.md](2026-05-05-deepseek-second-llm-provider.md)
**Branch:** `feat/multi-provider-llm`
**Status:** Active.
**Depends on:** Phase 1 (commits `a2af21f`, `735c91f`, `9734f9c` — `_JSON_TRAILER` + 7 prompt trailers landed; 151 nlp-service tests green; integration stages 0/1/4 PASS).

## Scope

Behaviour-preserving extract of all Gemini-specific surface from [nlp-service/services/llm_client.py](../../nlp-service/services/llm_client.py) into a new `nlp-service/services/providers/` package. The dispatcher (`llm_client.py`) becomes provider-agnostic; every Gemini call goes through `provider = get_provider(model); provider.complete(LLMRequest(...))`.

**In scope:**
- New package `nlp-service/services/providers/` with `__init__.py`, `base.py`, `gemini.py`, `test_providers.py`
- Move out of `llm_client.py` into `gemini.py`:
  - `_GEMINI_API_KEY` ([:61](../../nlp-service/services/llm_client.py#L61)), `_GEMINI_RPM` ([:62](../../nlp-service/services/llm_client.py#L62)), `_get_limiter` and `_limiter` ([:325-336](../../nlp-service/services/llm_client.py#L325))
  - `_MODEL_PRICES`, env price overrides, `_get_model_prices` ([:89-116](../../nlp-service/services/llm_client.py#L89))
  - `_log_usage`, `_record_usage`, `_was_truncated` ([:297-443](../../nlp-service/services/llm_client.py#L297))
  - `_with_retry`, `_RETRYABLE_STATUSES`, `_APIError` import block ([:44-53, :351, :354-393](../../nlp-service/services/llm_client.py#L351))
  - `get_client`, `_client` ([:474-483](../../nlp-service/services/llm_client.py#L474))
- Rewire every LLM call site in `llm_client.py` (the 11 call sites named in the master plan) to use `provider.complete(LLMRequest(...))`
- Generalise `"Daily Gemini spend limit"` ([:287](../../nlp-service/services/llm_client.py#L287)) → `"Daily LLM spend limit"`; docstring `"daily Gemini $ cap"` ([:217](../../nlp-service/services/llm_client.py#L217)) → `"daily LLM $ cap"`
- Repoint test mocks in [nlp-service/tests/test_llm_client.py](../../nlp-service/tests/test_llm_client.py) from `client.models.generate_content` to `providers.gemini.GeminiProvider.complete`

**Out of scope:**
- DeepSeek implementation (Phase 4)
- `messages=[system, user]` shape conversion at call sites (Phase 3 — Phase 2 keeps the existing system+user concatenation pattern, just routed through the Protocol)
- Renaming `GEMINI_*` env vars to `LLM_*`
- Switching `@app.on_event("startup")` to FastAPI lifespan
- Touching `_DEFAULT_MODEL = "gemini-2.5-flash"` ([:121](../../nlp-service/services/llm_client.py#L121)) — the historical hardcoded safety-net default stays
- `_salvage_extraction` ([:446](../../nlp-service/services/llm_client.py#L446)) — already provider-agnostic, stays at dispatcher layer
- `_check_and_record_cost` ([:259](../../nlp-service/services/llm_client.py#L259)) — stays at dispatcher; provider supplies per-call cost via `provider.cost_usd(model, usage)`
- `_read_thinking_budget` ([:186](../../nlp-service/services/llm_client.py#L186)) and the 30s `_thinking_cache` — stay at dispatcher

## Data contracts

### `providers/base.py`

```python
@dataclass
class LLMRequest:
    model: str                                   # "gemini-2.5-flash" / "deepseek-v4-pro"
    messages: list[dict[str, str]]               # [{"role":"system","content":...}, {"role":"user","content":...}]
    response_model: type[BaseModel] | None       # Pydantic schema for structured output, or None for free-form
    thinking_budget: int                         # raw budget; provider translates (Gemini int, DeepSeek enum)
    max_output_tokens: int
    temperature: float
    step: str                                    # log/cost-tracking label (e.g. "extract", "lint")
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class LLMResult:
    text: str                                    # raw response text (post-parsing/concatenation)
    parsed: BaseModel | None                     # response_model.model_validate_json(text) if requested
    usage: dict[str, int]                        # provider-native token counts (passed through to cost calc)
    finish_reason: str                           # "STOP" | "MAX_TOKENS" | "ERROR" | provider-specific


class LLMProvider(Protocol):
    name: str                                    # "gemini" / "deepseek"
    def complete(self, req: LLMRequest) -> LLMResult: ...
    def cost_usd(self, model: str, usage: dict[str, int]) -> float: ...


class ProviderError(Exception): pass
class ProviderRateLimitedError(ProviderError): pass
class ProviderTransientError(ProviderError): pass
```

### `providers/gemini.py` — `GeminiProvider`

- `name = "gemini"`
- `complete(req)`:
  1. Acquires the in-process pyrate-limiter token (`_get_limiter().try_acquire("gemini")`); raises `ProviderRateLimitedError` if bucket exhausted
  2. Translates `req.messages` → genai SDK call: role=system → `system_instruction` parameter; role=user → `contents`
  3. Builds `types.GenerateContentConfig` with `req.thinking_budget`, `req.max_output_tokens`, `req.temperature`, `response_schema=req.response_model` if set, `response_mime_type="application/json"` if structured
  4. Wraps the call in `_with_retry` for transient errors (408/429/5xx), max 3 attempts, 0.5s base delay
  5. Reads `usage_metadata`; emits `[gemini] step=… finish=… in=… out=… thinking=…` log line
  6. If `req.response_model` set, parses via `response_model.model_validate_json(response.text)`
  7. Returns `LLMResult(text=response.text, parsed=parsed, usage={...}, finish_reason=...)`
- `cost_usd(model, usage)` reads `_MODEL_PRICES[model]` (with env overrides) and computes `(prompt-cached)*input + cached*cache + (output+thinking)*output / 1e6`

The Gemini-specific log prefix `[gemini]` stays — DeepSeek will emit `[deepseek]` from its own equivalent helper in Phase 4. The grep'able pattern is the per-provider observability hook.

### `providers/__init__.py` — factory

```python
def get_provider(model: str) -> LLMProvider:
    if model.startswith("gemini-"):
        return _REGISTRY.setdefault("gemini", GeminiProvider())
    if model.startswith("deepseek-"):
        raise NotImplementedError("DeepSeek provider lands in Phase 4")
    raise ValueError(f"unknown provider for model {model!r}")

def translate_thinking_budget(provider: str, call_site: str, raw: int) -> object:
    if provider == "gemini":  return raw                   # int passthrough
    if provider == "deepseek":
        if raw == 0:    return "disabled"
        if raw <= 1024: return "low"
        if raw <= 2048: return "medium"
        if raw <= 8192: return "high"
        return "max"
    raise ValueError(f"unknown provider {provider!r}")
```

`_REGISTRY` caches one instance per provider name (`GeminiProvider` is a stateful singleton because it owns the genai client and the rate-limiter bucket).

## Public API / tool / config changes

None visible to callers outside `nlp-service/services/`. The 11 internal call sites in `llm_client.py` change shape but their public function signatures (`extract_source(...)`, `lint_scan(...)`, etc.) and the FastAPI endpoints downstream remain identical.

## Success criteria

1. `providers/base.py`, `providers/gemini.py`, `providers/__init__.py`, `providers/test_providers.py` exist and import cleanly
2. `from services.providers import get_provider; get_provider("gemini-2.5-flash")` returns a `GeminiProvider` instance
3. `get_provider("deepseek-v4-pro")` raises `NotImplementedError`; `get_provider("anthropic-…")` raises `ValueError`
4. Every LLM call site in `llm_client.py` constructs an `LLMRequest` and calls `provider.complete(...)` — no direct `client.models.generate_content` invocations remain
5. `pytest nlp-service/tests/test_llm_client.py` — 7/7 green (mocks repointed)
6. `pytest nlp-service/tests/` — 151/151 green
7. `pytest nlp-service/services/providers/test_providers.py` — green (factory dispatch, shape, behaviour-equivalence on `_log_usage` format)
8. `bash scripts/integration-test.sh` stages 0/1/4 — PASS
9. `nlp-service/services/llm_client.py` line count drops below 1500 (helpers moved out; Phase 1 added 8 lines for `_JSON_TRAILER`; net target ~1100-1200)
10. `gitnexus_detect_changes` shows scope: `nlp-service/services/llm_client.py` + `nlp-service/services/providers/*` + `nlp-service/tests/test_llm_client.py`

## Out-of-scope items

(See Scope above.) Phase 3 converts call-site message shapes; Phase 4 wires DeepSeek; renaming env vars is deferred per master plan.

## Safety constraints

- **Behaviour-preserving extract.** No semantic change for Gemini. The 151 unit tests + the integration stage 4 smoke run is the gate.
- **One commit per task.** 2.1 (base + RED tests), 2.2 (gemini.py + rewire + mock repoint), 2.3 (factory + cost-cap message). Each commit must leave the suite green so bisect remains useful.
- **No call-site message-shape change in Phase 2.** The temptation to convert system+user concatenation to `messages=[system, user]` while moving code is real; resist it. Phase 3 owns that conversion.
- **No DeepSeek-shaped code in Phase 2.** The factory raises `NotImplementedError` for `deepseek-*`. Phase 4 lands the actual provider.
- **`_thinking_cache`'s 30s TTL stays.** Stale-key warning per master plan Risks; not a Phase 2 concern.

## Test strategy

### Pre-implementation
- Capture baseline: `pytest nlp-service/tests/ -v` → 151/151 green (already verified on commit `9734f9c`)

### Per-task
- **2.1** RED → GREEN: shape tests for `LLMRequest`, `LLMResult` in `providers/test_providers.py`; module-import tests
- **2.2** RED → GREEN: `_log_usage` format equivalence test; full nlp-service suite must remain 151/151 after rewire
- **2.3** RED → GREEN: factory dispatch test (gemini-* → instance, deepseek-* → NotImplementedError, anthropic-* → ValueError); cost-cap message test asserting the new "Daily LLM spend" string

### Phase exit
- `pytest nlp-service/tests/ nlp-service/services/providers/` — all green
- `bash scripts/integration-test.sh` stages 0/1/4 — PASS
- `git diff main..HEAD -- nlp-service/services/llm_client.py | wc -l` — significant reduction (provider helpers gone)

## Risks + escape hatches

- **Risk:** `mocker.patch("…client.models.generate_content")` in test fixtures will silently mock the wrong target after the rewire. **Hatch:** Phase 2.2 step 7 runs the full suite — failures pinpoint mocks to repoint. The plan's `gitnexus_impact` already counted these mocks as a likely +1-2h slip.
- **Risk:** Singleton `GeminiProvider` instance caches the genai client and the rate-limiter bucket; tests that stub the env between cases could hit a stale instance. **Hatch:** Lazy initialization in `__init__` reads `_GEMINI_API_KEY` at call time, not import time; tests can `_REGISTRY.clear()` if needed (expose as `_reset_for_tests()` or similar).
- **Risk:** Translating `messages=[system, user]` → genai `system_instruction` + `contents` may regress at call sites that today pass system+user concatenated as a single `contents` string. **Hatch:** Phase 2 keeps the existing concatenation pattern. The `complete()` adapter accepts both shapes — if `messages[0].role == "system"` the system prompt is split out; otherwise the entire payload goes into `contents`. Phase 3 converts the call sites to the explicit-roles shape. (This means Phase 2's adapter is dual-shape-tolerant; Phase 3 narrows it.)
- **Risk:** The `[gemini] step=…` log line is the grep'able observability hook for cost-watching; moving the helper into `gemini.py` is fine, but its callers must continue invoking it on every successful response. **Hatch:** `complete()` is the sole call-site in Phase 2; it always invokes `_log_usage` before returning. One choke point.

## Decomposition

**Task 2.1** — `providers/base.py` Protocol + dataclasses + error hierarchy + RED+GREEN shape tests.

**Task 2.2** — `providers/gemini.py` with helpers moved + `complete()` adapter + rewire all 11 LLM call sites in `llm_client.py` + repoint test mocks. Largest commit; the suite must stay 151/151 green.

**Task 2.3** — `providers/__init__.py` factory + `translate_thinking_budget` helper + generalise cost-cap error message. RED+GREEN factory dispatch tests.

## References

- Master plan: [2026-05-05-deepseek-second-llm-provider.md](2026-05-05-deepseek-second-llm-provider.md) (Phase 2)
- Phase 1 commits: `a2af21f`, `735c91f`, `9734f9c`
- Existing test fixture pattern: [nlp-service/tests/test_llm_client.py](../../nlp-service/tests/test_llm_client.py) — 7 tests for draft_page + source_summary; mocks `client.models.generate_content`
- Cookbook issue #1091 (google-genai retry semantics) — referenced in `llm_client.py` `_with_retry` docstring at [:340-348](../../nlp-service/services/llm_client.py#L340)
- pyrate-limiter `Limiter` API — used in `_get_limiter` at [:325-336](../../nlp-service/services/llm_client.py#L325)
