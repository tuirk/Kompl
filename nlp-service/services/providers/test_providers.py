"""Unit tests for the provider abstraction.

Phase 2 covers: LLMRequest/LLMResult shape, factory dispatch (gemini-* -> ok,
deepseek-* -> NotImplementedError, anything else -> ValueError),
translate_thinking_budget mapping. Phase 4 will extend with DeepSeek-specific
tests (json_object injection, retry on 429, discount-boundary).
"""

from __future__ import annotations

from unittest.mock import MagicMock

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


def test_get_provider_dispatches_deepseek_prefix(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    from services import providers as P
    P._REGISTRY.clear()

    from services.providers import get_provider
    from services.providers.deepseek import DeepSeekProvider

    p = get_provider("deepseek-v4-pro")
    assert isinstance(p, DeepSeekProvider)
    assert p.name == "deepseek"
    # Singleton cache: same instance on repeat lookup.
    assert get_provider("deepseek-v5-future") is p

    P._REGISTRY.clear()


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


# ---------------------------------------------------------------------------
# DeepSeekProvider.complete() (Phase 4)
# ---------------------------------------------------------------------------


def _stub_deepseek_post(monkeypatch, status_codes, body=None):
    """Patch httpx.Client.post to walk through ``status_codes`` returning
    a canned 200 body on a 200 code and a minimal text payload on others.

    Returns the captured-bodies list so tests can assert on the request
    JSON for each invocation.
    """
    captured: list[dict] = []
    iterator = iter(status_codes)
    default_body = body or {
        "choices": [{
            "message": {"content": '{"ok": true}'},
            "finish_reason": "stop",
        }],
        "usage": {
            "prompt_tokens": 100,
            "completion_tokens": 20,
            "prompt_cache_hit_tokens": 0,
        },
    }

    class _FakeResponse:
        def __init__(self, status):
            self.status_code = status
            self.text = "rate limited" if status != 200 else ""
        def json(self):
            return default_body

    def _fake_post(self, url, json=None, **kw):
        captured.append(json)
        try:
            code = next(iterator)
        except StopIteration:
            code = 200
        return _FakeResponse(code)

    monkeypatch.setattr("httpx.Client.post", _fake_post)
    monkeypatch.setattr("time.sleep", lambda *_: None)
    return captured


def _ensure_clean_deepseek_singleton(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    from services import providers as P
    from services.providers import deepseek as D
    P._REGISTRY.clear()
    # Reset any module-level caches the previous test may have populated.
    D._client = None
    D._limiter = None
    # The pyrate-limiter constructor signature differs across versions
    # (the container's 3.7.1 pin accepts ``raise_when_fail`` as a kwarg, but
    # other host-local installs do not). Tests don't need a real bucket —
    # stub _get_limiter to a permissive MagicMock that always grants tokens.
    fake_limiter = MagicMock()
    fake_limiter.try_acquire.return_value = True
    monkeypatch.setattr(D, "_get_limiter", lambda: fake_limiter)
    return fake_limiter


def test_deepseek_complete_injects_json_response_format(monkeypatch):
    """When response_model is set the request body MUST carry response_format."""
    _ensure_clean_deepseek_singleton(monkeypatch)
    from pydantic import BaseModel as _BM
    from services.providers import get_provider
    from services.providers.base import LLMRequest

    class _Out(_BM):
        ok: bool

    captured = _stub_deepseek_post(monkeypatch, [200])
    p = get_provider("deepseek-v4-pro")
    req = LLMRequest(
        model="deepseek-v4-pro",
        messages=[
            {"role": "system", "content": "be terse — return json"},
            {"role": "user",   "content": "go"},
        ],
        response_model=_Out,
        thinking_budget=0,
        max_output_tokens=512,
        temperature=0.0,
        step="t",
    )
    result = p.complete(req)
    assert captured[0]["response_format"] == {"type": "json_object"}
    assert result.parsed.ok is True
    assert result.text == '{"ok": true}'
    assert result.finish_reason == "STOP"


def test_deepseek_complete_omits_response_format_when_no_schema(monkeypatch):
    _ensure_clean_deepseek_singleton(monkeypatch)
    from services.providers import get_provider
    from services.providers.base import LLMRequest

    captured = _stub_deepseek_post(monkeypatch, [200])
    p = get_provider("deepseek-v4-pro")
    req = LLMRequest(
        model="deepseek-v4-pro",
        messages=[{"role": "user", "content": "free-form please"}],
        response_model=None,
        thinking_budget=0,
        max_output_tokens=512,
        step="t",
    )
    p.complete(req)
    assert "response_format" not in captured[0]


def test_deepseek_complete_attaches_reasoning_effort_when_thinking_enabled(monkeypatch):
    _ensure_clean_deepseek_singleton(monkeypatch)
    from services.providers import get_provider
    from services.providers.base import LLMRequest

    captured = _stub_deepseek_post(monkeypatch, [200])
    p = get_provider("deepseek-v4-pro")
    req = LLMRequest(
        model="deepseek-v4-pro",
        messages=[{"role": "user", "content": "go"}],
        response_model=None,
        thinking_budget=2048,  # -> "medium" per translate_thinking_budget
        max_output_tokens=512,
        step="extract",
    )
    p.complete(req)
    assert captured[0]["reasoning_effort"] == "medium"


def test_deepseek_complete_omits_reasoning_when_budget_zero(monkeypatch):
    _ensure_clean_deepseek_singleton(monkeypatch)
    from services.providers import get_provider
    from services.providers.base import LLMRequest

    captured = _stub_deepseek_post(monkeypatch, [200])
    p = get_provider("deepseek-v4-pro")
    p.complete(LLMRequest(
        model="deepseek-v4-pro",
        messages=[{"role": "user", "content": "go"}],
        response_model=None,
        thinking_budget=0,
        max_output_tokens=512,
        step="lint",
    ))
    assert "reasoning_effort" not in captured[0]


def test_deepseek_retries_on_429_then_succeeds(monkeypatch):
    _ensure_clean_deepseek_singleton(monkeypatch)
    from services.providers import get_provider
    from services.providers.base import LLMRequest

    captured = _stub_deepseek_post(monkeypatch, [429, 200])
    p = get_provider("deepseek-v4-pro")
    p.complete(LLMRequest(
        model="deepseek-v4-pro",
        messages=[{"role": "user", "content": "x"}],
        response_model=None,
        thinking_budget=0,
        max_output_tokens=128,
        step="t",
    ))
    assert len(captured) == 2, "expected exactly one retry after 429"


def test_deepseek_emits_log_line_with_cache_hit(monkeypatch, capsys):
    _ensure_clean_deepseek_singleton(monkeypatch)
    from services.providers import get_provider
    from services.providers.base import LLMRequest

    body = {
        "choices": [{
            "message": {"content": "free text"},
            "finish_reason": "stop",
        }],
        "usage": {
            "prompt_tokens": 1234,
            "completion_tokens": 56,
            "prompt_cache_hit_tokens": 78,
        },
    }
    _stub_deepseek_post(monkeypatch, [200], body=body)
    p = get_provider("deepseek-v4-pro")
    p.complete(LLMRequest(
        model="deepseek-v4-pro",
        messages=[{"role": "user", "content": "x"}],
        response_model=None,
        thinking_budget=0,
        max_output_tokens=128,
        step="extract",
    ))
    captured = capsys.readouterr()
    assert "[deepseek] step=extract" in captured.err
    assert "in=1234" in captured.err
    assert "out=56" in captured.err
    assert "cache_hit=78" in captured.err


# ---------------------------------------------------------------------------
# DeepSeekProvider pricing (Phase 4)
# ---------------------------------------------------------------------------


def test_deepseek_prices_in_discount_window(monkeypatch):
    """One second before DISCOUNT_UNTIL: prices use the discount table."""
    from services.providers import deepseek as D
    monkeypatch.delenv("DEEPSEEK_INPUT_USD_PER_M", raising=False)
    monkeypatch.delenv("DEEPSEEK_OUTPUT_USD_PER_M", raising=False)
    monkeypatch.delenv("DEEPSEEK_CACHE_USD_PER_M", raising=False)

    import datetime as _dt
    target = D.DISCOUNT_UNTIL - _dt.timedelta(seconds=1)

    class _FakeDateTime(_dt.datetime):
        @classmethod
        def now(cls, tz=None): return target

    monkeypatch.setattr(D, "datetime", _FakeDateTime)
    prices = D._prices_now()
    assert prices["input"] == D._PRICES_DISCOUNT["input"]
    assert prices["output"] == D._PRICES_DISCOUNT["output"]
    assert prices["cache"] == D._PRICES_DISCOUNT["cache"]


def test_deepseek_prices_after_discount_window(monkeypatch):
    """One second after DISCOUNT_UNTIL: prices flip to the list table."""
    from services.providers import deepseek as D
    monkeypatch.delenv("DEEPSEEK_INPUT_USD_PER_M", raising=False)
    monkeypatch.delenv("DEEPSEEK_OUTPUT_USD_PER_M", raising=False)
    monkeypatch.delenv("DEEPSEEK_CACHE_USD_PER_M", raising=False)

    import datetime as _dt
    target = D.DISCOUNT_UNTIL + _dt.timedelta(seconds=1)

    class _FakeDateTime(_dt.datetime):
        @classmethod
        def now(cls, tz=None): return target

    monkeypatch.setattr(D, "datetime", _FakeDateTime)
    prices = D._prices_now()
    assert prices["input"] == D._PRICES_LIST["input"]
    assert prices["output"] == D._PRICES_LIST["output"]
    assert prices["cache"] == D._PRICES_LIST["cache"]


def test_deepseek_prices_env_override_wins(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_INPUT_USD_PER_M", "0.99")
    from services.providers import deepseek as D
    prices = D._prices_now()
    assert prices["input"] == 0.99


def test_deepseek_cost_usd_formula(monkeypatch):
    """Sanity-check the cost arithmetic on a known usage dict."""
    monkeypatch.setenv("DEEPSEEK_INPUT_USD_PER_M",  "1.00")
    monkeypatch.setenv("DEEPSEEK_OUTPUT_USD_PER_M", "10.00")
    monkeypatch.setenv("DEEPSEEK_CACHE_USD_PER_M",  "0.10")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")
    from services import providers as P
    P._REGISTRY.clear()
    from services.providers import get_provider

    p = get_provider("deepseek-v4-pro")
    # 1M prompt tokens, 100K cached, 500K output (Gemini-shape keys).
    cost = p.cost_usd("deepseek-v4-pro", {
        "prompt_token_count":         1_000_000,
        "cached_content_token_count": 100_000,
        "candidates_token_count":     500_000,
        "thoughts_token_count":       0,
    })
    # fresh = 900_000 -> 0.9; cached = 100_000 -> 0.01; output = 500_000 -> 5.00
    assert abs(cost - (0.9 + 0.01 + 5.0)) < 1e-9
    P._REGISTRY.clear()


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
