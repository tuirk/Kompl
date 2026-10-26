"""Gemini backend for the LLMProvider Protocol.

Behaviour-preserving extract from llm_client.py: client construction,
retry wrapper, rate limiter, price table, MAX_TOKENS detection, usage
logging. The dispatcher (llm_client.py) keeps the salvage path, the
daily-cap accounting, and the per-call-site error translation —
those are provider-agnostic.

This module MUST NOT import services.llm_client at module level — gemini.py
is loaded lazily by ``providers.get_provider()`` AFTER llm_client.py has
finished its own module-load. Functions that need llm_client.* (the
``LLMRateLimitedError`` type, the ``_spend_reservation`` daily-cap gate, the
``_check_and_record_cost`` callback) use
lazy ``from services import llm_client`` inside the function body. That
also keeps the test fixture's
``monkeypatch.setattr(llm_client, "_check_and_record_cost", mock)`` effective
via attribute lookup at call time.
"""

from __future__ import annotations

import os
import sys
import time
from datetime import date, datetime, timezone
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
# Pricing ($/M tokens; 2.5 rates read 2026-04, 3.x rates read 2026-10-09)
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
    # 3.8 Flash is on an introductory rate through 2026-12-31;
    # _SCHEDULED_PRICES moves it to the standard rate on 2027-01-01.
    "gemini-3.8-flash":       {"input": 0.75, "output": 3.75, "cache": 0.075},
    # No context-caching rate is listed for 3.5 Flash-Lite: bill cached
    # tokens at the input rate, which never under-counts.
    "gemini-3.5-flash-lite":  {"input": 0.30, "output": 2.50, "cache": 0.30},
    # Preview; <=200k-token prompts (>200k: $4.00 / $18.00 / $0.40).
    "gemini-3.1-pro-preview": {"input": 2.00, "output": 12.00, "cache": 0.20},
}

# Announced list-price changes, applied from their effective UTC date so the
# daily cap never under-counts after a known increase.
_SCHEDULED_PRICES: list[tuple[str, date, dict[str, float]]] = [
    ("gemini-3.8-flash", date(2027, 1, 1), {"input": 1.50, "output": 7.50, "cache": 0.15}),
]

# Env overrides — last-resort escape hatch when Gemini changes pricing and
# the code hasn't been updated yet. Apply to all models.
_INPUT_PRICE_OVERRIDE  = os.environ.get("GEMINI_INPUT_PRICE_PER_M")
_OUTPUT_PRICE_OVERRIDE = os.environ.get("GEMINI_OUTPUT_PRICE_PER_M")
_CACHE_PRICE_OVERRIDE  = os.environ.get("GEMINI_CACHE_PRICE_PER_M")


def _utc_today() -> date:
    return datetime.now(timezone.utc).date()


# Gemini 3.x replaces thinking_budget with thinking_level and rejects a
# request that sends both. Supported levels differ per model
# (ai.google.dev/gemini-api/docs/thinking, read 2026-10-09). Google also
# advises keeping temperature at its 1.0 default on 3.x (lower values can
# loop or degrade output), so 3.x requests omit it.
_GEMINI3_THINKING_LEVELS: dict[str, tuple[str, ...]] = {
    "gemini-3.8-flash":       ("low", "medium", "high"),
    "gemini-3.5-flash-lite":  ("minimal", "low", "medium", "high"),
    "gemini-3.1-pro-preview": ("low", "medium", "high"),
}


def _is_gemini3(model: str) -> bool:
    return model.startswith("gemini-3")


def _thinking_level_for(model: str, budget: int) -> str | None:
    """Map Kompl's per-step thinking budget onto a Gemini 3 thinking_level.

    0 -> the model's lowest level ('minimal' where offered, else 'low');
    up to 1024 -> 'low'; up to 8192 -> 'medium'; above -> 'high'. A
    negative ("dynamic") budget returns None: keep the model's default.
    """
    if budget < 0:
        return None
    if budget == 0:
        return _GEMINI3_THINKING_LEVELS[model][0]
    if budget <= 1024:
        return "low"
    if budget <= 8192:
        return "medium"
    return "high"


def _get_model_prices(model: str) -> dict[str, float]:
    """Return {input, output, cache} per-million-token prices for ``model``.

    Falls back to gemini-2.5-flash-lite rates for unknown models so an SDK
    bump to a new model name doesn't silently crash pricing.
    """
    base = _MODEL_PRICES.get(model, _MODEL_PRICES["gemini-2.5-flash-lite"])
    today = _utc_today()
    for scheduled_model, effective, scheduled in _SCHEDULED_PRICES:
        if scheduled_model == model and today >= effective:
            base = scheduled
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

# Errors after the request went out, before an answer came back: Gemini may
# have answered and billed it (llm_client._record_unanswered).
_SENT_ERRORS = (httpx.ReadTimeout, httpx.ReadError, httpx.RemoteProtocolError)
# Errors before the request reached Gemini: nothing to bill.
_UNSENT_ERRORS = (httpx.ConnectError, httpx.PoolTimeout, httpx.WriteTimeout, httpx.WriteError)


def _send(fn: Callable[[], T], req: LLMRequest) -> T:
    """One attempt; an attempt sent without an answer counts its worst case."""
    from services import llm_client  # lazy

    try:
        return fn()
    except _SENT_ERRORS:
        llm_client._record_unanswered(req)
        raise


def _no_time_left(req: LLMRequest) -> bool:
    """A call with a deadline sends no attempt that cannot end before the
    app stops waiting (llm_client._CALL_DEADLINE_S)."""
    from services import llm_client  # lazy

    left = llm_client._time_left(req)
    return left is not None and left < llm_client._MIN_ATTEMPT_S


def _with_retry(
    fn: Callable[[], T], req: LLMRequest, *, max_attempts: int = 3, base_delay: float = 0.5,
) -> T:
    # Lazy import: keeps the public LLMRateLimitedError type at the dispatcher
    # layer, avoids circular import at module load time.
    from services.llm_client import LLMRateLimitedError

    step = req.step
    limiter = _get_limiter()
    last_exc: Exception | None = None

    for i in range(max_attempts):
        if _no_time_left(req):
            if last_exc is None:
                raise TimeoutError(f"no time left for {step} before the app stops waiting")
            break
        if not limiter.try_acquire("gemini"):
            raise LLMRateLimitedError(f"llm_rate_limited: bucket exhausted on {step}")

        try:
            return _send(fn, req)
        except (*_SENT_ERRORS, *_UNSENT_ERRORS) as e:
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
        config_kwargs: dict[str, Any] = {"max_output_tokens": req.max_output_tokens}
        if _is_gemini3(req.model):
            level = _thinking_level_for(req.model, req.thinking_budget)
            if level is not None:
                config_kwargs["thinking_config"] = types.ThinkingConfig(
                    thinking_level=types.ThinkingLevel[level.upper()]
                )
        else:
            # Gemini 2.5: unchanged — always a thinking_budget (even 0) and
            # the call site's temperature.
            config_kwargs["thinking_config"] = types.ThinkingConfig(thinking_budget=req.thinking_budget)
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
            # With a deadline, an attempt waits only for what is left of it.
            from services import llm_client  # lazy
            left = llm_client._time_left(req)
            call_config = config
            if left is not None:
                call_config = config.model_copy(
                    update={"http_options": types.HttpOptions(timeout=max(1, int(left * 1000)))}
                )
            return client.models.generate_content(model=req.model, contents=contents, config=call_config)

        # Daily cap: refused here, before anything is sent, once today's
        # recorded spend has reached it; the place is held until the cost is
        # recorded. Lazy import respects test-fixture monkeypatching of
        # llm_client._check_and_record_cost.
        from services import llm_client  # lazy
        with llm_client._spend_reservation(req):
            if req.extra.get("retry", True):
                response = _with_retry(_call, req)
            else:
                # Free-form / state-committing paths (draft_page, synthesize, digest):
                # acquire the limiter manually and skip retry — semantically
                # identical to the existing inline rate-limit checks.
                if _no_time_left(req):
                    raise TimeoutError(f"no time left for {req.step} before the app stops waiting")
                limiter = _get_limiter()
                if not limiter.try_acquire("gemini"):
                    raise llm_client.LLMRateLimitedError("llm_rate_limited: bucket exhausted")
                response = _send(_call, req)

            _log_usage(req.step, response)
            usage_dict = _read_usage_dict(response)
            if usage_dict:
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
