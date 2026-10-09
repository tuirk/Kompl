"""Model registry + per-generation request shape.

- Every allowlisted model has a price, and every Gemini 3 model has a
  thinking-level table, so a model the Settings page offers can't crash
  pricing or request building.
- Gemini 3.x requests send thinking_level (never thinking_budget, which 3.x
  rejects alongside it) and leave temperature at Google's 1.0 default.
- Gemini 2.5 requests stay exactly as before (existing installs).
- Scheduled list-price changes apply from their effective date.
"""

from __future__ import annotations

from datetime import date
from typing import get_args

import pytest

# conftest.py stubs heavy deps before these imports run. The provider
# modules read their API keys from the environment at import time, so they are
# imported inside each test (after the per-test env setup elsewhere), never at
# collection time.
from services import llm_client
from services.llm_models import LLMModel

_SOURCES = [{"source_id": "s1", "title": "T", "markdown": "Content."}]


def test_every_allowlisted_model_has_a_price():
    from services.providers import deepseek as deepseek_provider  # noqa: PLC0415
    from services.providers import gemini as gemini_provider  # noqa: PLC0415

    for model in get_args(LLMModel):
        table = deepseek_provider._MODEL_PRICES if model.startswith("deepseek-") else gemini_provider._MODEL_PRICES
        assert model in table, f"{model} is allowlisted but has no price"


def test_every_gemini3_model_has_thinking_levels():
    from services.providers import gemini as gemini_provider  # noqa: PLC0415

    for model in get_args(LLMModel):
        if model.startswith("gemini-3"):
            assert model in gemini_provider._GEMINI3_THINKING_LEVELS


@pytest.mark.parametrize(
    "model,budget,expected",
    [
        # 0 -> the lowest level the model offers ('minimal' is not on 3.8 Flash / 3.1 Pro).
        ("gemini-3.8-flash", 0, "low"),
        ("gemini-3.1-pro-preview", 0, "low"),
        ("gemini-3.5-flash-lite", 0, "minimal"),
        ("gemini-3.8-flash", 512, "low"),
        ("gemini-3.8-flash", 1024, "low"),
        ("gemini-3.8-flash", 2048, "medium"),
        ("gemini-3.8-flash", 8192, "medium"),
        ("gemini-3.8-flash", 8193, "high"),
        ("gemini-3.8-flash", -1, None),
    ],
)
def test_thinking_level_mapping(model, budget, expected):
    from services.providers import gemini as gemini_provider  # noqa: PLC0415

    assert gemini_provider._thinking_level_for(model, budget) == expected


def test_gemini3_request_uses_thinking_level_and_default_temperature(mock_gemini, mock_limiter, mock_cost):
    from google.genai import types  # noqa: PLC0415

    llm_client.draft_page(page_type="source-summary", title="T", source_contents=_SOURCES, model="gemini-3.8-flash")

    kwargs = mock_gemini.models.generate_content.call_args.kwargs
    assert kwargs["model"] == "gemini-3.8-flash"
    config = kwargs["config"]
    assert config.thinking_config.thinking_level == types.ThinkingLevel.LOW  # draft_page budget 1024
    assert config.thinking_config.thinking_budget is None
    assert config.temperature is None
    assert config.max_output_tokens == 16384


def test_gemini3_flash_lite_zero_budget_gets_minimal(mock_gemini, mock_limiter, mock_cost):
    from google.genai import types  # noqa: PLC0415

    mock_gemini.models.generate_content.return_value.text = '{"updated_pages": [], "contradictions_found": []}'
    llm_client.crossref_pages(
        [{"plan_id": "p1", "title": "A", "page_type": "entity", "markdown": "x"}],
        model="gemini-3.5-flash-lite",
    )

    config = mock_gemini.models.generate_content.call_args.kwargs["config"]
    assert config.thinking_config.thinking_level == types.ThinkingLevel.MINIMAL
    assert config.temperature is None


def test_gemini25_request_shape_unchanged(mock_gemini, mock_limiter, mock_cost):
    llm_client.draft_page(page_type="source-summary", title="T", source_contents=_SOURCES, model="gemini-2.5-flash")

    config = mock_gemini.models.generate_content.call_args.kwargs["config"]
    assert config.thinking_config.thinking_budget == 1024
    assert config.thinking_config.thinking_level is None
    assert config.temperature == 0.3


def test_gemini38_flash_price_switches_on_effective_date(monkeypatch):
    from services.providers import gemini as gemini_provider  # noqa: PLC0415

    for var in ("GEMINI_INPUT_PRICE_PER_M", "GEMINI_OUTPUT_PRICE_PER_M", "GEMINI_CACHE_PRICE_PER_M"):
        monkeypatch.setattr(gemini_provider, f"_{var.split('_')[1]}_PRICE_OVERRIDE", None)

    monkeypatch.setattr(gemini_provider, "_utc_today", lambda: date(2026, 12, 31))
    assert gemini_provider._get_model_prices("gemini-3.8-flash") == {"input": 0.75, "output": 3.75, "cache": 0.075}

    monkeypatch.setattr(gemini_provider, "_utc_today", lambda: date(2027, 1, 1))
    assert gemini_provider._get_model_prices("gemini-3.8-flash") == {"input": 1.50, "output": 7.50, "cache": 0.15}

    # Other models are unaffected by the schedule.
    assert gemini_provider._get_model_prices("gemini-2.5-flash")["input"] == 0.30
