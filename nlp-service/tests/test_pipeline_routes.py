"""Regression tests for the /pipeline/draft-page endpoint.

Uses FastAPI TestClient with draft_page() patched out so no LLM calls are made.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from services.draft_budget import SourceCut
from services.llm_client import CostCeilingError, DraftPageResult, LLMCompileError, LLMRateLimitedError

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
    result = DraftPageResult(markdown="---\ntitle: T\n---\n## Body\nOK.", used_source_ids=["src_1"], cuts=[])
    with patch("routers.pipeline.draft_page", return_value=result):
        resp = client.post("/pipeline/draft-page", json=_BASE_REQUEST)

    assert resp.status_code == 200
    body = resp.json()
    assert "markdown" in body
    assert "---" in body["markdown"]
    assert body["used_source_ids"] == ["src_1"]
    assert body["cut_sources"] == []


def test_draft_page_reports_what_the_prompt_budget_cut(client):
    """The app records provenance from used_source_ids and shows cut_sources."""
    request = {
        **_BASE_REQUEST,
        "source_contents": [
            {"source_id": "old", "title": "Old", "markdown": "Old text.", "citation_label": "S1"},
            {"source_id": "new", "title": "New", "markdown": "New text.", "citation_label": "S2", "is_new": True},
        ],
    }
    result = DraftPageResult(
        markdown="---\ntitle: T\n---\nOK.",
        used_source_ids=["new"],
        cuts=[SourceCut(source_id="old", sent_chars=0, cut_chars=9)],
    )
    with patch("routers.pipeline.draft_page", return_value=result) as fake:
        resp = client.post("/pipeline/draft-page", json=request)

    assert resp.status_code == 200
    assert resp.json()["used_source_ids"] == ["new"]
    assert resp.json()["cut_sources"] == [{"source_id": "old", "sent_chars": 0, "cut_chars": 9}]
    sent = fake.call_args.kwargs["source_contents"]
    assert [sc["is_new"] for sc in sent] == [False, True]


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
