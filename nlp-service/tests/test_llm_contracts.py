"""Contract tests for response-model prompts.

Two responsibilities:
  1. Assert every Pydantic response model parses canonical-shape responses
     and rejects the two known DeepSeek drift variants (wrong wrapper key
     and bare list — both observed in production: sessions 7ff0547d and
     33455fe7 on 2026-05-06).
  2. Assert every system prompt embeds its wrapper key as a literal
     substring (no implicit-by-_JSON_TRAILER reliance).
"""
from __future__ import annotations

from typing import Literal

import pytest
from pydantic import BaseModel, ValidationError

from services.llm_client import _format_response_contract


# ──────────────────────────────────────────────────────────────────────────────
#  Helper unit tests (Task A.1)
# ──────────────────────────────────────────────────────────────────────────────


class _Flat(BaseModel):
    answer: str
    confidence: Literal["high", "medium", "low"]


class _Nested(BaseModel):
    class _Item(BaseModel):
        name: str
        value: int | None = None

    results: list[_Item]


def test_format_response_contract_renders_flat_model():
    rendered = _format_response_contract(_Flat)
    assert "answer" in rendered
    assert "confidence" in rendered
    assert "high" in rendered and "medium" in rendered and "low" in rendered
    assert "Return JSON" in rendered
    assert "verify your output" in rendered.lower()


def test_format_response_contract_renders_nested_list():
    rendered = _format_response_contract(_Nested)
    assert "results" in rendered
    assert "name" in rendered
    assert "value" in rendered
    # Nested $ref must be resolved into the inline shape, not left as a $defs
    # reference token.
    assert "$ref" not in rendered
    assert "$defs" not in rendered


def test_format_response_contract_marks_nullable_fields():
    rendered = _format_response_contract(_Nested)
    # _Item.value is Optional[int] → must show null marker somewhere
    lowered = rendered.lower()
    assert "null" in lowered


# ──────────────────────────────────────────────────────────────────────────────
#  Per-call-site contract tests (Task A.3)
#
#  For every response_model in llm_client.py, four assertions:
#    1. Canonical-shape input parses cleanly.
#    2. Wrapper-key drift (e.g. "pairs" instead of "results") raises.
#    3. Bare list (no wrapper) raises.
#    4. Prompt constant contains the wrapper key as a literal substring.
#
#  Negative-shape variants are derived from real production failures:
#    • Variant A — session 7ff0547d-… (2026-05-06): {"pairs":[...]}
#    • Variant B — session 33455fe7-… (2026-05-06): bare list [{...}]
# ──────────────────────────────────────────────────────────────────────────────

from services.llm_client import (
    LintScanResponse,
    LLMExtractionResponse,
    DisambiguationResponse,
    CrossrefResponse,
    LabelMergeResponse,
    ClaimJudgeResponse,
    _LINT_SYSTEM_PROMPT,
    _EXTRACTION_SYSTEM_PROMPT,
    _DISAMBIGUATION_SYSTEM_PROMPT,
    _DISAMBIGUATION_CONCEPT_SYSTEM_PROMPT,
    _CROSSREF_SYSTEM_PROMPT,
    _LABEL_MERGE_SYSTEM_PROMPT,
    _CLAIM_JUDGE_SYSTEM_PROMPT,
)


# ── DisambiguationResponse — wrapper key = "results" ──────────────────────────

def test_disambiguation_canonical():
    p = DisambiguationResponse.model_validate({
        "results": [{
            "entity_a": "OpenAI", "entity_b": "Open AI Inc.",
            "decision": "same", "canonical": "OpenAI",
            "reason": "Same legal entity.",
        }]
    })
    assert p.results[0].decision == "same"


def test_disambiguation_rejects_pairs_wrapper():
    # Variant A from session 7ff0547d
    with pytest.raises(ValidationError):
        DisambiguationResponse.model_validate({
            "pairs": [{
                "entity_a": "OpenAI", "entity_b": "Open AI Inc.",
                "decision": "same", "canonical": "OpenAI", "reason": "x",
            }]
        })


def test_disambiguation_rejects_bare_list():
    # Variant B from session 33455fe7
    with pytest.raises(ValidationError):
        DisambiguationResponse.model_validate(
            [{"entity_a": "OpenAI", "entity_b": "Open AI Inc.",
              "decision": "same", "canonical": "OpenAI", "reason": "x"}]
        )


def test_disambiguation_prompt_anchors_results():
    assert "results" in _DISAMBIGUATION_SYSTEM_PROMPT
    assert "Return JSON" in _DISAMBIGUATION_SYSTEM_PROMPT


def test_disambiguation_concept_prompt_anchors_results():
    assert "results" in _DISAMBIGUATION_CONCEPT_SYSTEM_PROMPT
    assert "Return JSON" in _DISAMBIGUATION_CONCEPT_SYSTEM_PROMPT


# ── LintScanResponse — wrapper key = "contradictions" ─────────────────────────

def test_lint_canonical():
    p = LintScanResponse.model_validate({"contradictions": []})
    assert p.contradictions == []


def test_lint_rejects_results_wrapper():
    with pytest.raises(ValidationError):
        LintScanResponse.model_validate({"results": []})


def test_lint_rejects_bare_list():
    with pytest.raises(ValidationError):
        LintScanResponse.model_validate([])


def test_lint_prompt_anchors_contradictions():
    assert "contradictions" in _LINT_SYSTEM_PROMPT


# ── LLMExtractionResponse — flat 7-key shape ──────────────────────────────────

def test_extraction_canonical():
    p = LLMExtractionResponse.model_validate({
        "title": "Sample Paper Title",
        "entities": [], "concepts": [], "claims": [],
        "relationships": [], "contradictions": [], "summary": "x",
    })
    assert p.summary == "x"
    assert p.title == "Sample Paper Title"


def test_extraction_accepts_empty_title():
    # Per the prompt: LLM returns "" when no title is derivable. Caller falls
    # back to the filename-based title_hint via updateSourceTitle's no-op path.
    p = LLMExtractionResponse.model_validate({
        "title": "",
        "entities": [], "concepts": [], "claims": [],
        "relationships": [], "contradictions": [], "summary": "x",
    })
    assert p.title == ""


def test_extraction_rejects_data_wrapper():
    with pytest.raises(ValidationError):
        LLMExtractionResponse.model_validate({"data": {
            "title": "",
            "entities": [], "concepts": [], "claims": [],
            "relationships": [], "contradictions": [], "summary": "x",
        }})


def test_extraction_rejects_bare_list():
    with pytest.raises(ValidationError):
        LLMExtractionResponse.model_validate([])


def test_extraction_prompt_anchors_keys():
    for key in ("title", "entities", "concepts", "claims", "relationships", "summary"):
        assert key in _EXTRACTION_SYSTEM_PROMPT, f"missing wrapper key: {key}"


# ── CrossrefResponse — wrapper keys = "updated_pages", "contradictions_found" ─

def test_crossref_canonical():
    p = CrossrefResponse.model_validate({
        "updated_pages": [], "contradictions_found": [],
    })
    assert p.updated_pages == []


def test_crossref_rejects_pages_wrapper():
    with pytest.raises(ValidationError):
        CrossrefResponse.model_validate({"pages": [], "contradictions": []})


def test_crossref_rejects_bare_list():
    with pytest.raises(ValidationError):
        CrossrefResponse.model_validate([])


def test_crossref_prompt_anchors_keys():
    assert "updated_pages" in _CROSSREF_SYSTEM_PROMPT
    assert "contradictions_found" in _CROSSREF_SYSTEM_PROMPT


# ── LabelMergeResponse — wrapper key = "merges" ───────────────────────────────

def test_label_merge_canonical():
    p = LabelMergeResponse.model_validate({
        "merges": [{"label": "Crypto", "into": "Cryptocurrency", "reason": "short form"}],
    })
    assert p.merges[0].into == "Cryptocurrency"


def test_label_merge_rejects_mapping_wrapper():
    with pytest.raises(ValidationError):
        LabelMergeResponse.model_validate({"mapping": {"Crypto": "Cryptocurrency"}})


def test_label_merge_rejects_bare_list():
    with pytest.raises(ValidationError):
        LabelMergeResponse.model_validate([])


def test_label_merge_prompt_anchors_keys():
    for key in ("merges", "label", "into", "reason"):
        assert key in _LABEL_MERGE_SYSTEM_PROMPT, f"missing key: {key}"



# ── ClaimJudgeResponse — wrapper key = "judgements" ───────────────────────────

def test_claim_judge_canonical():
    p = ClaimJudgeResponse.model_validate({
        "judgements": [{"pair_id": "p1", "topic": "launch year", "reason": "A gives 2008; B gives 2009.", "verdict": "disputed"}],
    })
    assert p.judgements[0].verdict == "disputed"


def test_claim_judge_rejects_results_wrapper():
    with pytest.raises(ValidationError):
        ClaimJudgeResponse.model_validate({
            "results": [{"pair_id": "p1", "topic": "t", "reason": "r", "verdict": "none"}],
        })


def test_claim_judge_rejects_bare_list():
    with pytest.raises(ValidationError):
        ClaimJudgeResponse.model_validate([{"pair_id": "p1", "topic": "t", "reason": "r", "verdict": "none"}])


def test_claim_judge_prompt_anchors_keys():
    for key in ("judgements", "pair_id", "topic", "reason", "verdict"):
        assert key in _CLAIM_JUDGE_SYSTEM_PROMPT, f"missing key: {key}"
