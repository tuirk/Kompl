"""Chat agent router for Kompl v2 nlp-service (commit 7).

Endpoints:
  POST /chat/select-pages  — index-first LLM page selection
  POST /chat/synthesize    — wiki-grounded answer synthesis

Both endpoints call Gemini 2.5 Flash via llm_client.py. Architecture rule #3:
no direct LLM calls from Next.js — all LLM work goes through this service.

This router NEVER opens kompl.db. Rule #1 in CLAUDE.md.
"""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

ChatModel = Literal[
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
]

from services.llm_client import (
    LLMCompileError,
    LLMRateLimitedError,
    CostCeilingError,
    select_pages_for_query,
    synthesize_answer,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["chat"])


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class SelectPagesRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    question: str
    index: list[dict]  # [{page_id, title, page_type, summary, source_count}]
    chat_model: ChatModel = "gemini-2.5-flash-lite"


class SelectPagesResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    page_ids: list[str]


class SynthesizePage(BaseModel):
    model_config = ConfigDict(extra='forbid')

    page_id: str
    title: str
    page_type: str
    markdown: str


class HistoryMessage(BaseModel):
    model_config = ConfigDict(extra='forbid')

    role: str   # 'user' | 'assistant'
    content: str


class SynthesizeRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    question: str
    pages: list[SynthesizePage]
    history: list[HistoryMessage]
    chat_model: ChatModel = "gemini-2.5-flash-lite"


class Citation(BaseModel):
    model_config = ConfigDict(extra='forbid')

    page_id: str
    page_title: str


class SynthesizeResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    answer: str
    citations: list[Citation]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/chat/select-pages", response_model=SelectPagesResponse)
def chat_select_pages(req: SelectPagesRequest) -> SelectPagesResponse:
    """Use Gemini to select the most relevant pages from the wiki index.

    Accepts the full page index and returns up to 10 page_ids sorted by
    relevance to the question. Used when the index fits within context.
    """
    try:
        page_ids = select_pages_for_query(req.question, req.index, model=req.chat_model)
    except LLMRateLimitedError as e:
        raise HTTPException(status_code=429, detail=str(e)) from e
    except CostCeilingError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except LLMCompileError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    return SelectPagesResponse(page_ids=page_ids)


@router.post("/chat/synthesize", response_model=SynthesizeResponse)
def chat_synthesize(req: SynthesizeRequest) -> SynthesizeResponse:
    """Synthesize a wiki-grounded answer from retrieved pages.

    The answer is grounded exclusively in the provided pages — no general
    knowledge hallucination. Citations reference only pages that were used.
    """
    pages_dicts = [p.model_dump() for p in req.pages]
    history_dicts = [h.model_dump() for h in req.history]

    try:
        result = synthesize_answer(
            req.question,
            pages_dicts,
            history_dicts,
            chat_model=req.chat_model,
        )
    except LLMRateLimitedError as e:
        raise HTTPException(status_code=429, detail=str(e)) from e
    except CostCeilingError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except LLMCompileError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    citations = [
        Citation(page_id=c.page_id, page_title=c.page_title)
        for c in result.citations
    ]
    return SynthesizeResponse(answer=result.answer, citations=citations)
