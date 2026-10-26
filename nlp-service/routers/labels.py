"""Category label consolidation router for Kompl v2 nlp-service.

Endpoint:
  POST /pipeline/consolidate-labels
    One LLM call per compile, made by the app after drafting
    (app/src/lib/compile/label-merge.ts) when the compile's drafts added at
    least one category label the wiki did not have. Returns the merges the
    app may apply: a new label renamed into a label it sent, never a label
    the wiki already had, and only a smaller label into a bigger one
    (services/label_merge.py).

This router NEVER opens kompl.db. rule #1 in CLAUDE.md.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, NonNegativeInt

from services.label_merge import clean_label_merges
from services.llm_client import (
    CostCeilingError,
    LLMCompileError,
    LLMRateLimitedError,
    consolidate_labels,
    cost_ceiling_detail,
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
    # Pages per label, by label as sent above. The model sees them, and
    # services/label_merge.py moves only the smaller label into the bigger.
    # Optional: a caller that sends none gets the name rules only.
    page_counts: dict[str, NonNegativeInt] = Field(
        default_factory=dict, max_length=MAX_EXISTING_LABELS + MAX_NEW_LABELS,
    )
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
        proposed = consolidate_labels(
            req.existing_labels, req.new_labels, model=req.compile_model, page_counts=req.page_counts,
        )
    except LLMRateLimitedError as e:
        raise HTTPException(status_code=429, detail="llm_rate_limited") from e
    except CostCeilingError as e:
        raise HTTPException(status_code=503, detail=cost_ceiling_detail(e)) from e
    except LLMCompileError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    items = [
        LabelMergeItem(**m)
        for m in clean_label_merges(proposed.merges, req.existing_labels, req.new_labels, req.page_counts)
    ]
    return ConsolidateLabelsResponse(items=items, count=len(items))
