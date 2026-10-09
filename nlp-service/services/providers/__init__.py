"""Provider abstraction for LLM backends (Gemini, DeepSeek, etc.).

Phase 2 ships the Protocol + GeminiProvider; Phase 4 adds DeepSeekProvider.
The factory dispatches by model-name prefix:
    gemini-*    -> GeminiProvider
    deepseek-*  -> DeepSeekProvider (Phase 4 — currently raises NotImplementedError)
    anything else -> ValueError

This module is the single source of truth for the model -> provider mapping.
"""

from __future__ import annotations

from .base import (
    LLMProvider,
    LLMRequest,
    LLMResult,
    ProviderError,
    ProviderRateLimitedError,
    ProviderTransientError,
)

__all__ = [
    "LLMProvider",
    "LLMRequest",
    "LLMResult",
    "ProviderError",
    "ProviderRateLimitedError",
    "ProviderTransientError",
    "get_provider",
    "translate_thinking_budget",
]


# Cache one instance per provider name. GeminiProvider is a stateful singleton —
# it owns the genai client and the in-process pyrate-limiter bucket. Recreating
# it per call would defeat the limiter.
_REGISTRY: dict[str, LLMProvider] = {}


def get_provider(model: str) -> LLMProvider:
    """Return the LLMProvider that handles ``model``.

    Dispatch is by model-name prefix; the abstraction is pre-committed to
    Phase 2 (Anthropic) by the same prefix shape.
    """
    if model.startswith("gemini-"):
        from .gemini import GeminiProvider
        return _REGISTRY.setdefault("gemini", GeminiProvider())
    if model.startswith("deepseek-"):
        from .deepseek import DeepSeekProvider
        return _REGISTRY.setdefault("deepseek", DeepSeekProvider())
    raise ValueError(f"unknown provider for model {model!r}")


def translate_thinking_budget(provider: str, call_site: str, raw: int) -> object:
    """Translate the int thinking-budget knob into per-provider shape.

    Gemini takes the int as-is (passthrough); gemini.py maps it onto a
    thinking_level for Gemini 3 models. DeepSeek's ``reasoning_effort``
    accepts ``none`` / ``low`` / ``high`` / ``max`` (api-docs.deepseek.com,
    read 2026-10-09). DeepSeek folds ``medium`` into ``high`` server-side, so
    budgets 1025-8192 land on ``high`` either way. ``none`` means thinking
    off; a negative ("dynamic") budget keeps DeepSeek's default effort.
    """
    if provider == "gemini":
        return raw
    if provider == "deepseek":
        if raw == 0:
            return "none"
        if raw < 0:
            return "high"
        if raw <= 1024:
            return "low"
        if raw <= 8192:
            return "high"
        return "max"
    raise ValueError(f"unknown provider {provider!r}")
