"""Layer 2 merges on similarity only when the names say the same words, and
asks Layer 3 about every acronym and one-letter slip Layer 1 no longer merges.

Audit 2026-10-23: "North Korea" / "South Korea" shaped pairs pass every
guard, so similarity alone merged them; with no context the two-signal gate
became a name-only gate. Owner decision (2026-10-23): an acronym and its
expansion become a forced, top-ranked Layer 3 pair; after a "same" verdict
the alias is stored, so the question is asked once per wiki. Single words one
letter apart ("Wikipedia" / "Wikimedia") go to Layer 3 too.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

DIM = 32


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


def _alike(a: str, b: str, sim: float, axis: int, ctx_a: str = "a", ctx_b: str = "b") -> dict[str, list[float]]:
    """a and b with cosine `sim` by name and by "name: context"."""
    out = {a: _like(1.0, axis), b: _like(sim, axis)}
    out[f"{a}: {ctx_a}" if ctx_a else a] = _like(1.0, axis)
    out[f"{b}: {ctx_b}" if ctx_b else b] = _like(sim, axis)
    return out


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


def _entity(name: str, type_: str, source: str, context: str = "") -> dict[str, Any]:
    return {"name": name, "type": type_, "source_id": source, "context": context}


def _embedding(client, entities, groups=None, pages=None) -> dict[str, Any]:
    resp = client.post("/resolve/embedding",
                       json={"entities": entities, "existing_page_titles": pages or [], "groups": groups or []})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _asked(data: dict[str, Any]) -> list[tuple[str, str]]:
    return [(p["entity_a"]["name"], p["entity_b"]["name"]) for p in data["ambiguous"]]


# ---------------------------------------------------------------------------
# The content-word gate
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("a,b,type_", [
    ("North Korea", "South Korea", "LOCATION"),
    ("Vilnius City Hall", "Vilnius Town Hall", "ORG"),
    ("supervised learning", "unsupervised learning", "CONCEPT"),
    ("Machine translation", "Automatic translation", "CONCEPT"),
])
def test_names_that_say_different_words_go_to_layer_3(client, encoder, a, b, type_):
    encoder(_alike(a, b, 0.96, 0))
    data = _embedding(client, [_entity(a, type_, "s1", "a"), _entity(b, type_, "s2", "b")])
    assert data["resolved"] == []
    assert _asked(data) == [(a, b)]
    assert data["rerouted"] == 1


@pytest.mark.parametrize("a,b", [("Zurich", "Zürich"), ("Large Language Model", "large language models"),
                                 ("Kraków", "Krakow")])
def test_names_that_say_the_same_words_still_merge(client, encoder, a, b):
    encoder(_alike(a, b, 0.96, 0))
    data = _embedding(client, [_entity(a, "ORG", "s1", "a"), _entity(b, "ORG", "s2", "b")])
    assert [sorted([g["canonical"], *g["aliases"]]) for g in data["resolved"]] == [sorted([a, b])]
    assert data["ambiguous"] == []
    assert data["rerouted"] == 0


def test_never_merged_without_context(client, encoder):
    encoder(_alike("Large Language Model", "Large Language Models", 0.96, 0, ctx_a="", ctx_b="b"))
    data = _embedding(client, [_entity("Large Language Model", "CONCEPT", "s1", ""),
                               _entity("Large Language Models", "CONCEPT", "s2", "b")])
    assert data["resolved"] == []
    assert _asked(data) == [("Large Language Model", "Large Language Models")]
    assert data["rerouted"] == 1


def test_people_need_the_same_words_without_plurals(client, encoder):
    encoder(_alike("John Edward", "John Edwards", 0.96, 0))
    data = _embedding(client, [_entity("John Edward", "PERSON", "s1", "a"), _entity("John Edwards", "PERSON", "s2", "b")])
    assert data["resolved"] == []
    assert _asked(data) == [("John Edward", "John Edwards")]


def test_a_page_is_anchored_only_by_the_same_words_and_a_context(client, encoder):
    vectors = {"South Korea": _like(1.0, 0), "North Korea": _like(0.96, 0), "North Korea: a": _like(0.96, 0),
               "Zürich": _like(1.0, 4), "Zurich": _like(0.96, 4), "Zurich: a": _like(0.96, 4)}
    encoder(vectors)
    pages = [{"title": "South Korea", "page_type": "entity"}, {"title": "Zürich", "page_type": "entity"}]
    data = _embedding(client, [_entity("North Korea", "LOCATION", "s1", "a"), _entity("Zurich", "LOCATION", "s2", "a")],
                      pages=pages)
    assert [(g["canonical"], g["aliases"], g["method"]) for g in data["resolved"]] == [
        ("Zürich", ["Zurich"], "existing_page_title"),
    ]
    assert _asked(data) == [("North Korea", "South Korea")]
    assert data["rerouted"] == 1

    bare = _embedding(client, [_entity("Zurich", "LOCATION", "s2", "")], pages=pages)
    assert bare["resolved"] == []
    assert _asked(bare) == [("Zurich", "Zürich")]
    assert bare["rerouted"] == 1


# ---------------------------------------------------------------------------
# Acronyms and one-letter slips: forced Layer 3 pairs
# ---------------------------------------------------------------------------


def test_an_acronym_and_its_expansion_are_always_asked_first(client, encoder):
    encoder({**_alike("ML", "Machine Learning", 0.3, 0), **_alike("Gas fee", "Transaction fee", 0.85, 4)})
    data = _embedding(client, [_entity("ML", "CONCEPT", "s1", "a"), _entity("Machine Learning", "CONCEPT", "s2", "b"),
                               _entity("Gas fee", "CONCEPT", "s3", "a"), _entity("Transaction fee", "CONCEPT", "s4", "b")])
    assert data["resolved"] == []
    assert _asked(data) == [("ML", "Machine Learning"), ("Gas fee", "Transaction fee")]
    assert [p["abbreviation"] for p in data["ambiguous"]] == [True, False]
    assert data["unresolved"] == []


def test_an_acronym_is_asked_about_every_page_it_could_stand_for(client, encoder):
    encoder({})
    data = _embedding(client, [_entity("CI", "CONCEPT", "s1", "a")], pages=[
        {"title": "Continuous Integration", "page_type": "concept"},
        {"title": "Confidence Interval", "page_type": "concept"},
        {"title": "Cloud Infrastructure", "page_type": "entity"},     # any kind
        {"title": "Certified Investor", "page_type": "concept"},
    ])
    assert sorted(_asked(data)) == [("CI", "Certified Investor"), ("CI", "Cloud Infrastructure"),
                                    ("CI", "Confidence Interval"), ("CI", "Continuous Integration")]
    assert all(p["abbreviation"] and p["entity_b"]["source_id"] == "__existing_page__" for p in data["ambiguous"])


def test_an_acronym_inside_a_group_is_found(client, encoder):
    encoder({})
    groups = [{"canonical": "LLMs", "type": "CONCEPT", "aliases": ["LLM"], "source_ids": ["s1", "s2"],
               "method": "plural", "context": "a"}]
    data = _embedding(client, [_entity("Large Language Model", "CONCEPT", "s3", "b")], groups=groups)
    assert _asked(data) == [("LLMs", "Large Language Model")]
    assert data["ambiguous"][0]["abbreviation"] is True


def test_lowercase_initials_are_not_asked_about(client, encoder):
    encoder({})
    data = _embedding(client, [_entity("it", "CONCEPT", "s1", "a"), _entity("Information Technology", "CONCEPT", "s2", "b")])
    assert data["ambiguous"] == []


def test_two_pages_never_meet_through_an_acronym(client, encoder):
    encoder({})
    groups = [{"canonical": "ML", "type": "CONCEPT", "aliases": [], "source_ids": ["s1"],
               "method": "existing_page_title", "context": "a"},
              {"canonical": "Machine Learning", "type": "CONCEPT", "aliases": [], "source_ids": ["s2"],
               "method": "existing_alias", "context": "b"}]
    data = _embedding(client, [], groups=groups)
    assert data["ambiguous"] == []


def test_single_words_one_letter_apart_are_asked_about(client, encoder):
    encoder(_alike("Wikipedia", "Wikimedia", 0.5, 0))
    data = _embedding(client, [_entity("Wikipedia", "ORG", "s1", "a"), _entity("Wikimedia", "ORG", "s2", "b")],
                      pages=[{"title": "Kubernetes", "page_type": "entity"}])
    assert _asked(data) == [("Wikipedia", "Wikimedia")]
    assert data["ambiguous"][0]["abbreviation"] is False
    page = _embedding(client, [_entity("Kubernetis", "PRODUCT", "s1", "a")], pages=[{"title": "Kubernetes", "page_type": "entity"}])
    assert _asked(page) == [("Kubernetis", "Kubernetes")]


# ---------------------------------------------------------------------------
# same_source: one source names both sides
# ---------------------------------------------------------------------------


def test_pairs_say_whether_one_source_names_both(client, encoder):
    encoder({**_alike("Kaunas Castle", "Kaunas Fortress", 0.85, 0), **_alike("Gas fee", "Transaction fee", 0.85, 4),
             "Echo": _like(1.0, 8), "Echo: a": _like(1.0, 8), "Echo Corp": _like(0.8, 8)})
    data = _embedding(client, [
        _entity("Kaunas Castle", "LOCATION", "s1", "a"), _entity("Kaunas Fortress", "LOCATION", "s1", "b"),
        _entity("Gas fee", "CONCEPT", "s2", "a"), _entity("Transaction fee", "CONCEPT", "s3", "b"),
        _entity("Echo", "ORG", "s4", "a"),
    ], pages=[{"title": "Echo Corp", "page_type": "entity"}])
    assert {p["entity_a"]["name"]: p["same_source"] for p in data["ambiguous"]} == {
        "Gas fee": False, "Echo": False, "Kaunas Castle": True,
    }


def test_layer_3_hands_the_hint_to_the_model_and_old_callers_validate(client, monkeypatch):
    from services import llm_client as llm_client_mod  # noqa: PLC0415
    from services.llm_client import DisambiguationResponse  # noqa: PLC0415

    sent: list[dict[str, Any]] = []

    def fake(pairs, model, pair_kind="entity"):  # noqa: ARG001
        sent.extend(pairs)
        return DisambiguationResponse(results=[])

    monkeypatch.setattr(llm_client_mod, "disambiguate_entities", fake)
    base = {"entity_a": _entity("Alpha Corp", "ORG", "s1"), "entity_b": _entity("Beta Corp", "ORG", "s1"),
            "similarity": 0.8}
    for pair, hint in ((base, False), ({**base, "same_source": True, "abbreviation": False, "name_similarity": 0.8}, True)):
        sent.clear()
        resp = client.post("/resolve/disambiguate", json={"pairs": [pair]})
        assert resp.status_code == 200
        assert sent[0]["same_source"] is hint


def test_layer_2_takes_the_kind_most_sources_give(client, encoder):
    encoder({text: _like(1.0, 0) for text in ("Bitcoin", "Bitcoin: a", "Bitcoin: b", "Bitcoin: c")})
    data = _embedding(client, [_entity("Bitcoin", "OTHER", "s1", "a"), _entity("Bitcoin", "CONCEPT", "s2", "b"),
                               _entity("Bitcoin", "CONCEPT", "s3", "c")])
    assert [(g["type"], g["source_ids"]) for g in data["resolved"]] == [("CONCEPT", ["s1", "s2", "s3"])]
