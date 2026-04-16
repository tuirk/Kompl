"""LLM usage router for Kompl v2 nlp-service.

Endpoints:
  GET /llm/usage — current daily Gemini spend from the on-disk cap file.

This router NEVER opens kompl.db. rule #1 in CLAUDE.md.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict

from services.llm_client import _DAILY_CAP, _read_cap

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
    """Return today's Gemini spend vs the configured daily cap."""
    cap_data = _read_cap()
    total = cap_data["total_usd"]
    remaining = round(max(0.0, _DAILY_CAP - total), 4) if _DAILY_CAP > 0 else -1.0
    return LLMUsageResponse(
        date=cap_data["date"],
        total_usd=round(total, 4),
        call_count=cap_data.get("call_count", 0),
        daily_cap_usd=_DAILY_CAP,
        remaining_usd=remaining,
    )
