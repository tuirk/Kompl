"""Regression tests for the /pipeline/draft-page endpoint.

Uses FastAPI TestClient with draft_page() patched out so no LLM calls are made.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from services.llm_client import CostCeilingError, LLMCompileError, LLMRateLimitedError

# Minimal valid request body.
_BASE_REQUEST = {
    "page_type": "source-summary",
    "title": "Test Wiki Page",
    "source_contents": [
        {"source_id": "src_1", "title": "Source One", "markdown": "Content here."}
    ],
    "related_pages": [],
    "existing_content": None,
    "schema": None,
    "existing_page_titles": [],
    "extraction_dossier": "",
    "existing_categories": [],
}


def test_draft_page_success_returns_markdown(client):
    """POST /pipeline/draft-page returns 200 with a markdown field."""
    with patch("routers.pipeline.draft_page", return_value="---\ntitle: T\n---\n## Body\nOK."):
        resp = client.post("/pipeline/draft-page", json=_BASE_REQUEST)

    assert resp.status_code == 200
    body = resp.json()
    assert "markdown" in body
    assert "---" in body["markdown"]


def test_draft_page_returns_429_on_rate_limit(client):
    """POST /pipeline/draft-page returns 429 when LLMRateLimitedError is raised."""
    with patch("routers.pipeline.draft_page", side_effect=LLMRateLimitedError("full")):
        resp = client.post("/pipeline/draft-page", json=_BASE_REQUEST)

    assert resp.status_code == 429
    assert resp.json()["detail"] == "llm_rate_limited"


def test_draft_page_returns_503_on_cost_ceiling(client):
    """POST /pipeline/draft-page returns 503 when CostCeilingError is raised."""
    with patch("routers.pipeline.draft_page", side_effect=CostCeilingError("cap")):
        resp = client.post("/pipeline/draft-page", json=_BASE_REQUEST)

    assert resp.status_code == 503
    assert resp.json()["detail"] == "daily_cost_ceiling"


def test_draft_page_returns_500_on_compile_error(client):
    """POST /pipeline/draft-page returns 500 when LLMCompileError is raised."""
    with patch("routers.pipeline.draft_page", side_effect=LLMCompileError("empty")):
        resp = client.post("/pipeline/draft-page", json=_BASE_REQUEST)

    assert resp.status_code == 500


def test_draft_page_rejects_extra_fields(client):
    """POST /pipeline/draft-page returns 422 for unknown fields (extra=forbid)."""
    bad_request = {**_BASE_REQUEST, "unknown_field": "should_fail"}
    resp = client.post("/pipeline/draft-page", json=bad_request)
    assert resp.status_code == 422


def test_draft_page_requires_source_contents(client):
    """POST /pipeline/draft-page returns 422 when source_contents is missing."""
    bad_request = {k: v for k, v in _BASE_REQUEST.items() if k != "source_contents"}
    resp = client.post("/pipeline/draft-page", json=bad_request)
    assert resp.status_code == 422
