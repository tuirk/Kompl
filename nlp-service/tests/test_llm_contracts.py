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
