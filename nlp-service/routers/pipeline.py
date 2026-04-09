"""Pipeline router for Kompl v2 nlp-service (commit 4).

Commit 4 endpoint:
  POST /pipeline/compile-simple
    Request:  {source_id: str, markdown: str}
    Response: CompileResponse (title, page_type, category, summary, body, entities)

The compile-simple endpoint is a thin wrapper around llm_client.compile_source().
All rate limiting, cost tracking, and truncation live in llm_client.py — this
router is responsible only for HTTP transport (422 on bad input, 429 on rate
limit, 503 on cost ceiling, 500 on LLM error).

Commit 10 will add /pipeline/extract, /pipeline/resolve, /pipeline/draft for
the full multi-pass Karpathy pipeline. Those are NOT in scope here — thin slice.

This router NEVER opens kompl.db. rule #1 in CLAUDE.md.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

from services.llm_client import (
    CompileResponse,
    CostCeilingError,
    LLMCompileError,
    LLMRateLimitedError,
    compile_source,
)

router = APIRouter(tags=["pipeline"])


class CompileSimpleRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    source_id: str
    markdown: str


@router.post("/pipeline/compile-simple", response_model=CompileResponse)
def pipeline_compile_simple(req: CompileSimpleRequest) -> CompileResponse:
    """Compile a source's raw markdown into structured wiki content via Gemini.

    Truncation, rate limiting, and cost tracking are handled inside
    llm_client.compile_source(). This endpoint is idempotent — re-compiling
    the same source_id returns a new result (the caller decides whether to
    overwrite the existing page via version-preserving write_page()).

    HTTP 429 when rate limit bucket is full.
    HTTP 503 when daily cost ceiling is exceeded.
    HTTP 500 when the LLM call fails or the JSON response cannot be parsed.
    """
    try:
        return compile_source(req.source_id, req.markdown)
    except LLMRateLimitedError as e:
        raise HTTPException(status_code=429, detail="llm_rate_limited") from e
    except CostCeilingError as e:
        raise HTTPException(status_code=503, detail="daily_cost_ceiling") from e
    except LLMCompileError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
