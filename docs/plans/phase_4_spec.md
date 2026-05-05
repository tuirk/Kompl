# Phase 4 Spec — DeepSeekProvider implementation

**Plan:** [docs/plans/2026-05-05-deepseek-second-llm-provider.md](2026-05-05-deepseek-second-llm-provider.md)
**Branch:** `feat/multi-provider-llm`
**Status:** Active.
**Depends on:** Phase 3 (commits `385d8c6`, `52fd8de` — messages=[system, user] at 5 call sites; per-provider input cap + Gemini-only halved fallback gate; 174/174 tests green; real-Gemini acid test on `/pipeline/extract-llm` PASS).

## Scope

Implement `DeepSeekProvider` in [nlp-service/services/providers/deepseek.py](../../nlp-service/services/providers/deepseek.py) (new file). Wire it into the factory at [nlp-service/services/providers/__init__.py](../../nlp-service/services/providers/__init__.py) so `get_provider("deepseek-v4-pro")` returns the new class instead of raising `NotImplementedError`. Phase 4 lands the entire DeepSeek backend; no changes to `llm_client.py` or any call site (Phase 3 already canonicalised the `LLMRequest` shape both providers consume).

**In scope:**
- `nlp-service/services/providers/deepseek.py` (NEW) — `DeepSeekProvider` class implementing the `LLMProvider` Protocol:
  - Constructor reads `DEEPSEEK_API_KEY` (required at first call), builds `httpx.Client(base_url="https://api.deepseek.com")`
  - Owns its own pyrate-limiter bucket at `DEEPSEEK_RPM` (default 60)
  - `complete(req)` posts to `/v1/chat/completions` with `model`, `messages`, `max_tokens`, `temperature`, `response_format={"type":"json_object"}` when `req.response_model is not None`, `reasoning_effort` translated via `translate_thinking_budget` when `req.thinking_budget > 0`
  - Retry on 408/429/500/502/503/504 with exponential backoff (mirror `_with_retry`)
  - Usage parsing: read `prompt_tokens`, `completion_tokens`, `prompt_cache_hit_tokens` from response
  - Logs `[deepseek] step=… finish=… in=… out=… cache_hit=…`
  - Calls back into `llm_client._check_and_record_cost` via lazy module-attribute lookup (same pattern as Gemini)
  - Cost computation with discount-window logic
  - Discount constants:
    - `DISCOUNT_UNTIL = datetime(2026, 5, 31, 15, 59, 0, tzinfo=timezone.utc)`
    - `_PRICES_DISCOUNT = {"input": 0.07, "output": 0.27, "cache": 0.014}`
    - `_PRICES_LIST     = {"input": 0.27, "output": 1.10, "cache": 0.054}`
  - Env overrides: `DEEPSEEK_INPUT_USD_PER_M`, `DEEPSEEK_OUTPUT_USD_PER_M`, `DEEPSEEK_CACHE_USD_PER_M`
- Factory update: `get_provider("deepseek-v4-pro")` lazy-imports + caches a `DeepSeekProvider`
- New tests in `services/providers/test_providers.py`:
  - JSON-format injection (asserts `response_format={"type":"json_object"}` in the request body when `response_model` is set)
  - Retry on 429 (one retry then succeeds)
  - Discount-boundary (one second before `DISCOUNT_UNTIL` returns discount; one second after returns list)
  - `[deepseek]` log line emitted with `cache_hit=N`
  - `cost_usd` formula correctness on a known-input usage dict
- Update the existing `test_get_provider_deepseek_raises_until_phase_4` test → `test_get_provider_dispatches_deepseek_prefix`

**Out of scope:**
- `_check_and_record_cost` rewrite to take a pre-computed `cost_usd` (Phase 4 keeps the token-shape signature; it builds a Gemini-style usage dict inside DeepSeekProvider's `complete()` and passes the right keys to `_check_and_record_cost`. This is OK because `_check_and_record_cost` now goes through `provider.cost_usd(model, usage)` — the dispatcher doesn't care about the dict's keys, the provider does.)
- Adding `DEEPSEEK_API_KEY` to `docker-compose.yml` and `/api/health` (Phase 5)
- Settings UI changes (Phase 6)
- `_check_and_record_cost`'s docstring still mentions `prompt_tokens`/`cached_tokens`/etc as Gemini-shaped args — leave as-is; the DeepSeekProvider builds a dict with those exact keys before calling `cost_usd`, so the abstraction holds. Phase 4 spec deliberately does not refactor the dispatcher's cost flow.
- Live smoke call against the real DeepSeek API (gated by key presence; Phase 4 ships the unit tests + mocked HTTP only, with optional smoke tests deferred to operator validation).

## Data contracts

### `DeepSeekProvider.complete(req)` request body

```python
body = {
    "model": req.model,                                # "deepseek-v4-pro"
    "messages": req.messages,                          # passes through, including role=system
    "max_tokens": req.max_output_tokens,
    "temperature": req.temperature if req.temperature is not None else 0.0,
}
if req.response_model is not None:
    body["response_format"] = {"type": "json_object"}
if req.thinking_budget > 0:
    body["reasoning_effort"] = translate_thinking_budget("deepseek", req.step, req.thinking_budget)
```

### Response parsing

```python
# DeepSeek-specific field names (NOT Gemini's)
choice = data["choices"][0]
text = choice["message"]["content"]
finish_reason = choice["finish_reason"]
usage = {
    "prompt_tokens":           data["usage"].get("prompt_tokens", 0),
    "completion_tokens":       data["usage"].get("completion_tokens", 0),
    "prompt_cache_hit_tokens": data["usage"].get("prompt_cache_hit_tokens", 0),
}
```

### `DeepSeekProvider.cost_usd(model, usage)`

```python
prices = _prices_now()  # discount or list, optionally env-overridden
fresh   = max(0, usage["prompt_tokens"] - usage["prompt_cache_hit_tokens"])
cached  = usage["prompt_cache_hit_tokens"]
output_ = usage["completion_tokens"]
return (
    (fresh   / 1_000_000) * prices["input"]
  + (cached  / 1_000_000) * prices["cache"]
  + (output_ / 1_000_000) * prices["output"]
)
```

### `_prices_now()`

```python
def _prices_now() -> dict[str, float]:
    base = _PRICES_DISCOUNT if datetime.now(timezone.utc) < DISCOUNT_UNTIL else _PRICES_LIST
    return {
        "input":  float(os.environ.get("DEEPSEEK_INPUT_USD_PER_M",  base["input"])),
        "output": float(os.environ.get("DEEPSEEK_OUTPUT_USD_PER_M", base["output"])),
        "cache":  float(os.environ.get("DEEPSEEK_CACHE_USD_PER_M",  base["cache"])),
    }
```

### Cost callback into the dispatcher

`DeepSeekProvider.complete()` builds a usage dict with the DeepSeek-native keys (`prompt_tokens`, `completion_tokens`, `prompt_cache_hit_tokens`) and passes the same keys to `_check_and_record_cost`. But `_check_and_record_cost`'s signature is Gemini-shaped (`prompt_tokens, cached_tokens, output_tokens, thought_tokens`). Resolution: the DeepSeek provider maps its native fields to the dispatcher's signature:

```python
from services import llm_client  # lazy
llm_client._check_and_record_cost(
    req.model,
    usage["prompt_tokens"],            # -> prompt_tokens
    usage["prompt_cache_hit_tokens"],  # -> cached_tokens
    usage["completion_tokens"],        # -> output_tokens
    0,                                  # -> thought_tokens (DeepSeek folds reasoning into completion_tokens)
)
```

`_check_and_record_cost` then calls `provider.cost_usd(model, usage_for_provider)` where `usage_for_provider` is rebuilt with Gemini-shape keys. **Each provider's `cost_usd` accepts a Gemini-shape dict**: this is the unified internal interface even though wire-level field names differ. Phase 4's `DeepSeekProvider.cost_usd` translates back to its own field names internally.

Specifically, in `DeepSeekProvider.cost_usd`:

```python
def cost_usd(self, model: str, usage: dict[str, int]) -> float:
    # Dispatcher passes the Gemini-shape keys: prompt_token_count,
    # cached_content_token_count, candidates_token_count, thoughts_token_count.
    prices = _prices_now()
    prompt = usage.get("prompt_token_count", 0)
    cached = usage.get("cached_content_token_count", 0)
    output_ = usage.get("candidates_token_count", 0) + usage.get("thoughts_token_count", 0)
    fresh = max(0, prompt - cached)
    return (
        (fresh   / 1_000_000) * prices["input"]
      + (cached  / 1_000_000) * prices["cache"]
      + (output_ / 1_000_000) * prices["output"]
    )
```

(The dispatcher's `_check_and_record_cost` already builds this dict before calling `provider.cost_usd` — see [llm_client.py:227](../../nlp-service/services/llm_client.py#L227).)

## Public API / tool / config changes

None visible to external callers. The factory's behaviour for `deepseek-*` flips from `NotImplementedError` → returning a `DeepSeekProvider` instance. Settings UI dropdown still gates DeepSeek as disabled because `/api/health.provider_keys.deepseek_present` is wired in Phase 5; Phase 4 alone makes the backend ready.

## Success criteria

1. `nlp-service/services/providers/deepseek.py` exists; `DeepSeekProvider.name == "deepseek"`.
2. `from services.providers import get_provider; isinstance(get_provider("deepseek-v4-pro"), DeepSeekProvider)`.
3. JSON-format injection test green: a mocked `httpx.Client.post` captures the request body and asserts `response_format={"type":"json_object"}` is present when `response_model` is set on the `LLMRequest`.
4. Retry test green: mocked `httpx` returns 429 then 200; `complete()` succeeds and the post is called twice.
5. Discount-boundary test green: mocking `datetime.now()` to return one second before `DISCOUNT_UNTIL` returns discount-rate prices; one second after returns list-rate prices.
6. `cost_usd(model, usage)` returns the right amount for a known input dict (parameterised test with the formula).
7. `pytest nlp-service/tests/ nlp-service/services/providers/` — all 174 + new DeepSeek tests green.
8. The factory's `get_provider("deepseek-v4-pro")` test that previously asserted `NotImplementedError` now asserts the singleton-cached `DeepSeekProvider` instance.

## Out-of-scope items

(See Scope.) Phase 5 wires env, Phase 6 wires UI, Phase 7 runs the full `test_corpus/` revalidation against both providers.

## Safety constraints

- **No live HTTP calls in unit tests.** All DeepSeek tests mock `httpx.Client.post`. A live smoke test gated by `DEEPSEEK_API_KEY` is optional; this spec doesn't require it.
- **DEEPSEEK_API_KEY not present should not break import.** The constructor reads the env var and raises only on first call (matching Gemini's `RuntimeError("GEMINI_API_KEY not set")` pattern at [providers/gemini.py:120](../../nlp-service/services/providers/gemini.py#L120)).
- **Rate limiter must use a separate bucket key from Gemini.** `_get_limiter().try_acquire("deepseek")` so Gemini and DeepSeek limiters don't interfere.
- **`_RETRYABLE_STATUSES` lives per provider.** DeepSeek's set is the same 408/429/5xx; the constant is duplicated in deepseek.py with a comment explaining why (each provider should be free to evolve its retry semantics independently).
- **Discount window math is UTC-clock-dependent.** Docker containers default to UTC; integration tests that hit DeepSeek must keep that invariant. Operators on non-UTC TZ can override via the env price vars.

## Test strategy

### Pre-implementation
- Baseline: 174/174 green (commit `52fd8de`).

### Per-test (RED → GREEN)

1. **Factory dispatch flip** — replace `test_get_provider_deepseek_raises_until_phase_4` with `test_get_provider_dispatches_deepseek_prefix`. Initially fails because the factory still raises `NotImplementedError`. Implement the factory branch; passes.

2. **JSON-format injection** — RED test stubs `httpx.Client.post`, captures the body, asserts `response_format={"type":"json_object"}` is present when `response_model` is provided. Initially fails because `DeepSeekProvider` doesn't exist; implement; passes.

3. **No JSON-format when no schema** — same harness, omit `response_model`, assert `response_format` is NOT in the body.

4. **Retry on 429** — RED test stubs `httpx.Client.post` to return a 429 response on the first call and a 200 on the second; mocks `time.sleep`; asserts `complete()` succeeds and the post was called exactly twice.

5. **Retry exhaustion** — three consecutive 429s; asserts a final exception (use the existing `LLMRateLimitedError` from `llm_client.py`, lazy-imported, or `ProviderTransientError` for cleaner separation). Spec: use `LLMRateLimitedError` to match the existing public-facing exception type that callers already catch.

6. **Discount-boundary** — patch `datetime.now()` (via a fixture) to a known instant; assert `_prices_now()["input"]` matches discount or list rate accordingly.

7. **Env override** — set `DEEPSEEK_INPUT_USD_PER_M=0.99`, assert `_prices_now()["input"] == 0.99` regardless of the wall-clock branch.

8. **cost_usd formula** — parameterise over a known usage dict and assert the float result. Catches off-by-N-million errors.

9. **`[deepseek]` log line emitted with cache_hit field** — capsys captures the line; assert format.

### Phase exit
- `pytest nlp-service/tests/ nlp-service/services/providers/` — all green.
- (Optional, not required by spec) Live smoke: `curl -X POST http://localhost:8000/pipeline/extract-llm -d '{"compile_model":"deepseek-v4-pro", ...}'` returns a structured response. Operator validates outside CI.

## Decomposition

**Task 4.1** — Create `providers/deepseek.py` with `DeepSeekProvider`, `_prices_now`, `_PRICES_DISCOUNT`/`_PRICES_LIST`, `DISCOUNT_UNTIL`, retry semantics, usage parsing, JSON-format injection. Add the corresponding RED-then-GREEN tests in `test_providers.py`. Update the factory to dispatch `deepseek-*`. One commit.

(Phase 4 is one logical unit; the spec does not subdivide it further. The plan's master file describes 3 sub-tasks (4.1, 4.2, 4.3) but in practice the sub-task split there is mostly about test ordering — the production code lives in one new file. Phase 4 ships as a single commit.)

## References

- Master plan: [2026-05-05-deepseek-second-llm-provider.md](2026-05-05-deepseek-second-llm-provider.md) (Phase 4)
- Phase 3 commits: `385d8c6`, `52fd8de`
- Phase 3 spec: [phase_3_spec.md](phase_3_spec.md)
- DeepSeek API docs (fetched 2026-05-05): `https://api-docs.deepseek.com/api/create-chat-completion` — `response_format`, `reasoning_effort`, `prompt_cache_hit_tokens` field
- DeepSeek pricing page (fetched 2026-05-05): `https://api-docs.deepseek.com/quick_start/pricing` — discount window through 2026-05-31T15:59:00Z, list rates after
- Mirror reference: GeminiProvider in [providers/gemini.py](../../nlp-service/services/providers/gemini.py); the DeepSeek class follows the same shape
