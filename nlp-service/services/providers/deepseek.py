"""DeepSeek backend for the LLMProvider Protocol.

Mirrors the shape of GeminiProvider: own httpx client, own pyrate-limiter
bucket, retry on 408/429/5xx, lazy import of llm_client._check_and_record_cost
so the test fixture's monkeypatch keeps working.

DeepSeek API specifics (2026-05-05):
- OpenAI-compatible POST /v1/chat/completions on https://api.deepseek.com.
- json_object response_format requires the literal word "json" in the prompt
  (Phase 1 system-prompt trailers cover this for every schema-bound site).
- Reasoning controlled via ``reasoning_effort`` enum (``disabled``, ``low``,
  ``medium``, ``high``, ``max``); translated from the int thinking_budget in
  ``providers.translate_thinking_budget``.
- Usage fields differ from Gemini: ``prompt_tokens``, ``completion_tokens``,
  ``prompt_cache_hit_tokens``. The Gemini-shape ``thoughts_token_count`` is
  absent — DeepSeek folds reasoning into completion_tokens.
- Pricing tracks DeepSeek's published list rates only. Promotional discount
  windows are deliberately ignored (cap counter overestimates during a
  discount, which is the safe side); operators can pin per-rate via the
  DEEPSEEK_*_USD_PER_M env vars.

Like gemini.py, this module MUST NOT import services.llm_client at module
level — gemini.py and deepseek.py are loaded lazily by
``providers.get_provider()`` AFTER llm_client.py finishes its module-load.
"""

from __future__ import annotations

import os
import sys
import time
from typing import Any

import httpx
from pydantic import BaseModel
from pyrate_limiter import Duration, InMemoryBucket, Limiter, Rate

from .base import LLMRequest, LLMResult


# ---------------------------------------------------------------------------
# Configuration from environment
# ---------------------------------------------------------------------------

_DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "").strip()
# DeepSeek documents 60 RPM as the per-minute cap for the standard tier.
# Conservative even at the paid tier; operators can raise via the env var.
_DEEPSEEK_RPM = int(os.environ.get("DEEPSEEK_RPM", "60"))


# ---------------------------------------------------------------------------
# Pricing (DeepSeek V4 family, $/M tokens)
# ---------------------------------------------------------------------------
#
# List prices per api-docs.deepseek.com/quick_start/pricing (2026-05-22 read).
# We deliberately do NOT model the promotional 75%-off discount window — when
# DeepSeek runs a discount, our cap counter overestimates real spend, which is
# the safe side to err on (cap fires earlier than necessary, never later than
# the user budget). Constants drift over time; the surfaced "Daily LLM spend"
# in the UI is an estimate — reconcile with the provider's invoice for ground
# truth, and treat any V5/V4-Lite/etc. switch as a reason to revisit this dict.
# Operators can override per-rate via DEEPSEEK_INPUT_USD_PER_M /
# DEEPSEEK_OUTPUT_USD_PER_M / DEEPSEEK_CACHE_USD_PER_M without touching code.
# Env overrides apply to all DeepSeek models (matching gemini.py's escape-
# hatch convention) — emergency-use-only when DeepSeek changes pricing before
# we ship a code update.

_MODEL_PRICES: dict[str, dict[str, float]] = {
    "deepseek-v4-pro":   {"input": 1.74, "output": 3.48, "cache": 0.0145},
    "deepseek-v4-flash": {"input": 0.14, "output": 0.28, "cache": 0.0028},
}


def _get_model_prices(model: str) -> dict[str, float]:
    """Per-million-token list prices for ``model``, with env-var overrides.

    Unknown model names raise KeyError. By design — every model name reaching
    this function passed through the Settings dropdown allowlist
    (app/src/lib/db.ts CHAT_MODELS) and the Pydantic Literal at the route
    boundary. An unknown name here means a developer added a SKU to the
    Literals/dropdown but forgot to add its price; fail loud in tests.
    """
    base = _MODEL_PRICES[model]
    return {
        "input":  float(os.environ.get("DEEPSEEK_INPUT_USD_PER_M",  base["input"])),
        "output": float(os.environ.get("DEEPSEEK_OUTPUT_USD_PER_M", base["output"])),
        "cache":  float(os.environ.get("DEEPSEEK_CACHE_USD_PER_M",  base["cache"])),
    }


# ---------------------------------------------------------------------------
# Retry semantics — same status codes as Gemini, kept duplicated so the two
# providers can evolve their retry sets independently if upstream behaviour
# diverges. DeepSeek docs confirm 408/429/5xx are the right retryable set.
# ---------------------------------------------------------------------------

_RETRYABLE_STATUSES: frozenset[int] = frozenset({408, 429, 500, 502, 503, 504})


# ---------------------------------------------------------------------------
# Rate limiter — own bucket so Gemini and DeepSeek don't share the cap
# ---------------------------------------------------------------------------

_limiter: Limiter | None = None


def _get_limiter() -> Limiter:
    global _limiter
    if _limiter is None:
        _limiter = Limiter(
            InMemoryBucket([Rate(_DEEPSEEK_RPM, Duration.MINUTE)]),
            raise_when_fail=False,
            max_delay=60_000,  # wait up to 60s before giving up
        )
    return _limiter


# ---------------------------------------------------------------------------
# httpx client (lazy init)
# ---------------------------------------------------------------------------

_client: httpx.Client | None = None


def get_client() -> httpx.Client:
    global _client
    if _client is None:
        if not _DEEPSEEK_API_KEY:
            raise RuntimeError("DEEPSEEK_API_KEY not set")
        _client = httpx.Client(
            base_url="https://api.deepseek.com",
            headers={"Authorization": f"Bearer {_DEEPSEEK_API_KEY}"},
            # 600s: empirically DeepSeek extract on a 95K-char source reaches
            # ~290s; the Vilnius travel guide hit ~387s in the Phase 7 rerun.
            # 120s (the prior value) timed out before the API responded on any
            # source >25K chars. Headroom over the worst observed: ~55%.
            timeout=600.0,
        )
    return _client


# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------


def _log_usage(step: str, finish: str, usage: dict[str, int]) -> None:
    try:
        in_  = usage.get("prompt_tokens", 0)
        out_ = usage.get("completion_tokens", 0)
        hit_ = usage.get("prompt_cache_hit_tokens", 0)
        print(
            f"[deepseek] step={step} finish={finish} in={in_} out={out_} cache_hit={hit_}",
            file=sys.stderr,
            flush=True,
        )
    except Exception:
        pass


# ---------------------------------------------------------------------------
# DeepSeekProvider
# ---------------------------------------------------------------------------


class DeepSeekProvider:
    """LLMProvider implementation backed by DeepSeek's OpenAI-compatible HTTP API.

    Owns a lazily-initialised httpx client and a per-process pyrate-limiter
    bucket. ``providers.get_provider("deepseek-...")`` caches one instance per
    process.
    """

    name = "deepseek"

    def complete(self, req: LLMRequest) -> LLMResult:
        # Lazy import: keep the public LLMRateLimitedError type at the
        # dispatcher layer; avoid circular import at module load.
        from services.llm_client import LLMRateLimitedError
        from . import translate_thinking_budget

        body: dict[str, Any] = {
            "model": req.model,
            "messages": req.messages,
            "max_tokens": req.max_output_tokens,
            "temperature": req.temperature if req.temperature is not None else 0.0,
        }
        if req.response_model is not None:
            body["response_format"] = {"type": "json_object"}
        if req.thinking_budget > 0:
            body["reasoning_effort"] = translate_thinking_budget(
                "deepseek", req.step, req.thinking_budget
            )

        client = get_client()
        limiter = _get_limiter()
        last_exc: Exception | None = None

        max_attempts = 3 if req.extra.get("retry", True) else 1
        for attempt in range(max_attempts):
            if not limiter.try_acquire("deepseek"):
                raise LLMRateLimitedError(
                    f"llm_rate_limited: bucket exhausted on {req.step}"
                )
            try:
                response = client.post("/v1/chat/completions", json=body)
            except (
                httpx.ConnectError,
                httpx.PoolTimeout,
                httpx.ReadTimeout,
                httpx.WriteTimeout,
                httpx.RemoteProtocolError,
                httpx.WriteError,
                httpx.ReadError,
            ) as e:
                last_exc = e
                err_class = type(e).__name__
            else:
                if response.status_code == 200:
                    return self._unpack(req, response)
                if response.status_code not in _RETRYABLE_STATUSES:
                    raise RuntimeError(
                        f"deepseek http {response.status_code}: "
                        f"{response.text[:500]}"
                    )
                last_exc = RuntimeError(
                    f"deepseek http {response.status_code}: {response.text[:200]}"
                )
                err_class = f"HTTP{response.status_code}"

            if attempt < max_attempts - 1:
                delay = 0.5 * (2 ** attempt)
                print(
                    f"[llm-retry] deepseek {req.step} attempt {attempt + 1}/"
                    f"{max_attempts} after {err_class}: "
                    f"{str(last_exc)[:200]} — sleeping {delay}s",
                    file=sys.stderr,
                    flush=True,
                )
                time.sleep(delay)

        assert last_exc is not None
        raise last_exc

    def _unpack(self, req: LLMRequest, response: httpx.Response) -> LLMResult:
        data = response.json()
        choice = data["choices"][0]
        text = choice["message"]["content"] or ""
        finish_reason = choice.get("finish_reason", "stop")
        # DeepSeek-native usage shape:
        usage_native = {
            "prompt_tokens":           int((data.get("usage") or {}).get("prompt_tokens", 0) or 0),
            "completion_tokens":       int((data.get("usage") or {}).get("completion_tokens", 0) or 0),
            "prompt_cache_hit_tokens": int((data.get("usage") or {}).get("prompt_cache_hit_tokens", 0) or 0),
        }
        _log_usage(req.step, finish_reason, usage_native)

        # Cost-cap accounting routes through the dispatcher with a Gemini-
        # shape signature; map DeepSeek fields to that signature. The
        # dispatcher then calls back into provider.cost_usd(model, usage)
        # where ``usage`` is the same Gemini-shape dict — see ``cost_usd``
        # below for how DeepSeek translates back.
        if usage_native["prompt_tokens"] or usage_native["completion_tokens"]:
            from services import llm_client  # lazy
            llm_client._check_and_record_cost(
                req.model,
                usage_native["prompt_tokens"],            # -> prompt_tokens
                usage_native["prompt_cache_hit_tokens"],  # -> cached_tokens
                usage_native["completion_tokens"],        # -> output_tokens
                0,                                          # -> thought_tokens (folded into completion_tokens)
            )

        parsed: BaseModel | None = None
        parse_error: Exception | None = None
        if req.response_model is not None and text:
            try:
                parsed = req.response_model.model_validate_json(text)
            except Exception as e:
                parse_error = e

        # LLMResult.usage stores the DeepSeek-native shape — the dispatcher
        # never reads it directly (cost goes through cost_usd), so the wire
        # shape can be provider-native here.
        return LLMResult(
            text=text,
            parsed=parsed,
            parse_error=parse_error,
            usage=usage_native,
            finish_reason=str(finish_reason).upper(),
        )

    def cost_usd(self, model: str, usage: dict[str, int]) -> float:
        """Per-call cost. The dispatcher passes a Gemini-shape dict
        (prompt_token_count, cached_content_token_count, candidates_token_count,
        thoughts_token_count) — translate to DeepSeek's pricing formula.
        """
        prices = _get_model_prices(model)
        prompt = usage.get("prompt_token_count", 0)
        cached = usage.get("cached_content_token_count", 0)
        # DeepSeek folds reasoning into completion_tokens; the dispatcher's
        # thoughts_token_count is always 0 for us, but we sum to be safe.
        output_ = usage.get("candidates_token_count", 0) + usage.get("thoughts_token_count", 0)
        fresh = max(0, prompt - cached)
        return (
            (fresh   / 1_000_000) * prices["input"]
          + (cached  / 1_000_000) * prices["cache"]
          + (output_ / 1_000_000) * prices["output"]
        )
