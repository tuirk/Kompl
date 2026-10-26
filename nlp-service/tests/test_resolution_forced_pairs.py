"""Pairs Layer 3 is asked about whatever their similarity.

Replay gate, 2026-10-23: "APCA" (an existing page) and the new name "APCA
contrast algorithm" score 0.53 by name and 0.57 with their contexts
(all-MiniLM-L6-v2), under Layer 2's 0.7 band, so the pair never reached
Layer 3 and the compile made a second page. "ETH" / "Ethereum" score 0.53
and 0.20, and the acronym rule read initials only. Now:
  - a name that adds words to a page title, or to the canonical a stored
    alias binds a group to, is asked about against that page. Never merged
    on its own: the same shape took "Ethereum" into "Ethereum Foundation"
    and "LLM" into "LLM draft path";
  - an acronym or ticker and its expansion are the pairs the alias screen
    keeps for Layer 3 (acronymPair in app/src/lib/alias-shapes.ts);
    fixtures/acronym_pair_cases.json holds both sides to the same cases.
"""

from __future__ import annotations

import json
import math
import random
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.resolution import _is_acronym_pair, _layer3_only_method, _name_tokens
from routers.resolution_rules import WordBagIndex, adds_words

DIM = 48
ACRONYM_CASES = json.loads((Path(__file__).parent / "fixtures" / "acronym_pair_cases.json").read_text(encoding="utf-8"))


class _Encoder:
    """Listed texts get their vectors; any other text is unlike everything."""

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
    """Cosine `name` between a and b, `ctx` between "a: a" and "b: b"; axes axis..axis+3."""
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


def _entity(name: str, type_: str, source: str, context: str = "") -> dict[str, Any]:
    return {"name": name, "type": type_, "source_id": source, "context": context}


def _group(canonical: str, type_: str, sources: list[str], method: str,
           aliases: list[str] | None = None, context: str = "a") -> dict[str, Any]:
    return {"canonical": canonical, "type": type_, "aliases": aliases or [], "source_ids": sources,
            "method": method, "context": context}


def _out(group: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in group.items() if k != "context"}


def _embedding(client, entities, groups=None, pages=None) -> dict[str, Any]:
    resp = client.post("/resolve/embedding", json={
        "entities": entities, "groups": groups or [], "existing_page_titles": pages or [],
    })
    assert resp.status_code == 200, resp.text
    return resp.json()


def _pairs(data: dict[str, Any]) -> list[tuple[str, str, str, str, float]]:
    return [(p["entity_a"]["name"], p["entity_a"]["source_id"], p["entity_b"]["name"], p["entity_b"]["source_id"],
             p["similarity"]) for p in data["ambiguous"]]


# ---------------------------------------------------------------------------
# A name that adds words to a page title
# ---------------------------------------------------------------------------


def test_a_name_that_adds_words_to_a_bound_page_is_asked_against_it(client, encoder):
    encoder(_pair("APCA", "APCA contrast algorithm", 0.53, 0.57, 0))
    group = _group("APCA", "CONCEPT", ["s1"], "existing_page_title")
    data = _embedding(client, [_entity("APCA contrast algorithm", "CONCEPT", "s2", "b")], groups=[group],
                      pages=[{"title": "APCA", "page_type": "concept"}])
    assert data["resolved"] == [_out(group)]
    assert _pairs(data) == [("APCA", "__group__:0", "APCA contrast algorithm", "s2", 0.57)]
    assert data["ambiguous"][0]["abbreviation"] is False
    assert data["unresolved"] == []


def test_a_name_that_adds_words_to_a_page_title_is_asked_against_the_page(client, encoder):
    encoder({"APCA contrast algorithm": _like(1.0, 0), "APCA contrast algorithm: b": _like(1.0, 2),
             "APCA": _like(0.53, 0)})
    data = _embedding(client, [_entity("APCA contrast algorithm", "CONCEPT", "s2", "b")],
                      pages=[{"title": "APCA", "page_type": "concept"}])
    assert data["resolved"] == []
    assert _pairs(data) == [("APCA contrast algorithm", "s2", "APCA", "__existing_page__", 0.53)]
    assert data["unresolved"] == []


def test_a_name_that_adds_words_to_many_page_titles_is_asked_about_the_two_most_like_it(client, encoder):
    """On a large wiki a long name adds words to many short titles; all of
    them took Layer 3 slots ahead of the pairs one source names, most of
    them broader topics (audit 2026-10-26)."""
    name = "APCA contrast algorithm"
    titles = {"APCA": 0.53, "Contrast algorithm": 0.6, "Contrast": 0.45, "Algorithm": 0.3}
    encoder({name: _like(1.0, 0), f"{name}: b": _like(1.0, 2), **{t: _like(s, 0) for t, s in titles.items()}})
    data = _embedding(client, [_entity(name, "CONCEPT", "s2", "b")],
                      pages=[{"title": t, "page_type": "concept"} for t in titles])
    assert _pairs(data) == [(name, "s2", "APCA", "__existing_page__", 0.53),
                            (name, "s2", "Contrast algorithm", "__existing_page__", 0.6)]


@pytest.mark.parametrize("sim", [0.4, 0.99])
def test_a_name_that_adds_words_to_an_alias_canonical_is_asked_never_merged(client, encoder, sim):
    """Below the band it is asked all the same; past the merge bar it is
    still only asked: "Ethereum Foundation" is not "Ethereum"."""
    encoder(_pair("Ethereum", "Ethereum Foundation", sim, sim, 0))
    group = _group("Ethereum", "ORG", ["s1"], "existing_alias", aliases=["ETH"])
    data = _embedding(client, [_entity("Ethereum Foundation", "ORG", "s2", "b")], groups=[group],
                      pages=[{"title": "Ethereum", "page_type": "entity"}])
    assert data["resolved"] == [_out(group)]
    assert _pairs(data) == [("Ethereum", "__group__:0", "Ethereum Foundation", "s2", sim)]


def test_a_page_title_with_added_words_alike_past_the_merge_bar_is_only_asked(client, encoder):
    same = _like(1.0, 0)
    encoder({"APCA contrast algorithm": same, "APCA contrast algorithm: b": same, "APCA": same})
    data = _embedding(client, [_entity("APCA contrast algorithm", "CONCEPT", "s2", "b")],
                      pages=[{"title": "APCA", "page_type": "concept"}])
    assert data["resolved"] == []
    assert _pairs(data) == [("APCA contrast algorithm", "s2", "APCA", "__existing_page__", 1.0)]


def test_across_kinds_the_page_is_asked_about_too(client, encoder):
    """Sources type "APCA" PRODUCT and the longer name CONCEPT."""
    encoder(_pair("APCA", "APCA contrast algorithm", 0.53, 0.57, 0))
    group = _group("APCA", "PRODUCT", ["s1"], "existing_page_title")
    data = _embedding(client, [_entity("APCA contrast algorithm", "CONCEPT", "s2", "b")], groups=[group])
    assert _pairs(data) == [("APCA", "__group__:0", "APCA contrast algorithm", "s2", 0.53)]


@pytest.mark.parametrize("entity,page", [
    (("Vilnius", "LOCATION"), ("Vilnius Cathedral", "entity")),          # shorter than the page
    (("Python 3 release", "PRODUCT"), ("Python", "entity")),            # a number only one carries
    (("Kaunas City Museum", "LOCATION"), ("Kaunas City Hall", "entity")),  # different words
])
def test_only_names_that_add_words_to_the_page_are_asked_whatever_the_similarity(client, encoder, entity, page):
    encoder({})
    data = _embedding(client, [_entity(entity[0], entity[1], "s2", "b")],
                      pages=[{"title": page[0], "page_type": page[1]}])
    assert data["ambiguous"] == []


def test_kinds_that_never_meet_are_not_asked(client, encoder):
    encoder({})
    group = _group("Paul Graham", "PERSON", ["s1"], "existing_page_title")
    data = _embedding(client, [_entity("Paul Graham Foundation", "ORG", "s2", "b")], groups=[group])
    assert data["ambiguous"] == []


def test_two_session_names_are_still_a_similarity_question(client, encoder):
    """Only a page or a stored alias's canonical forces the question; in a
    session "Ethereum" / "Ethereum Foundation" go by similarity as before."""
    encoder({})
    data = _embedding(client, [_entity("Ethereum", "ORG", "s1", "a"), _entity("Ethereum Foundation", "ORG", "s2", "b")])
    assert data["ambiguous"] == []


def test_a_name_that_adds_words_to_a_page_ranks_with_the_wiki_pairs(client, encoder):
    """Tier of pairs against the wiki or across sources, then by name similarity."""
    encoder({
        **_pair("Ethereum", "Ethereum Foundation", 0.4, 0.4, 0),
        **_pair("Gas fee", "Transaction fee", 0.75, 0.7, 4),       # two sources
        **_pair("Alpha thing", "Beta thing", 0.88, 0.8, 8),        # one source names both
    })
    group = _group("Ethereum", "ORG", ["s1"], "existing_page_title")
    data = _embedding(client, [
        _entity("Ethereum Foundation", "ORG", "s2", "b"),
        _entity("Gas fee", "CONCEPT", "s3", "a"), _entity("Transaction fee", "CONCEPT", "s4", "b"),
        _entity("Alpha thing", "CONCEPT", "s5", "a"), _entity("Beta thing", "CONCEPT", "s5", "b"),
    ], groups=[group])
    assert [p[0] for p in _pairs(data)] == ["Gas fee", "Ethereum", "Alpha thing"]


def test_the_word_index_finds_every_title_a_name_adds_words_to():
    rng = random.Random(20261023)
    words = "apca contrast algorithm ethereum foundation llm draft path data model the of city hall".split()
    titles = [[rng.choice(words) for _ in range(rng.randint(1, 3))] for _ in range(300)] + [[]]
    names = [[rng.choice(words) for _ in range(rng.randint(1, 5))] for _ in range(300)]
    index = WordBagIndex(titles)
    for name in names:
        assert index.contained_in(name) == [k for k, t in enumerate(titles) if adds_words(name, t)], name


def test_adds_words_counts_repeated_words():
    assert adds_words(_name_tokens("APCA contrast algorithm"), _name_tokens("APCA"))
    assert not adds_words(_name_tokens("APCA"), _name_tokens("APCA contrast algorithm"))
    assert not adds_words(_name_tokens("APCA"), _name_tokens("apca"))
    assert adds_words(["new", "new", "york"], ["new", "new"])
    assert not adds_words(["new", "york"], ["new", "new"])


# ---------------------------------------------------------------------------
# Acronyms and tickers: the pairs the alias screen keeps for Layer 3
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", ACRONYM_CASES, ids=lambda c: f"{c['a']}/{c['b']}")
def test_acronym_pair_cases_shared_with_the_alias_screen(case):
    assert _is_acronym_pair(case["a"], case["b"]) is case["acronym"]
    assert _is_acronym_pair(case["b"], case["a"]) is case["acronym"]
    assert (_layer3_only_method(case["a"], case["b"]) == "acronym") is case["acronym"]


def test_a_ticker_and_its_expansion_are_asked_about(client, encoder):
    encoder(_pair("ETH", "Ethereum", 0.53, 0.2, 0))
    data = _embedding(client, [_entity("ETH", "PRODUCT", "s1", "a"), _entity("Ethereum", "PRODUCT", "s2", "b")])
    assert _pairs(data) == [("ETH", "s1", "Ethereum", "s2", 0.53)]
    assert data["ambiguous"][0]["abbreviation"] is True


def test_a_ticker_is_asked_about_against_the_page_of_its_expansion(client, encoder):
    encoder({"ETH": _like(1.0, 0), "ETH: a": _like(1.0, 2), "Ethereum": _like(0.53, 0)})
    data = _embedding(client, [_entity("ETH", "PRODUCT", "s1", "a")],
                      pages=[{"title": "Ethereum", "page_type": "entity"}])
    assert _pairs(data) == [("ETH", "s1", "Ethereum", "__existing_page__", 0.53)]
    assert data["ambiguous"][0]["abbreviation"] is True
