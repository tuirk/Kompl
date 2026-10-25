"""The daily cost ceiling reaches the app the documented way.

Real call path: router -> llm_client call site -> provider complete(), with
only the Gemini SDK and rate limiter mocked. With today's spend at the cap,
every LLM route answers 503 ``daily_cost_ceiling`` (what the app's draft,
extract, resolve, schema and redraft handlers check for) and lint-scan
returns no contradictions, without sending anything.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services import llm_client

_ROUTES = {
    "/pipeline/extract-llm": {"source_id": "s1", "markdown": "Body.", "ner_output": {}},
    "/pipeline/draft-page": {
        "page_type": "source-summary", "title": "T",
        "source_contents": [{"source_id": "s1", "title": "T", "markdown": "Body."}],
    },
    "/pipeline/crossref": {
        "pages": [{"plan_id": "p1", "title": "A", "page_type": "entity", "markdown": "x"}],
    },
    "/pipeline/triage": {"source_claims": "c", "existing_page_summary": "s", "page_title": "A"},
    "/pipeline/generate-schema": {"pages": [{"title": "A", "page_type": "entity"}]},
    "/pipeline/consolidate-labels": {"existing_labels": ["Cryptocurrency"], "new_labels": ["Crypto"]},
}


@pytest.fixture
def api():
    from routers.pipeline import router as pipeline_router  # noqa: PLC0415
    from routers.labels import router as labels_router  # noqa: PLC0415
    from routers.resolution import router as resolution_router  # noqa: PLC0415
    app = FastAPI()
    app.include_router(pipeline_router)
    app.include_router(resolution_router)
    app.include_router(labels_router)
    return TestClient(app)


def _set_spend(tmp_path, cap_usd: float, spent_usd: float) -> None:
    # conftest points llm_client's spend files into tmp_path.
    (tmp_path / "llm-config.json").write_text(json.dumps({"daily_cap_usd": cap_usd}))
    (tmp_path / "llm-cap.json").write_text(json.dumps(
        {"date": llm_client._utc_today(), "total_usd": spent_usd, "call_count": 1}
    ))


@pytest.mark.parametrize("path", sorted(_ROUTES))
def test_llm_routes_answer_503_at_the_cap(path, api, tmp_path, mock_gemini, mock_limiter):
    _set_spend(tmp_path, cap_usd=1.0, spent_usd=1.0)

    resp = api.post(path, json=_ROUTES[path])

    assert resp.status_code == 503
    assert resp.json() == {"detail": "daily_cost_ceiling"}
    mock_gemini.models.generate_content.assert_not_called()


def test_disambiguate_answers_503_at_the_cap(api, tmp_path, mock_gemini, mock_limiter):
    _set_spend(tmp_path, cap_usd=1.0, spent_usd=1.0)
    side = {"type": "ORG", "context": "c", "source_id": "s1"}
    pair = {"entity_a": {"name": "Alpha Corp", **side}, "entity_b": {"name": "Alpha Inc", **side},
            "similarity": 0.8, "name_similarity": 0.8}

    resp = api.post("/resolve/disambiguate", json={"pairs": [pair]})

    assert resp.status_code == 503
    assert "Daily LLM spend limit ($1.00) reached" in resp.json()["detail"]
    mock_gemini.models.generate_content.assert_not_called()


def test_lint_scan_returns_no_contradictions_at_the_cap(api, tmp_path, mock_gemini, mock_limiter):
    _set_spend(tmp_path, cap_usd=1.0, spent_usd=1.0)

    resp = api.post("/pipeline/lint-scan", json={"pages": ["[p1] A: a", "[p2] B: b"]})

    assert resp.status_code == 200
    assert resp.json() == {"contradictions": []}
    mock_gemini.models.generate_content.assert_not_called()


def test_extract_fallback_refused_at_the_cap_answers_503(api, tmp_path, mock_gemini, mock_limiter):
    """The first extract call crosses the cap and comes back truncated; the
    halved-input retry is then refused, and that refusal is what the app sees."""
    _set_spend(tmp_path, cap_usd=1.0, spent_usd=0.99)
    response = mock_gemini.models.generate_content.return_value
    response.text = "not json"
    response.candidates = [MagicMock(finish_reason="FinishReason.MAX_TOKENS")]
    response.usage_metadata.prompt_token_count = 0
    response.usage_metadata.cached_content_token_count = 0
    response.usage_metadata.candidates_token_count = 20_000  # $0.05 on 2.5 Flash
    response.usage_metadata.thoughts_token_count = 0

    resp = api.post("/pipeline/extract-llm", json=_ROUTES["/pipeline/extract-llm"])

    assert resp.status_code == 503
    assert resp.json() == {"detail": "daily_cost_ceiling"}
    assert mock_gemini.models.generate_content.call_count == 1
