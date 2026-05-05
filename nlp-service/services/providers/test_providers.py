"""Unit tests for the provider abstraction.

Phase 2 covers: LLMRequest/LLMResult shape, factory dispatch (gemini-* -> ok,
deepseek-* -> NotImplementedError, anything else -> ValueError),
translate_thinking_budget mapping. Phase 4 will extend with DeepSeek-specific
tests (json_object injection, retry on 429, discount-boundary).
"""

from __future__ import annotations

import pytest
from pydantic import BaseModel


# ---------------------------------------------------------------------------
# LLMRequest / LLMResult shape
# ---------------------------------------------------------------------------


def test_llm_request_minimal_shape():
    from services.providers.base import LLMRequest

    req = LLMRequest(
        model="gemini-2.5-flash",
        messages=[{"role": "user", "content": "hi"}],
    )
    assert req.model == "gemini-2.5-flash"
    assert req.messages[0]["role"] == "user"
    assert req.response_model is None
    assert req.thinking_budget == 0
    assert req.temperature is None
    assert req.extra == {}


def test_llm_request_full_shape():
    from services.providers.base import LLMRequest

    class Out(BaseModel):
        ok: bool

    req = LLMRequest(
        model="gemini-2.5-flash",
        messages=[
            {"role": "system", "content": "be terse"},
            {"role": "user", "content": "go"},
        ],
        response_model=Out,
        thinking_budget=1024,
        max_output_tokens=4096,
        temperature=0.0,
        step="test",
        extra={"retry": False, "force_json_mime": True},
    )
    assert req.response_model is Out
    assert req.thinking_budget == 1024
    assert req.extra["retry"] is False


def test_llm_result_carries_text_parsed_usage_finish():
    from services.providers.base import LLMResult

    res = LLMResult(
        text="ok",
        parsed=None,
        parse_error=None,
        usage={"prompt_token_count": 10},
        finish_reason="STOP",
    )
    assert res.text == "ok"
    assert res.parsed is None
    assert res.parse_error is None
    assert res.usage["prompt_token_count"] == 10
    assert res.finish_reason == "STOP"


# ---------------------------------------------------------------------------
# Factory dispatch
# ---------------------------------------------------------------------------


def test_get_provider_deepseek_raises_until_phase_4():
    from services.providers import get_provider

    with pytest.raises(NotImplementedError):
        get_provider("deepseek-v4-pro")


def test_get_provider_unknown_raises_value_error():
    from services.providers import get_provider

    with pytest.raises(ValueError, match="unknown provider"):
        get_provider("anthropic-claude-4-7")
    with pytest.raises(ValueError, match="unknown provider"):
        get_provider("not-a-real-model")


# ---------------------------------------------------------------------------
# translate_thinking_budget mapping
# ---------------------------------------------------------------------------


def test_translate_thinking_budget_gemini_passthrough():
    from services.providers import translate_thinking_budget

    for raw in [0, 1024, 2048, 8192, 32768, -1]:
        assert translate_thinking_budget("gemini", "extract", raw) == raw


@pytest.mark.parametrize(
    "raw,expected",
    [
        (0, "disabled"),
        (1, "low"),
        (1024, "low"),
        (1025, "medium"),
        (2048, "medium"),
        (2049, "high"),
        (8192, "high"),
        (8193, "max"),
        (32768, "max"),
    ],
)
def test_translate_thinking_budget_deepseek_enum(raw, expected):
    from services.providers import translate_thinking_budget

    assert translate_thinking_budget("deepseek", "extract", raw) == expected


def test_translate_thinking_budget_unknown_provider_raises():
    from services.providers import translate_thinking_budget

    with pytest.raises(ValueError, match="unknown provider"):
        translate_thinking_budget("openai", "extract", 0)
