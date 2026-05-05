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


def test_get_provider_dispatches_gemini_prefix(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    # Reset cached singleton so the env override takes effect for this test.
    from services import providers as P
    P._REGISTRY.clear()

    from services.providers import get_provider
    from services.providers.gemini import GeminiProvider

    p = get_provider("gemini-2.5-flash")
    assert isinstance(p, GeminiProvider)
    assert p.name == "gemini"
    # Same instance returned on repeat lookups (singleton cache).
    assert get_provider("gemini-2.5-pro") is p

    P._REGISTRY.clear()


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
# Cost-cap message generalisation (Phase 2 task 2.3)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Per-provider extract-input cap (Phase 3 task 3.2)
# ---------------------------------------------------------------------------


def test_extract_input_cap_for_gemini_returns_gemini_cap():
    from services.llm_client import _extract_input_cap_for, _GEMINI_EXTRACT_INPUT_CAP

    assert _extract_input_cap_for("gemini-2.5-flash") == _GEMINI_EXTRACT_INPUT_CAP
    assert _extract_input_cap_for("gemini-2.5-pro") == _GEMINI_EXTRACT_INPUT_CAP
    assert _extract_input_cap_for("gemini-2.5-flash-lite") == _GEMINI_EXTRACT_INPUT_CAP


def test_extract_input_cap_for_deepseek_returns_deepseek_cap():
    from services.llm_client import _extract_input_cap_for, _DEEPSEEK_INPUT_CHAR_CAP

    assert _extract_input_cap_for("deepseek-v4-pro") == _DEEPSEEK_INPUT_CHAR_CAP
    # Future DeepSeek SKUs would also fall through the prefix branch.
    assert _extract_input_cap_for("deepseek-v5-something") == _DEEPSEEK_INPUT_CHAR_CAP


def test_extract_input_cap_for_unknown_falls_back_to_gemini_cap():
    """Unknown prefixes default to the tighter Gemini cap. Better to truncate
    than to ship a bigger input on a provider whose limits we haven't
    validated yet."""
    from services.llm_client import _extract_input_cap_for, _GEMINI_EXTRACT_INPUT_CAP

    assert _extract_input_cap_for("anthropic-claude-4-7") == _GEMINI_EXTRACT_INPUT_CAP


# ---------------------------------------------------------------------------
# Halved-input fallback gate (Phase 3 task 3.3)
# ---------------------------------------------------------------------------


def _make_fake_provider(call_log):
    """Build a stub provider whose ``complete()`` always returns a parse
    failure with finish_reason='MAX_TOKENS'. Records every call into
    ``call_log`` so tests can assert how many times it was invoked.
    """
    from services.providers.base import LLMResult

    class _FakeProvider:
        name = "fake"

        def complete(self, req):
            call_log.append(req.step)
            return LLMResult(
                text='{"entities": [{"name": "x"',  # truncated mid-string
                parsed=None,
                parse_error=ValueError("truncated"),
                usage={},
                finish_reason="MAX_TOKENS",
            )

        def cost_usd(self, model, usage):
            return 0.0

    return _FakeProvider()


def test_extract_halved_fallback_runs_on_gemini(monkeypatch):
    """On gemini-* models with finish_reason=MAX_TOKENS and salvage failure,
    extract_source retries once with halved input — provider.complete is
    called twice (extract + extract-fallback)."""
    from services import llm_client

    log: list[str] = []
    monkeypatch.setattr(llm_client, "get_provider", lambda m: _make_fake_provider(log))
    monkeypatch.setattr(llm_client, "_salvage_extraction", lambda raw: None)

    with pytest.raises(llm_client.LLMCompileError):
        llm_client.extract_source(
            source_id="s1",
            markdown="x" * 1000,
            ner_output={},
            keyphrase_output=None,
            tfidf_output=None,
            model="gemini-2.5-flash",
        )

    assert log == ["extract", "extract-fallback"]


def test_extract_halved_fallback_skipped_on_non_gemini(monkeypatch):
    """For deepseek-* (or any non-gemini prefix), the halved-input fallback
    must be skipped — only one provider.complete call is made and the
    LLMCompileError surfaces the original parse error."""
    from services import llm_client

    log: list[str] = []
    monkeypatch.setattr(llm_client, "get_provider", lambda m: _make_fake_provider(log))
    monkeypatch.setattr(llm_client, "_salvage_extraction", lambda raw: None)

    with pytest.raises(llm_client.LLMCompileError) as exc:
        llm_client.extract_source(
            source_id="s1",
            markdown="x" * 1000,
            ner_output={},
            keyphrase_output=None,
            tfidf_output=None,
            model="deepseek-v4-pro",
        )

    assert log == ["extract"], "halved-fallback must NOT run on deepseek-*"
    assert "extract_llm_parse_failed" in str(exc.value)


def test_cost_cap_error_message_says_llm_not_gemini(monkeypatch, tmp_path):
    """The cap error message generalises now that DeepSeek is on the way.

    Pre-Phase-2.3 the message said "Daily Gemini spend"; Phase 4 will see
    operators run DeepSeek-only sessions, where "Gemini" would be misleading.
    """
    from services import llm_client
    # Point the cap files at a temp dir + force a small cap.
    monkeypatch.setattr(llm_client, "_CAP_FILE", tmp_path / "cap.json")
    monkeypatch.setattr(llm_client, "_CONFIG_FILE", tmp_path / "cfg.json")
    monkeypatch.setattr(llm_client, "_read_daily_cap_usd", lambda: 0.0001)

    with pytest.raises(llm_client.CostCeilingError) as exc:
        # Use enough tokens to definitely exceed 0.0001 cap on flash pricing
        # (input rate 0.30 / M; 1M prompt tokens = $0.30, well over $0.0001).
        llm_client._check_and_record_cost("gemini-2.5-flash", 1_000_000, 0, 1_000_000, 0)
    assert "Daily LLM spend" in str(exc.value)
    assert "Gemini" not in str(exc.value)


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
