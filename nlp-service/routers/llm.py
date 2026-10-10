"""LLM usage and pricing router for Kompl v2 nlp-service.

Endpoints:
  GET /llm/usage   — today's LLM spend vs the daily cap (from the on-disk cap file).
  GET /llm/pricing — list prices for one model plus the draft_page limits, for
                     the app's page-update estimate (Settings > Wiki health).

This router NEVER opens kompl.db. rule #1 in CLAUDE.md.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict

from services.llm_client import (
    _DRAFT_PAGE_MAX_OUTPUT_TOKENS,
    _GEMINI_INPUT_TOKEN_CAP,
    _read_cap,
    _read_daily_cap_usd,
    _read_thinking_budget,
)
from services.llm_models import LLMModel
from services.providers import get_model_prices, thinking_budget_is_token_cap

router = APIRouter()


class LLMUsageResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    date: str
    total_usd: float
    call_count: int
    daily_cap_usd: float
    remaining_usd: float


@router.get("/llm/usage", response_model=LLMUsageResponse)
def get_llm_usage() -> LLMUsageResponse:
    """Return today's LLM spend vs the configured daily cap."""
    cap_data = _read_cap()
    total = cap_data["total_usd"]
    daily_cap = _read_daily_cap_usd()
    remaining = round(max(0.0, daily_cap - total), 4) if daily_cap > 0 else -1.0
    return LLMUsageResponse(
        date=cap_data["date"],
        total_usd=round(total, 4),
        call_count=cap_data.get("call_count", 0),
        daily_cap_usd=daily_cap,
        remaining_usd=remaining,
    )


class LLMPricingResponse(BaseModel):
    """Prices for one model, per 1M tokens, as the daily cap counts them today.

    The draft_* fields are the limits of one draft_page call (the call a page
    update makes), so the app estimates from the same numbers this service
    uses instead of copies that could drift.
    """

    model_config = ConfigDict(extra="forbid")

    model: LLMModel
    provider: Literal["gemini", "deepseek"]
    input_usd_per_m: float
    output_usd_per_m: float
    cached_input_usd_per_m: float
    # Both providers bill thinking at the output rate: Gemini reports it as
    # thoughts_token_count, DeepSeek folds it into completion_tokens.
    thinking_billed_as: Literal["output"]
    draft_thinking_budget: int
    # True when the budget is a hard token limit (Gemini 2.5); False when it
    # only picks an effort level (Gemini 3.x thinking_level, DeepSeek effort).
    draft_thinking_budget_is_cap: bool
    draft_max_output_tokens: int
    # draft_page truncates the user prompt (sources included) to this many chars.
    draft_prompt_char_cap: int


@router.get("/llm/pricing", response_model=LLMPricingResponse)
def get_llm_pricing(model: LLMModel) -> LLMPricingResponse:
    """List prices in effect today for ``model`` (env overrides and announced
    price changes applied). Unknown models fail validation with 422."""
    prices = get_model_prices(model)
    return LLMPricingResponse(
        model=model,
        provider="deepseek" if model.startswith("deepseek-") else "gemini",
        input_usd_per_m=prices["input"],
        output_usd_per_m=prices["output"],
        cached_input_usd_per_m=prices["cache"],
        thinking_billed_as="output",
        draft_thinking_budget=_read_thinking_budget("draft_page"),
        draft_thinking_budget_is_cap=thinking_budget_is_token_cap(model),
        draft_max_output_tokens=_DRAFT_PAGE_MAX_OUTPUT_TOKENS,
        draft_prompt_char_cap=_GEMINI_INPUT_TOKEN_CAP,
    )
