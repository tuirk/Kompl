"""Category label consolidation router for Kompl v2 nlp-service.

Endpoint:
  POST /pipeline/consolidate-labels
    One LLM call per compile, made by the app after drafting
    (app/src/lib/compile/label-merge.ts) when the compile's drafts added at
    least one category label the wiki did not have. Returns the merges the
    app may apply: a new label renamed into a label it sent, never a label
    the wiki already had (services/label_merge.py).

This router NEVER opens kompl.db. rule #1 in CLAUDE.md.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from services.label_merge import clean_label_merges
from services.llm_client import (
    CostCeilingError,
    LLMCompileError,
    LLMRateLimitedError,
    consolidate_labels,
)
from services.llm_models import LLMModel

router = APIRouter(tags=["pipeline"])

# The app sends at most this many labels (MAX_EXISTING_LABELS /
# MAX_NEW_LABELS in app/src/lib/compile/label-merge.ts).
MAX_EXISTING_LABELS = 300
MAX_NEW_LABELS = 100


class ConsolidateLabelsRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    existing_labels: list[str] = Field(default_factory=list, max_length=MAX_EXISTING_LABELS)
    new_labels: list[str] = Field(max_length=MAX_NEW_LABELS)
    compile_model: LLMModel = "gemini-2.5-flash"


class LabelMergeItem(BaseModel):
    model_config = ConfigDict(extra='forbid')

    label: str
    into: str
    reason: str


class ConsolidateLabelsResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    items: list[LabelMergeItem]
    count: int


@router.post("/pipeline/consolidate-labels", response_model=ConsolidateLabelsResponse)
def pipeline_consolidate_labels(req: ConsolidateLabelsRequest) -> ConsolidateLabelsResponse:
    """Merges of this compile's new labels into labels that mean the same.

    HTTP 429 when rate limit bucket is full.
    HTTP 503 when daily cost ceiling is exceeded (nothing is sent).
    HTTP 500 when the LLM call fails or JSON parse fails.
    """
    try:
        proposed = consolidate_labels(req.existing_labels, req.new_labels, model=req.compile_model)
    except LLMRateLimitedError as e:
        raise HTTPException(status_code=429, detail="llm_rate_limited") from e
    except CostCeilingError as e:
        raise HTTPException(status_code=503, detail="daily_cost_ceiling") from e
    except LLMCompileError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    items = [
        LabelMergeItem(**m)
        for m in clean_label_merges(proposed.merges, req.existing_labels, req.new_labels)
    ]
    return ConsolidateLabelsResponse(items=items, count=len(items))
