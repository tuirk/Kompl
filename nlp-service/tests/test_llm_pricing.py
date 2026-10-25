"""GET /llm/pricing — prices and draft_page limits for the page-update estimate.

The app estimates what updating older pages to the v0.4 writing rules costs
(Settings > Wiki health) from this endpoint, so it must report exactly what
the daily cap counts: today's list price (scheduled changes and env overrides
applied), thinking billed at the output rate, and the draft_page limits.
"""

from __future__ import annotations

from datetime import date
from typing import get_args

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services import llm_client
from services.llm_models import LLMModel

_GEMINI_OVERRIDES = ("_INPUT_PRICE_OVERRIDE", "_OUTPUT_PRICE_OVERRIDE", "_CACHE_PRICE_OVERRIDE")
_DEEPSEEK_ENV = ("DEEPSEEK_INPUT_USD_PER_M", "DEEPSEEK_OUTPUT_USD_PER_M", "DEEPSEEK_CACHE_USD_PER_M")

_FIELDS = {
    "model",
    "provider",
    "input_usd_per_m",
    "output_usd_per_m",
    "cached_input_usd_per_m",
    "thinking_billed_as",
    "draft_thinking_budget",
    "draft_thinking_budget_is_cap",
    "draft_max_output_tokens",
    "draft_prompt_char_cap",
    "claim_judge_thinking_budget",
    "claim_judge_max_output_tokens",
}


@pytest.fixture
def pricing_client(monkeypatch):
    """App with only the LLM router, list prices (no env overrides), today = 2026-10-10."""
    from routers.llm import router  # noqa: PLC0415
    from services.providers import gemini as gemini_provider  # noqa: PLC0415

    for name in _GEMINI_OVERRIDES:
        monkeypatch.setattr(gemini_provider, name, None)
    for var in _DEEPSEEK_ENV:
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(gemini_provider, "_utc_today", lambda: date(2026, 10, 10))

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_deepseek_flash_prices_and_draft_limits(pricing_client):
    r = pricing_client.get("/llm/pricing", params={"model": "deepseek-flash"})
    assert r.status_code == 200
    body = r.json()
    assert set(body) == _FIELDS
    assert body == {
        "model": "deepseek-flash",
        "provider": "deepseek",
        "input_usd_per_m": 0.30,
        "output_usd_per_m": 1.20,
        "cached_input_usd_per_m": 0.006,
        "thinking_billed_as": "output",
        "draft_thinking_budget": 1024,
        # DeepSeek turns the budget into a reasoning_effort, not a token cap.
        "draft_thinking_budget_is_cap": False,
        "draft_max_output_tokens": 16384,
        "draft_prompt_char_cap": 128000,
        "claim_judge_thinking_budget": 512,
        "claim_judge_max_output_tokens": 8192,
    }


def test_draft_limits_match_the_draft_call(pricing_client):
    body = pricing_client.get("/llm/pricing", params={"model": "gemini-2.5-flash"}).json()
    assert body["draft_thinking_budget"] == llm_client._read_thinking_budget("draft_page")
    assert body["draft_max_output_tokens"] == llm_client._DRAFT_PAGE_MAX_OUTPUT_TOKENS
    assert body["draft_prompt_char_cap"] == llm_client._GEMINI_INPUT_TOKEN_CAP


def test_claim_judge_limits_match_the_judge_call(pricing_client):
    body = pricing_client.get("/llm/pricing", params={"model": "deepseek-flash"}).json()
    assert body["claim_judge_thinking_budget"] == llm_client._read_thinking_budget("judge_claim_pairs")
    assert body["claim_judge_max_output_tokens"] == llm_client._CLAIM_JUDGE_MAX_OUTPUT_TOKENS


def test_draft_page_sends_the_reported_output_limit(mock_gemini, mock_limiter, mock_cost):
    llm_client.draft_page(
        page_type="entity",
        title="T",
        source_contents=[{"source_id": "s1", "title": "T", "markdown": "Content."}],
        model="gemini-2.5-flash",
    )
    config = mock_gemini.models.generate_content.call_args.kwargs["config"]
    assert config.max_output_tokens == llm_client._DRAFT_PAGE_MAX_OUTPUT_TOKENS


@pytest.mark.parametrize(
    ("model", "is_cap"),
    [
        ("gemini-2.5-flash", True),
        ("gemini-2.5-flash-lite", True),
        ("gemini-2.5-pro", True),
        ("gemini-3.8-flash", False),
        ("gemini-3.5-flash-lite", False),
        ("gemini-3.1-pro-preview", False),
        ("deepseek-flash", False),
        ("deepseek-v4-pro", False),
        ("deepseek-v4-flash", False),
    ],
)
def test_thinking_budget_is_a_cap_only_on_gemini_25(pricing_client, model, is_cap):
    body = pricing_client.get("/llm/pricing", params={"model": model}).json()
    assert body["draft_thinking_budget_is_cap"] is is_cap
    assert body["thinking_billed_as"] == "output"


def test_every_allowlisted_model_is_priced(pricing_client):
    from services.providers import deepseek as deepseek_provider  # noqa: PLC0415
    from services.providers import gemini as gemini_provider  # noqa: PLC0415

    for model in get_args(LLMModel):
        r = pricing_client.get("/llm/pricing", params={"model": model})
        assert r.status_code == 200, model
        body = r.json()
        table = deepseek_provider._MODEL_PRICES if model.startswith("deepseek-") else gemini_provider._MODEL_PRICES
        assert body["provider"] == ("deepseek" if model.startswith("deepseek-") else "gemini")
        assert body["input_usd_per_m"] == table[model]["input"]
        assert body["output_usd_per_m"] == table[model]["output"]
        assert body["cached_input_usd_per_m"] == table[model]["cache"]


def test_gemini_38_flash_follows_the_scheduled_price_change(pricing_client, monkeypatch):
    from services.providers import gemini as gemini_provider  # noqa: PLC0415

    monkeypatch.setattr(gemini_provider, "_utc_today", lambda: date(2026, 12, 31))
    before = pricing_client.get("/llm/pricing", params={"model": "gemini-3.8-flash"}).json()
    assert (before["input_usd_per_m"], before["output_usd_per_m"], before["cached_input_usd_per_m"]) == (0.75, 3.75, 0.075)

    monkeypatch.setattr(gemini_provider, "_utc_today", lambda: date(2027, 1, 1))
    after = pricing_client.get("/llm/pricing", params={"model": "gemini-3.8-flash"}).json()
    assert (after["input_usd_per_m"], after["output_usd_per_m"], after["cached_input_usd_per_m"]) == (1.50, 7.50, 0.15)


def test_env_overrides_apply_as_they_do_for_the_cap(pricing_client, monkeypatch):
    monkeypatch.setenv("DEEPSEEK_OUTPUT_USD_PER_M", "9.5")
    body = pricing_client.get("/llm/pricing", params={"model": "deepseek-v4-pro"}).json()
    assert body["output_usd_per_m"] == 9.5
    assert body["input_usd_per_m"] == 1.32


@pytest.mark.parametrize("model", ["gpt-5", "deepseek-v5-future", "gemini-9-ultra", ""])
def test_unknown_model_is_rejected(pricing_client, model):
    assert pricing_client.get("/llm/pricing", params={"model": model}).status_code == 422


def test_model_is_required(pricing_client):
    assert pricing_client.get("/llm/pricing").status_code == 422


def test_usage_endpoint_is_unchanged(pricing_client, tmp_path, monkeypatch):
    monkeypatch.setattr(llm_client, "_CAP_FILE", tmp_path / "llm-cap.json")
    monkeypatch.setattr(llm_client, "_CONFIG_FILE", tmp_path / "llm-config.json")
    monkeypatch.setattr(llm_client, "_cap_cache", {"value": None, "read_at": 0.0})
    (tmp_path / "llm-config.json").write_text('{"daily_cap_usd": 5.0}')
    body = pricing_client.get("/llm/usage").json()
    assert set(body) == {"date", "total_usd", "call_count", "daily_cap_usd", "remaining_usd"}
    assert body["total_usd"] == 0.0
    assert body["remaining_usd"] == 5.0
