"""Gemini backend for the LLMProvider Protocol.

Behaviour-preserving extract from llm_client.py: client construction,
retry wrapper, rate limiter, price table, MAX_TOKENS detection, usage
logging. The dispatcher (llm_client.py) keeps the salvage path, the
daily-cap accounting, and the per-call-site error translation —
those are provider-agnostic.

This module MUST NOT import services.llm_client at module level — gemini.py
is loaded lazily by ``providers.get_provider()`` AFTER llm_client.py has
finished its own module-load. Functions that need llm_client.* (the
``LLMRateLimitedError`` type, the ``_check_and_record_cost`` callback) use
lazy ``from services import llm_client`` inside the function body. That
also keeps the test fixture's
``monkeypatch.setattr(llm_client, "_check_and_record_cost", mock)`` effective
via attribute lookup at call time.
"""

from __future__ import annotations

import os
import sys
import time
from typing import Any, Callable, TypeVar

import httpx
from google import genai
from google.genai import types
from pydantic import BaseModel
from pyrate_limiter import Duration, InMemoryBucket, Limiter, Rate

from .base import LLMRequest, LLMResult

# google-genai raises its own error types (ClientError / ServerError / APIError)
# that generic retry predicates miss — see cookbook issue #1091. Catch the
# APIError base and filter by status code below. Tolerate SDK layout drift
# (the class moved between minor releases): a missing module just means the
# retry loop's ``except _APIError`` becomes a safe no-op.
try:
    from google.genai import errors as _genai_errors
    _APIError: Any = _genai_errors.APIError
except (ImportError, AttributeError):  # pragma: no cover
    _APIError = tuple()

T = TypeVar("T")


# ---------------------------------------------------------------------------
# Configuration from environment
# ---------------------------------------------------------------------------

_GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
_GEMINI_RPM = int(os.environ.get("GEMINI_RPM", "800"))


# ---------------------------------------------------------------------------
# Pricing (Gemini 2.5-family, $/M tokens, 2026-04 public rates)
# ---------------------------------------------------------------------------
#
# cost = (prompt_tokens - cached_tokens) * input_rate
#      + cached_tokens                   * cache_rate    (≈ 0.1x input)
#      + (candidates_tokens + thoughts_tokens) * output_rate
#
# Thinking tokens billed at the output rate per
#   https://ai.google.dev/gemini-api/docs/thinking
# Cached tokens are still counted in prompt_token_count per
#   https://ai.google.dev/api/generate-content
# so we subtract explicitly to avoid double-counting.

_MODEL_PRICES: dict[str, dict[str, float]] = {
    "gemini-2.5-flash-lite": {"input": 0.10, "output": 0.40, "cache": 0.01},
    "gemini-2.5-flash":      {"input": 0.30, "output": 2.50, "cache": 0.03},
    # Pro tiered — ≤200k prompts use the small-context SKU. >200k switches to
    # $2.50 / $15 / $0.25; we don't auto-detect that boundary here. If Pro is
    # routinely exercised with >200k prompts, override via env vars below.
    "gemini-2.5-pro":        {"input": 1.25, "output": 10.00, "cache": 0.125},
}

# Env overrides — last-resort escape hatch when Gemini changes pricing and
# the code hasn't been updated yet. Apply to all models.
_INPUT_PRICE_OVERRIDE  = os.environ.get("GEMINI_INPUT_PRICE_PER_M")
_OUTPUT_PRICE_OVERRIDE = os.environ.get("GEMINI_OUTPUT_PRICE_PER_M")
_CACHE_PRICE_OVERRIDE  = os.environ.get("GEMINI_CACHE_PRICE_PER_M")


def _get_model_prices(model: str) -> dict[str, float]:
    """Return {input, output, cache} per-million-token prices for ``model``.

    Falls back to gemini-2.5-flash-lite rates for unknown models so an SDK
    bump to a new model name doesn't silently crash pricing.
    """
    base = _MODEL_PRICES.get(model, _MODEL_PRICES["gemini-2.5-flash-lite"])
    return {
        "input":  float(_INPUT_PRICE_OVERRIDE)  if _INPUT_PRICE_OVERRIDE  else base["input"],
        "output": float(_OUTPUT_PRICE_OVERRIDE) if _OUTPUT_PRICE_OVERRIDE else base["output"],
        "cache":  float(_CACHE_PRICE_OVERRIDE)  if _CACHE_PRICE_OVERRIDE  else base["cache"],
    }


# ---------------------------------------------------------------------------
# Rate limiter — in-process token bucket, async-safe
# ---------------------------------------------------------------------------

_limiter: Limiter | None = None


def _get_limiter() -> Limiter:
    global _limiter
    if _limiter is None:
        _limiter = Limiter(
            InMemoryBucket([Rate(_GEMINI_RPM, Duration.MINUTE)]),
            raise_when_fail=False,
            max_delay=60_000,  # wait up to 60s before giving up
        )
    return _limiter


# ---------------------------------------------------------------------------
# Gemini client (lazy init — validated at startup by main.py lifespan)
# ---------------------------------------------------------------------------

_client: genai.Client | None = None


def get_client() -> genai.Client:
    global _client
    if _client is None:
        if not _GEMINI_API_KEY:
            raise RuntimeError("GEMINI_API_KEY not set")
        _client = genai.Client(api_key=_GEMINI_API_KEY)
    return _client


# ---------------------------------------------------------------------------
# Retry wrapper for transient upstream errors. google-genai 1.12.1 has no
# built-in retry; HttpRetryOptions was added in ≥1.65 — a 60-version jump
# we're not taking mid-debug. Retries on connection-class errors + Gemini
# APIError with retryable status codes (408/429/5xx). The rate-limiter
# token is re-acquired per attempt so retries count against the 800 RPM cap.
# Apply only to read-only analyzers (extract/resolve/match/triage/…) —
# never wrap draft_page / synthesize / digest, whose outputs commit
# downstream state and can't be safely re-executed after a partial response.
# ---------------------------------------------------------------------------

_RETRYABLE_STATUSES: frozenset[int] = frozenset({408, 429, 500, 502, 503, 504})


def _with_retry(
    fn: Callable[[], T], step: str, *, max_attempts: int = 3, base_delay: float = 0.5,
) -> T:
    # Lazy import: keeps the public LLMRateLimitedError type at the dispatcher
    # layer, avoids circular import at module load time.
    from services.llm_client import LLMRateLimitedError

    limiter = _get_limiter()
    last_exc: Exception | None = None

    for i in range(max_attempts):
        if not limiter.try_acquire("gemini"):
            raise LLMRateLimitedError(f"llm_rate_limited: bucket exhausted on {step}")

        try:
            return fn()
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
        except _APIError as e:
            code = getattr(e, "code", None) or getattr(e, "status_code", None)
            if code not in _RETRYABLE_STATUSES:
                raise
            last_exc = e
            err_class = f"APIError{code}"

        if i < max_attempts - 1:
            delay = base_delay * (2 ** i)
            print(
                f"[llm-retry] {step} attempt {i + 1}/{max_attempts} after "
                f"{err_class}: {str(last_exc)[:200]} — sleeping {delay}s",
                file=sys.stderr,
                flush=True,
            )
            time.sleep(delay)

    assert last_exc is not None
    raise last_exc


# ---------------------------------------------------------------------------
# Logging / usage helpers
# ---------------------------------------------------------------------------


def _log_usage(step: str, response: Any) -> None:
    """One-line stderr log per Gemini call: finish_reason + token counts.

    Ground truth for distinguishing a MAX_TOKENS truncation from a normal
    STOP, an empty response, or a thinking-budget exhaustion. Non-fatal:
    a broken log must never break the caller, so swallow any exception.
    """
    try:
        candidates = getattr(response, "candidates", None) or []
        finish = "NONE"
        if candidates:
            fr = getattr(candidates[0], "finish_reason", None)
            finish = str(fr).split(".")[-1] if fr is not None else "NONE"
        usage = getattr(response, "usage_metadata", None)
        if usage is not None:
            ptok = getattr(usage, "prompt_token_count", 0) or 0
            ctok = getattr(usage, "candidates_token_count", 0) or 0
            ttok = getattr(usage, "thoughts_token_count", 0) or 0
            print(
                f"[gemini] step={step} finish={finish} in={ptok} out={ctok} thinking={ttok}",
                file=sys.stderr,
                flush=True,
            )
        else:
            print(f"[gemini] step={step} finish={finish} usage=none", file=sys.stderr, flush=True)
    except Exception:
        pass


def _read_finish_reason(response: Any) -> str:
    candidates = getattr(response, "candidates", None) or []
    if not candidates:
        return "NONE"
    fr = getattr(candidates[0], "finish_reason", None)
    return str(fr).split(".")[-1] if fr is not None else "NONE"


def _read_usage_dict(response: Any) -> dict[str, int]:
    usage = getattr(response, "usage_metadata", None)
    if usage is None:
        return {}
    return {
        "prompt_token_count":         int(getattr(usage, "prompt_token_count", 0) or 0),
        "cached_content_token_count": int(getattr(usage, "cached_content_token_count", 0) or 0),
        "candidates_token_count":     int(getattr(usage, "candidates_token_count", 0) or 0),
        "thoughts_token_count":       int(getattr(usage, "thoughts_token_count", 0) or 0),
    }


# ---------------------------------------------------------------------------
# GeminiProvider
# ---------------------------------------------------------------------------


class GeminiProvider:
    """LLMProvider implementation backed by the google-genai SDK.

    Owns the lazily-initialised genai client and the per-process
    pyrate-limiter bucket. ``providers.get_provider("gemini-...")`` caches
    one instance per process.
    """

    name = "gemini"

    def complete(self, req: LLMRequest) -> LLMResult:
        # Build genai config from the canonical LLMRequest fields. Today's
        # call sites always set thinking_config (even when budget=0) — match
        # that contract verbatim so behaviour is byte-for-byte preserved.
        config_kwargs: dict[str, Any] = {
            "max_output_tokens": req.max_output_tokens,
            "thinking_config": types.ThinkingConfig(thinking_budget=req.thinking_budget),
        }
        if req.temperature is not None:
            config_kwargs["temperature"] = req.temperature
        if req.response_model is not None:
            config_kwargs["response_mime_type"] = "application/json"
            config_kwargs["response_schema"] = req.response_model
        elif req.extra.get("force_json_mime"):
            # lint_scan today: response_mime_type=json without a Pydantic schema.
            config_kwargs["response_mime_type"] = "application/json"

        # Phase 2 dual-shape adapter: a lone user message goes straight to
        # ``contents`` (today's concatenated pattern); explicit system+user
        # messages map system to ``system_instruction``. Phase 3 narrows to
        # always-explicit roles.
        system_parts = [m["content"] for m in req.messages if m.get("role") == "system"]
        user_parts   = [m["content"] for m in req.messages if m.get("role") == "user"]
        if system_parts:
            config_kwargs["system_instruction"] = "\n\n".join(system_parts)
        contents = user_parts[0] if len(user_parts) == 1 else "\n\n".join(user_parts)

        config = types.GenerateContentConfig(**config_kwargs)
        client = get_client()

        def _call() -> Any:
            return client.models.generate_content(model=req.model, contents=contents, config=config)

        if req.extra.get("retry", True):
            response = _with_retry(_call, step=req.step)
        else:
            # Free-form / state-committing paths (draft_page, synthesize, digest):
            # acquire the limiter manually and skip retry — semantically
            # identical to the existing inline rate-limit checks.
            from services.llm_client import LLMRateLimitedError  # lazy
            limiter = _get_limiter()
            if not limiter.try_acquire("gemini"):
                raise LLMRateLimitedError("llm_rate_limited: bucket exhausted")
            response = _call()

        # Log + record cost. Lazy import respects test-fixture monkeypatching
        # of llm_client._check_and_record_cost.
        _log_usage(req.step, response)
        usage_dict = _read_usage_dict(response)
        if usage_dict:
            from services import llm_client  # lazy
            llm_client._check_and_record_cost(
                req.model,
                usage_dict["prompt_token_count"],
                usage_dict["cached_content_token_count"],
                usage_dict["candidates_token_count"],
                usage_dict["thoughts_token_count"],
            )

        # Pack result. Parse on demand if a Pydantic schema was requested;
        # the dispatcher's salvage path (extract_source) checks ``parsed is None``
        # and re-runs json-repair / halved-input fallback when needed.
        text = response.text or ""
        parsed: BaseModel | None = None
        parse_error: Exception | None = None
        if req.response_model is not None and text:
            try:
                parsed = req.response_model.model_validate_json(text)
            except Exception as e:
                parse_error = e

        return LLMResult(
            text=text,
            parsed=parsed,
            parse_error=parse_error,
            usage=usage_dict,
            finish_reason=_read_finish_reason(response),
        )

    def cost_usd(self, model: str, usage: dict[str, int]) -> float:
        """Per-call cost in USD, computed from Gemini's usage_metadata fields."""
        prices = _get_model_prices(model)
        prompt = usage.get("prompt_token_count", 0)
        cached = usage.get("cached_content_token_count", 0)
        out_   = usage.get("candidates_token_count", 0)
        think  = usage.get("thoughts_token_count", 0)
        fresh = max(0, prompt - cached)
        return (
            (fresh   / 1_000_000) * prices["input"]
          + (cached  / 1_000_000) * prices["cache"]
          + (out_    / 1_000_000) * prices["output"]
          + (think   / 1_000_000) * prices["output"]
        )
