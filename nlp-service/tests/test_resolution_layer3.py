"""Layer 3: which pairs get the capped LLM budget, and how verdicts come back.

Audit 2026-10-23 of the resolver's semantic layers:
- Pairs were ranked by name similarity alone, so a list article's
  same-source pairs pushed out pairs across sources and against pages, and
  abbreviations ("ETH" / "Ethereum"), low by name similarity, were cut first.
- Verdicts were matched back to pairs by name: two pairs with the same names
  shared one verdict, and a reply that swapped or re-cased the names was lost.
- One failed LLM batch failed the whole resolve.
- A "same" verdict's canonical could be any name the model wrote.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

DIM = 64


class _Encoder:
    def __init__(self, vectors: dict[str, list[float]]):
        self.vectors = vectors

    def encode(self, texts, convert_to_numpy=True, normalize_embeddings=False):  # noqa: ARG002
        return np.array([self.vectors.get(t, [0.0] * DIM) for t in texts], dtype=np.float32)


def _like(sim: float, axis: int) -> list[float]:
    v = [0.0] * DIM
    v[axis] = sim
    v[axis + 1] = math.sqrt(max(0.0, 1 - sim * sim))
    return v


def _pair(a: str, b: str, name: float, ctx: float, axis: int) -> dict[str, list[float]]:
    """Vectors with cosine `name` between a and b and `ctx` between "a: a" and "b: b"."""
    return {a: _like(1.0, axis), b: _like(name, axis), f"{a}: a": _like(1.0, axis + 2), f"{b}: b": _like(ctx, axis + 2)}


@pytest.fixture(scope="module")
def client():
    from routers.resolution import router  # noqa: PLC0415
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


@pytest.fixture
def encoder(monkeypatch):
    from routers import resolution  # noqa: PLC0415

    def install(vectors: dict[str, list[float]]):
        monkeypatch.setattr(resolution, "_get_embed_model", lambda: _Encoder(vectors))

    return install


def _entity(name: str, type_: str = "ORG", source: str = "s1", context: str = "") -> dict[str, Any]:
    return {"name": name, "type": type_, "source_id": source, "context": context}


def _embedding(client, entities, groups=None, pages=None) -> list[str]:
    body: dict[str, Any] = {"entities": entities, "existing_page_titles": pages or [], "groups": groups or []}
    resp = client.post("/resolve/embedding", json=body)
    assert resp.status_code == 200, resp.text
    return [p["entity_a"]["name"] for p in resp.json()["ambiguous"]]


# ---------------------------------------------------------------------------
# Ranking for the capped budget
# ---------------------------------------------------------------------------


def test_pairs_across_sources_or_against_the_wiki_rank_before_pairs_one_source_names(client, encoder):
    encoder({
        **_pair("Kaunas Castle", "Kaunas Fortress", 0.88, 0.8, 0),      # one source lists both
        **_pair("Gas fee", "Transaction fee", 0.75, 0.7, 4),             # two sources
        "Echo": _like(1.0, 8), "Echo: a": _like(1.0, 8), "Echo Corp": _like(0.72, 8),  # a page
    })
    order = _embedding(client, [
        _entity("Kaunas Castle", "LOCATION", "s1", "a"), _entity("Kaunas Fortress", "LOCATION", "s1", "b"),
        _entity("Gas fee", "CONCEPT", "s2", "a"), _entity("Transaction fee", "CONCEPT", "s3", "b"),
        _entity("Echo", "ORG", "s4", "a"),
    ], pages=[{"title": "Echo Corp", "page_type": "entity"}])
    assert order == ["Gas fee", "Echo", "Kaunas Castle"]


def test_abbreviations_rank_first_within_their_tier(client, encoder):
    encoder({
        **_pair("ETH", "Ethereum", 0.62, 0.7, 0),                 # two sources, low by name
        **_pair("Web typography", "Typography on the web", 0.9, 0.75, 4),
        **_pair("JS", "JavaScript", 0.71, 0.6, 8),                # one source names both
        **_pair("Dutch auction", "Reverse auction", 0.85, 0.95, 12),
    })
    order = _embedding(client, [
        _entity("ETH", "PRODUCT", "s1", "a"), _entity("Ethereum", "PRODUCT", "s2", "b"),
        _entity("Web typography", "CONCEPT", "s3", "a"), _entity("Typography on the web", "CONCEPT", "s4", "b"),
        _entity("JS", "PRODUCT", "s5", "a"), _entity("JavaScript", "PRODUCT", "s5", "b"),
        _entity("Dutch auction", "CONCEPT", "s6", "a"), _entity("Reverse auction", "CONCEPT", "s6", "b"),
    ])
    assert order == ["ETH", "Web typography", "JS", "Dutch auction"]


def test_a_group_bound_to_a_page_ranks_with_the_wiki_pairs(client, encoder):
    """"APCA", bound to its page, against "APCA contrast algorithm" from the
    same source must still be asked (plan 1.4 known cases)."""
    encoder({
        **_pair("Wiki topic", "Wiki topic overview", 0.74, 0.7, 0),
        **_pair("Alpha thing", "Beta thing", 0.88, 0.8, 4),
    })
    groups = [{"canonical": "Wiki topic", "type": "CONCEPT", "aliases": [], "source_ids": ["s1"],
               "method": "existing_page_title", "context": "a"}]
    order = _embedding(client, [
        _entity("Wiki topic overview", "CONCEPT", "s1", "b"),
        _entity("Alpha thing", "CONCEPT", "s2", "a"), _entity("Beta thing", "CONCEPT", "s2", "b"),
    ], groups=groups)
    assert order == ["Wiki topic", "Alpha thing"]


# ---------------------------------------------------------------------------
# /resolve/disambiguate — verdicts by pair id, failed batches, canonicals
# ---------------------------------------------------------------------------


def _ask(a: str, b: str, pair_id: str | None, type_a: str = "ORG", type_b: str = "ORG") -> dict[str, Any]:
    pair: dict[str, Any] = {"entity_a": _entity(a, type_a, "s1"), "entity_b": _entity(b, type_b, "s2"),
                            "similarity": 0.8, "name_similarity": 0.8}
    if pair_id is not None:
        pair["pair_id"] = pair_id
    return pair


def _llm(monkeypatch, reply):
    """Installs a fake disambiguate_entities: reply(pairs, pair_kind) → list of
    (entity_a, entity_b, decision, canonical), or an exception to raise."""
    from services import llm_client as llm_client_mod  # noqa: PLC0415
    from services.llm_client import DisambiguationResponse, DisambiguationResult  # noqa: PLC0415

    calls: list[list[dict[str, Any]]] = []

    def fake(pairs, model, pair_kind="entity"):  # noqa: ARG001
        calls.append(pairs)
        out = reply(pairs, pair_kind)
        if isinstance(out, Exception):
            raise out
        return DisambiguationResponse(results=[
            DisambiguationResult(entity_a=a, entity_b=b, decision=d, canonical=c, reason="mock") for a, b, d, c in out
        ])

    monkeypatch.setattr(llm_client_mod, "disambiguate_entities", fake)
    return calls


def _disambiguate(client, pairs) -> dict[str, Any]:
    resp = client.post("/resolve/disambiguate", json={"pairs": pairs})
    assert resp.status_code == 200, resp.text
    return resp.json()


def test_two_pairs_with_the_same_names_each_get_their_own_verdict(client, monkeypatch):
    _llm(monkeypatch, lambda pairs, _kind: [
        ("Mercury", "Mercury", "same", "Mercury"),
        ("Mercury", "Mercury", "different", None),
    ])
    data = _disambiguate(client, [_ask("Mercury", "Mercury", "p0", "PERSON", "CONCEPT"),
                                  _ask("Mercury", "Mercury", "p1", "LOCATION", "CONCEPT")])
    assert [(r["pair_id"], r["decision"]) for r in data["results"]] == [("p0", "same"), ("p1", "different")]


def test_a_reply_out_of_order_with_swapped_or_recased_names_reaches_its_pair(client, monkeypatch):
    _llm(monkeypatch, lambda pairs, _kind: [
        ("beta corp", "Alpha Corp", "different", None),
        ("GAMMA LABS", "gamma laboratories", "same", "Gamma Labs"),
    ])
    data = _disambiguate(client, [_ask("Gamma Labs", "Gamma Laboratories", "g"), _ask("Alpha Corp", "Beta Corp", "a")])
    by_id = {r["pair_id"]: r for r in data["results"]}
    assert by_id["g"]["decision"] == "same"
    assert by_id["a"]["decision"] == "different"
    assert [r["pair_id"] for r in data["results"]] == ["g", "a"]  # one result per pair, in request order


def test_a_pair_the_model_left_out_comes_back_ambiguous(client, monkeypatch):
    _llm(monkeypatch, lambda pairs, _kind: [("Alpha Corp", "Beta Corp", "same", "Alpha Corp")])
    data = _disambiguate(client, [_ask("Alpha Corp", "Beta Corp", "a"), _ask("Gamma Labs", "Delta Labs", "g")])
    by_id = {r["pair_id"]: r for r in data["results"]}
    assert by_id["a"]["decision"] == "same"
    assert by_id["g"]["decision"] == "ambiguous"
    assert by_id["g"]["canonical"] is None


def test_a_failed_batch_leaves_its_pairs_ambiguous_and_the_rest_are_answered(client, monkeypatch):
    from services.llm_client import LLMCompileError  # noqa: PLC0415

    def reply(pairs, _kind):
        if pairs[0]["entity_a"]["name"] == "Name a":
            return LLMCompileError("disambiguate_llm_parse_failed: truncated JSON")
        return [(p["entity_a"]["name"], p["entity_b"]["name"], "different", None) for p in pairs]

    calls = _llm(monkeypatch, reply)
    pairs = [_ask(f"Name {c}", f"Other {c}", f"p{i}") for i, c in enumerate("abcdefghijklmno")]
    data = _disambiguate(client, pairs)
    assert len(calls) == 2
    decisions = [r["decision"] for r in data["results"]]
    assert decisions == ["ambiguous"] * 10 + ["different"] * 5
    assert data["failed_pairs"] == 10
    assert all(r["reason"].startswith("llm_failed") for r in data["results"][:10])


@pytest.mark.parametrize("error,status", [("LLMRateLimitedError", 429), ("CostCeilingError", 503)])
def test_rate_limits_and_the_cost_ceiling_still_stop_the_request(client, monkeypatch, error, status):
    from services import llm_client as llm_client_mod  # noqa: PLC0415

    exc = getattr(llm_client_mod, error)
    _llm(monkeypatch, lambda pairs, _kind: exc("stop"))
    resp = client.post("/resolve/disambiguate", json={"pairs": [_ask("Alpha Corp", "Beta Corp", "a")]})
    assert resp.status_code == status


def test_the_cost_ceiling_inside_a_provider_call_still_stops_the_request(client, monkeypatch):
    """The providers charge the daily cap inside complete(), so
    disambiguate_entities hands the ceiling on wrapped in LLMCompileError.
    A failed batch must not swallow it."""
    from services.llm_client import CostCeilingError, LLMCompileError  # noqa: PLC0415

    def reply(pairs, _kind):
        try:
            raise CostCeilingError("Daily LLM spend limit ($1.00) reached.")
        except CostCeilingError as e:
            wrapped = LLMCompileError(f"disambiguate_llm_call_failed: {e}")
            wrapped.__cause__ = e
            return wrapped

    _llm(monkeypatch, reply)
    resp = client.post("/resolve/disambiguate", json={"pairs": [_ask("Alpha Corp", "Beta Corp", "a")]})
    assert resp.status_code == 503


@pytest.mark.parametrize("picked,expected", [
    ("APCA", "APCA"),
    ("APCA contrast algorithm", "APCA contrast algorithm"),
    ("Advanced Perceptual Contrast Algorithm", "APCA contrast algorithm"),
    ("apca", "APCA contrast algorithm"),
    (None, "APCA contrast algorithm"),
])
def test_a_same_verdict_names_one_of_its_two_names(client, monkeypatch, picked, expected):
    _llm(monkeypatch, lambda pairs, _kind: [("APCA", "APCA contrast algorithm", "same", picked)])
    data = _disambiguate(client, [_ask("APCA", "APCA contrast algorithm", "p", "CONCEPT", "CONCEPT")])
    assert data["results"][0]["canonical"] == expected


def test_people_keep_the_fuller_name_when_the_model_invents_one(client, monkeypatch):
    _llm(monkeypatch, lambda pairs, _kind: [("Karpathy", "Andrej Karpathy", "same", "Dr. Andrej Karpathy")])
    data = _disambiguate(client, [_ask("Karpathy", "Andrej Karpathy", "p", "PERSON", "PERSON")])
    assert data["results"][0]["canonical"] == "Andrej Karpathy"


def test_callers_without_pair_ids_still_validate(client, monkeypatch):
    _llm(monkeypatch, lambda pairs, _kind: [("Alpha Corp", "Beta Corp", "different", None)])
    data = _disambiguate(client, [_ask("Alpha Corp", "Beta Corp", None)])
    assert data["results"][0]["pair_id"] is None
    assert data["results"][0]["decision"] == "different"
    assert data["failed_pairs"] == 0


# The abbreviation check that ranks pairs is mirrored in
# app/src/lib/resolve-ranking.ts; this fixture keeps the two equal.
_ABBREVIATION_CASES = json.loads(
    (Path(__file__).parent / "fixtures" / "abbreviation_cases.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", _ABBREVIATION_CASES, ids=lambda c: f"{c['short']}/{c['long']}")
def test_abbreviation_cases_shared_with_the_route(case):
    from routers.resolution import _is_abbreviation  # noqa: PLC0415

    assert _is_abbreviation(case["short"], case["long"]) is case["abbreviation"]
