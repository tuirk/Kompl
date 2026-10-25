"""POST /pipeline/consolidate-labels with a fake model.

The fake stands in for the provider, so these run without any provider SDK.
The route returns only merges the app may apply (services/label_merge.py),
answers 503 daily_cost_ceiling at the cap without sending, and rejects
unknown fields and oversized label lists.
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services import llm_client
from services.providers import LLMResult


@pytest.fixture
def api():
    from routers.labels import router  # noqa: PLC0415
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class _FakeModel:
    """Answers with fixed merges; holds a place under the daily cap like a
    real provider does before sending."""

    def __init__(self, merges: list[dict[str, str]]):
        self.merges = merges
        self.sent: list = []

    def cost_usd(self, model, usage):
        return 0.001

    def complete(self, req):
        with llm_client._spend_reservation(req):
            self.sent.append(req)
            text = json.dumps({"merges": self.merges})
            return LLMResult(
                text=text,
                parsed=llm_client.LabelMergeResponse.model_validate_json(text),
                parse_error=None,
                usage={},
                finish_reason="STOP",
            )


def _use(monkeypatch, fake: _FakeModel) -> _FakeModel:
    monkeypatch.setattr(llm_client, "get_provider", lambda model: fake)
    return fake


BODY = {
    "existing_labels": ["Cryptocurrency", "Machine Learning", "Artificial Intelligence"],
    "new_labels": ["Crypto", "Bitcoin"],
    "compile_model": "deepseek-flash",
}


def test_returns_only_the_merges_the_app_may_apply(api, monkeypatch):
    fake = _use(monkeypatch, _FakeModel([
        {"label": "Crypto", "into": "Cryptocurrency", "reason": "short form"},
        # Both labels were already in the wiki: never renamed.
        {"label": "Machine Learning", "into": "Artificial Intelligence", "reason": "related"},
        # A name the model made up.
        {"label": "Bitcoin", "into": "Digital Money", "reason": "related"},
    ]))

    resp = api.post("/pipeline/consolidate-labels", json=BODY)

    assert resp.status_code == 200
    assert resp.json() == {
        "items": [{"label": "Crypto", "into": "Cryptocurrency", "reason": "short form"}],
        "count": 1,
    }
    assert len(fake.sent) == 1
    assert fake.sent[0].model == "deepseek-flash"


def test_no_new_labels_sends_nothing(api, monkeypatch):
    fake = _use(monkeypatch, _FakeModel([]))
    resp = api.post("/pipeline/consolidate-labels", json={**BODY, "new_labels": []})
    assert resp.status_code == 200
    assert resp.json() == {"items": [], "count": 0}
    assert fake.sent == []


def test_answers_503_at_the_daily_cap_without_sending(api, monkeypatch, tmp_path):
    # conftest points llm_client's spend files into tmp_path.
    (tmp_path / "llm-config.json").write_text(json.dumps({"daily_cap_usd": 1.0}))
    (tmp_path / "llm-cap.json").write_text(json.dumps(
        {"date": llm_client._utc_today(), "total_usd": 1.0, "call_count": 1}
    ))
    fake = _use(monkeypatch, _FakeModel([]))

    resp = api.post("/pipeline/consolidate-labels", json=BODY)

    assert resp.status_code == 503
    assert resp.json() == {"detail": "daily_cost_ceiling"}
    assert fake.sent == []


def test_rate_limit_and_parse_failures_map_like_the_other_llm_routes(api, monkeypatch):
    def _raise(exc):
        def _consolidate(*args, **kwargs):
            raise exc
        return _consolidate

    monkeypatch.setattr("routers.labels.consolidate_labels", _raise(llm_client.LLMRateLimitedError("x")))
    assert api.post("/pipeline/consolidate-labels", json=BODY).status_code == 429
    monkeypatch.setattr("routers.labels.consolidate_labels", _raise(llm_client.LLMCompileError("bad json")))
    resp = api.post("/pipeline/consolidate-labels", json=BODY)
    assert resp.status_code == 500
    assert resp.json() == {"detail": "bad json"}


def test_rejects_unknown_fields(api):
    assert api.post("/pipeline/consolidate-labels", json={**BODY, "labels": []}).status_code == 422


@pytest.mark.parametrize(("field", "limit"), [("existing_labels", 300), ("new_labels", 100)])
def test_rejects_label_lists_over_the_limit(api, field, limit):
    too_many = [f"Label {i}" for i in range(limit + 1)]
    assert api.post("/pipeline/consolidate-labels", json={**BODY, field: too_many}).status_code == 422
