"""Claim check router for Kompl v2 nlp-service (plan 3.3 and 3.6).

Endpoint:
  POST /pipeline/judge-claims
    Judges one batch of claim pairs in one LLM call: do two sources' claims
    about a shared subject disagree, and how (disputed, outdated, scope,
    opinion, none). The app's claim check (compile step) and whole-wiki
    check (Settings > Wiki health) call it with the pairs they ranked
    (app/src/lib/claim-check/judge.ts), and so can the accuracy gate (plan
    3.7) with labelled pairs: the same pairs in, the settled verdicts out,
    nothing stored here.

    Each side carries its source's date (date_kind "published", or "saved"
    when only the day it was added is known). An "outdated" answer stands
    only when those dates prove which side is later (owner decision D5,
    services/claim_verdicts.py); `newer` then names that side.

This router NEVER opens kompl.db. rule #1 in CLAUDE.md.
"""

from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from services.claim_verdicts import settle_judgements
from services.llm_client import (
    CLAIM_JUDGE_MAX_PAIRS,
    CostCeilingError,
    LLMCompileError,
    LLMRateLimitedError,
    judge_claim_pairs,
)
from services.llm_models import LLMModel

router = APIRouter(tags=["pipeline"])

# The app clips claims and quotes to 400 characters
# (app/src/lib/claim-check/claims.ts CLAIM_MAX_CHARS); this leaves room.
_MAX_TEXT_CHARS = 1000

ClaimVerdict = Literal["disputed", "outdated", "scope", "opinion", "none"]


class ClaimSide(BaseModel):
    model_config = ConfigDict(extra='forbid')

    claim: str = Field(min_length=1, max_length=_MAX_TEXT_CHARS)
    # The source's own sentence; only quotes found in the source are sent.
    quote: Optional[str] = Field(default=None, max_length=_MAX_TEXT_CHARS)
    # The source's title: context (an opinion piece, a changelog, a survey).
    source_title: Optional[str] = Field(default=None, max_length=500)
    # The source's date, YYYY-MM-DD (app/src/lib/source-dates.ts promptDate).
    date: Optional[str] = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    date_kind: Optional[Literal["published", "saved"]] = None


class ClaimPairIn(BaseModel):
    model_config = ConfigDict(extra='forbid')

    pair_id: str = Field(min_length=1, max_length=200)
    # The shared subject the pair was found on; context for the judge.
    subject: str = Field(default="", max_length=300)
    a: ClaimSide
    b: ClaimSide


class JudgeClaimsRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    pairs: list[ClaimPairIn] = Field(min_length=1, max_length=CLAIM_JUDGE_MAX_PAIRS)
    compile_model: LLMModel = "gemini-2.5-flash"

    @field_validator("pairs")
    @classmethod
    def _unique_ids(cls, pairs: list[ClaimPairIn]) -> list[ClaimPairIn]:
        if len({p.pair_id for p in pairs}) != len(pairs):
            raise ValueError("pair_id must be unique within a request")
        return pairs


class ClaimVerdictItem(BaseModel):
    model_config = ConfigDict(extra='forbid')

    pair_id: str
    verdict: ClaimVerdict
    topic: str
    reason: str
    # outdated only: the side whose source is provably later.
    newer: Optional[Literal["a", "b"]] = None


class JudgeClaimsResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    # One item per pair the model answered with a known verdict; a pair left
    # out has no verdict and is asked again by a later run.
    items: list[ClaimVerdictItem]
    count: int


@router.post("/pipeline/judge-claims", response_model=JudgeClaimsResponse)
def pipeline_judge_claims(req: JudgeClaimsRequest) -> JudgeClaimsResponse:
    """Verdicts for one batch of claim pairs.

    HTTP 429 when rate limit bucket is full.
    HTTP 503 when daily cost ceiling is exceeded (nothing is sent).
    HTTP 500 when the LLM call fails or JSON parse fails.
    """
    pairs = [p.model_dump() for p in req.pairs]
    try:
        answer = judge_claim_pairs(pairs, model=req.compile_model)
    except LLMRateLimitedError as e:
        raise HTTPException(status_code=429, detail="llm_rate_limited") from e
    except CostCeilingError as e:
        raise HTTPException(status_code=503, detail="daily_cost_ceiling") from e
    except LLMCompileError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    items = [
        ClaimVerdictItem(pair_id=s.pair_id, verdict=s.verdict, topic=s.topic, reason=s.reason, newer=s.newer)
        for s in settle_judgements(pairs, answer.judgements)
    ]
    return JudgeClaimsResponse(items=items, count=len(items))
