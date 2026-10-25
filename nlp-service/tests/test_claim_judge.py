"""POST /pipeline/judge-claims and how its answers are settled (plan 3.3, 3.6).

The judge is called with a batch of claim pairs and answers each with a
verdict. services/claim_verdicts.py keeps one known verdict per pair sent,
and "outdated" only when the sources' dates prove which claim is later
(owner decision D5); otherwise it is "disputed". A fake model stands in for
the provider, so these run without any provider SDK.
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services import llm_client
from services.claim_verdicts import newer_side, settle_judgements
from services.providers import LLMResult


def _side(claim: str, date: str | None = None, kind: str | None = None, quote: str | None = None) -> dict:
    return {"claim": claim, "quote": quote, "date": date, "date_kind": kind}


def _pair(pair_id: str, a: dict, b: dict, subject: str = "Bitcoin") -> dict:
    return {"pair_id": pair_id, "subject": subject, "a": a, "b": b}


def _judgement(pair_id: str, verdict: str, topic: str = "launch year", reason: str = "A says x; B says y.") -> llm_client.ClaimJudgement:
    return llm_client.ClaimJudgement(pair_id=pair_id, topic=topic, reason=reason, verdict=verdict)


# ---------------------------------------------------------------------------
# Dates (D5)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("a", "b", "newer"),
    [
        # Two publication dates: the later one is newer.
        (("2020-01-01", "published"), ("2023-05-01", "published"), "b"),
        (("2023-05-01", "published"), ("2020-01-01", "published"), "a"),
        # Same day: no order.
        (("2023-05-01", "published"), ("2023-05-01", "published"), None),
        # A saved date bounds publication from above: a source saved in 2019
        # was published by then, so a 2023 publication is later ...
        (("2019-06-01", "saved"), ("2023-05-01", "published"), "b"),
        # ... but a source saved in 2024 may have been published any time
        # before, so it is not provably later than a 2023 publication.
        (("2023-05-01", "published"), ("2024-02-01", "saved"), None),
        (("2020-01-01", "saved"), ("2024-02-01", "saved"), None),
        # Unknown or malformed dates: no order.
        ((None, None), ("2024-02-01", "published"), None),
        (("2024-02", "published"), ("2020-01-01", "published"), None),
    ],
)
def test_newer_side_only_when_the_dates_prove_it(a, b, newer):
    assert newer_side(_side("x", *a), _side("y", *b)) == newer


def test_outdated_stands_only_with_a_provable_order():
    pairs = [
        _pair("ordered", _side("supports 10 languages", "2020-01-01", "published"), _side("supports 40 languages", "2024-01-01", "published")),
        _pair("same-day", _side("supports 10 languages", "2024-01-01", "published"), _side("supports 40 languages", "2024-01-01", "published")),
        _pair("saved", _side("supports 10 languages", "2020-01-01", "published"), _side("supports 40 languages", "2024-01-01", "saved")),
    ]
    settled = settle_judgements(pairs, [_judgement(p["pair_id"], "outdated") for p in pairs])
    assert [(s.pair_id, s.verdict, s.newer) for s in settled] == [
        ("ordered", "outdated", "b"),
        ("same-day", "disputed", None),
        ("saved", "disputed", None),
    ]


def test_settle_keeps_one_known_verdict_per_pair_sent():
    pairs = [
        _pair("p1", _side("a1"), _side("b1")),
        _pair("p2", _side("a2"), _side("b2")),
        _pair("p3", _side("a3"), _side("b3")),
    ]
    settled = settle_judgements(pairs, [
        _judgement("p2", " Scope "),          # case and spacing ignored
        _judgement("p1", "none"),
        _judgement("p1", "disputed"),         # a second answer for p1: the first wins
        _judgement("p3", "contradiction"),    # not a verdict: p3 stays unjudged
        _judgement("p9", "disputed"),         # a pair that was never sent
    ])
    # In the order the pairs were sent.
    assert [(s.pair_id, s.verdict, s.newer) for s in settled] == [("p1", "none", None), ("p2", "scope", None)]


# ---------------------------------------------------------------------------
# The route
# ---------------------------------------------------------------------------


@pytest.fixture
def api():
    from routers.claims import router  # noqa: PLC0415
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class _FakeModel:
    """Answers with fixed judgements; holds a place under the daily cap like
    a real provider does before sending."""

    def __init__(self, judgements: list[dict]):
        self.judgements = judgements
        self.sent: list = []

    def cost_usd(self, model, usage):
        return 0.001

    def complete(self, req):
        with llm_client._spend_reservation(req):
            self.sent.append(req)
            text = json.dumps({"judgements": self.judgements})
            return LLMResult(
                text=text,
                parsed=llm_client.ClaimJudgeResponse.model_validate_json(text),
                parse_error=None,
                usage={},
                finish_reason="STOP",
            )


def _use(monkeypatch, fake: _FakeModel) -> _FakeModel:
    monkeypatch.setattr(llm_client, "get_provider", lambda model: fake)
    return fake


BODY = {
    "pairs": [
        _pair("p1", _side("Bitcoin launched in 2008.", "2020-01-01", "published", "It launched in 2008."),
              _side("Bitcoin launched in 2009.", "2023-01-01", "published")),
        _pair("p2", _side("The cap is 21 million coins.", "2020-01-01", "published"),
              _side("Supply stops at 21 million.", "2023-01-01", "published")),
    ],
    "compile_model": "deepseek-flash",
}


def test_returns_the_settled_verdicts(api, monkeypatch):
    fake = _use(monkeypatch, _FakeModel([
        {"pair_id": "p1", "topic": "launch year", "reason": "A gives 2008; B gives 2009.", "verdict": "outdated"},
        {"pair_id": "p2", "topic": "supply cap", "reason": "Both give 21 million.", "verdict": "none"},
    ]))

    resp = api.post("/pipeline/judge-claims", json=BODY)

    assert resp.status_code == 200
    assert resp.json() == {
        "items": [
            {"pair_id": "p1", "verdict": "outdated", "topic": "launch year", "reason": "A gives 2008; B gives 2009.", "newer": "b"},
            {"pair_id": "p2", "verdict": "none", "topic": "supply cap", "reason": "Both give 21 million.", "newer": None},
        ],
        "count": 2,
    }
    assert len(fake.sent) == 1
    assert fake.sent[0].model == "deepseek-flash"
    assert "PAIR p1 (subject: Bitcoin)" in fake.sent[0].messages[1]["content"]


def test_answers_503_at_the_daily_cap_without_sending(api, monkeypatch, tmp_path):
    # conftest points llm_client's spend files into tmp_path.
    (tmp_path / "llm-config.json").write_text(json.dumps({"daily_cap_usd": 1.0}))
    (tmp_path / "llm-cap.json").write_text(json.dumps(
        {"date": llm_client._utc_today(), "total_usd": 1.0, "call_count": 1}
    ))
    fake = _use(monkeypatch, _FakeModel([]))

    resp = api.post("/pipeline/judge-claims", json=BODY)

    assert resp.status_code == 503
    assert resp.json() == {"detail": "daily_cost_ceiling"}
    assert fake.sent == []


def test_rate_limit_and_parse_failures_map_like_the_other_llm_routes(api, monkeypatch):
    def _raise(exc):
        def _judge(*args, **kwargs):
            raise exc
        return _judge

    monkeypatch.setattr("routers.claims.judge_claim_pairs", _raise(llm_client.LLMRateLimitedError("x")))
    assert api.post("/pipeline/judge-claims", json=BODY).status_code == 429
    monkeypatch.setattr("routers.claims.judge_claim_pairs", _raise(llm_client.LLMCompileError("bad json")))
    resp = api.post("/pipeline/judge-claims", json=BODY)
    assert resp.status_code == 500
    assert resp.json() == {"detail": "bad json"}


@pytest.mark.parametrize(
    "body",
    [
        {**BODY, "extra": 1},
        {**BODY, "pairs": []},
        {**BODY, "pairs": [BODY["pairs"][0]] * 2},  # duplicate pair ids
        {**BODY, "pairs": [_pair(f"p{i}", _side("a"), _side("b")) for i in range(llm_client.CLAIM_JUDGE_MAX_PAIRS + 1)]},
        {**BODY, "pairs": [_pair("p1", _side("a", "2020-1-1", "published"), _side("b"))]},
        {**BODY, "pairs": [_pair("p1", _side("a", "2020-01-01", "written"), _side("b"))]},
        {**BODY, "pairs": [_pair("p1", _side(""), _side("b"))]},
        {**BODY, "compile_model": "gpt-5"},
    ],
)
def test_rejects_bad_requests(api, monkeypatch, body):
    fake = _use(monkeypatch, _FakeModel([]))
    assert api.post("/pipeline/judge-claims", json=body).status_code == 422
    assert fake.sent == []


def test_reads_the_source_titles(api, monkeypatch):
    fake = _use(monkeypatch, _FakeModel([]))
    pair = _pair("p1", {**_side("Supports 10 languages.", "2020-01-01", "published"), "source_title": "Release notes 1.0"},
                 _side("Supports 40 languages.", "2024-01-01", "published"))
    resp = api.post("/pipeline/judge-claims", json={"pairs": [pair], "compile_model": "deepseek-flash"})
    assert resp.status_code == 200
    assert resp.json() == {"items": [], "count": 0}
    assert '  A ("Release notes 1.0", published 2020-01-01): Supports 10 languages.' in fake.sent[0].messages[1]["content"]
    assert "  B (published 2024-01-01): Supports 40 languages." in fake.sent[0].messages[1]["content"]
