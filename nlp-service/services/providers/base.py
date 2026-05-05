"""Provider Protocol + canonical request/result dataclasses.

Every LLM call site in llm_client.py builds an ``LLMRequest`` and passes it to
``provider.complete()``; the provider returns an ``LLMResult``. The dispatcher
layer (llm_client.py) stays provider-agnostic — _salvage_extraction(),
_check_and_record_cost(), and the per-call-site error-translation logic live
there.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol

from pydantic import BaseModel


# ---------------------------------------------------------------------------
# Request / Result dataclasses
# ---------------------------------------------------------------------------


@dataclass
class LLMRequest:
    """Canonical input shape for ``LLMProvider.complete()``.

    Attributes
    ----------
    model
        Full model name including provider prefix ("gemini-2.5-flash",
        "deepseek-v4-pro"). The factory dispatches on prefix.
    messages
        ``[{"role": "system"|"user", "content": str}, ...]``.
        Phase 2 lets call sites pass a single user message containing the
        already-concatenated system+user text (today's pattern); Phase 3
        narrows to explicit ``system`` + ``user`` shape.
    response_model
        Pydantic schema enforced server-side (Gemini ``response_schema``,
        DeepSeek ``response_format=json_object``). ``None`` for free-form text.
    thinking_budget
        Raw int budget. Provider translates: Gemini int passthrough, DeepSeek
        enum (see ``translate_thinking_budget`` in providers/__init__.py).
    max_output_tokens
        Hard ceiling on response tokens; the master plan caps Gemini at 32K
        per the repetition-loop research artifact.
    temperature
        ``None`` to leave provider default; explicit ``0.0`` for deterministic
        structured output, ``0.3`` for creative-text drafts.
    step
        Stable label used in usage logs and cost-cap accounting
        (e.g. ``"extract"``, ``"draft_page"``, ``"crossref"``).
    extra
        Provider-agnostic escape hatches:
          ``"retry": bool`` — when False, skip the retry wrapper. Use for
              draft_page / synthesize / digest whose outputs commit downstream
              state and can't be safely re-executed after a partial response.
          ``"force_json_mime": bool`` — request JSON mime-type without a
              Pydantic schema. Used by lint_scan, which json.loads() the
              response manually downstream.
    """

    model: str
    messages: list[dict[str, str]]
    response_model: type[BaseModel] | None = None
    thinking_budget: int = 0
    max_output_tokens: int = 2048
    temperature: float | None = None
    step: str = ""
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class LLMResult:
    """Canonical output shape from ``LLMProvider.complete()``.

    Attributes
    ----------
    text
        Raw response text. Empty string for empty responses; never ``None``.
    parsed
        ``response_model.model_validate_json(text)`` if a schema was requested
        AND parsing succeeded; ``None`` otherwise. The dispatcher's salvage
        path checks ``parsed is None`` then re-attempts parse + json-repair.
    parse_error
        The exception raised by the in-provider parse attempt, when
        ``response_model`` was set but parsing failed. ``None`` if parsing
        succeeded or if no parse was attempted. Lets the dispatcher chain
        the error message into LLMCompileError without re-running the parse.
    usage
        Provider-native token counts. The dispatcher passes this dict
        verbatim to ``provider.cost_usd(model, usage)``.
    finish_reason
        Provider-native finish reason string. Gemini values include "STOP"
        and "MAX_TOKENS"; the dispatcher's salvage path checks for the
        latter to decide whether to run the halved-input fallback.
    """

    text: str
    parsed: BaseModel | None
    parse_error: Exception | None
    usage: dict[str, int]
    finish_reason: str


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class ProviderError(Exception):
    """Base for provider-side errors. Dispatcher wraps as needed."""


class ProviderRateLimitedError(ProviderError):
    """In-process rate-limiter bucket exhausted."""


class ProviderTransientError(ProviderError):
    """Retryable upstream error (408/429/5xx)."""


# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------


class LLMProvider(Protocol):
    """Minimal contract every backend must satisfy.

    Implementations are stateful (they own a SDK client + a rate-limiter
    bucket). The factory in providers/__init__.py caches one instance per
    provider name.
    """

    name: str

    def complete(self, req: LLMRequest) -> LLMResult: ...

    def cost_usd(self, model: str, usage: dict[str, int]) -> float: ...
