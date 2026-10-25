"""Layer 2 merges only what the names and the sources agree on.

Offline replays of 2026-10-10 and 2026-10-17 sessions: "name: context"
similarity above 0.9 merged different things one source names side by side
("Set collection" / "Route planning", "Kaunas City Hall" / "Kaunas City
Museum", "English" / "programming language"), anchored "Kei Ito" to the
"Masataka Okabe" page, and Layer 1's groups never reached Layer 2 at all, so
"APCA" (bound to its page) never met "APCA contrast algorithm". These tests
pin the name-only gate, the shared-source rule, groups passed in and out
(`__group__:<k>`), comparisons across kinds and the pair order.

The encoder below gives each text its own vector, so a name and its
"name: context" text can be made alike or unlike independently.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

DIM = 48


class _Encoder:
    def __init__(self, vectors: dict[str, list[float]]):
        self.vectors = vectors

    def encode(self, texts, convert_to_numpy=True, normalize_embeddings=False):  # noqa: ARG002
        return np.array([self.vectors.get(t, [0.0] * DIM) for t in texts], dtype=np.float32)


def _like(sim: float, axis: int) -> list[float]:
    """A unit vector whose cosine with axis `axis` is `sim` (the rest on axis + 1)."""
    v = [0.0] * DIM
    v[axis] = sim
    v[axis + 1] = math.sqrt(max(0.0, 1 - sim * sim))
    return v


def _pair(a: str, b: str, name: float, ctx: float, axis: int) -> dict[str, list[float]]:
    """Vectors for a and b (contexts "a" and "b") with cosine `name` between
    the names and `ctx` between "a: a" and "b: b". Uses axes axis..axis+3."""
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


def _group(canonical: str, type_: str, sources: list[str], method: str = "exact",
           aliases: list[str] | None = None, context: str = "") -> dict[str, Any]:
    return {"canonical": canonical, "type": type_, "aliases": aliases or [], "source_ids": sources,
            "method": method, "context": context}


def _embedding(client, entities, groups=None, pages=None) -> dict[str, Any]:
    body: dict[str, Any] = {"entities": entities, "existing_page_titles": pages or []}
    if groups is not None:
        body["groups"] = groups
    resp = client.post("/resolve/embedding", json=body)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _pairs(data: dict[str, Any]) -> list[tuple[str, str, str, float]]:
    return [(p["entity_a"]["name"], p["entity_a"]["source_id"], p["entity_b"]["name"], p["similarity"])
            for p in data["ambiguous"]]


# ---------------------------------------------------------------------------
# 1.1 — merge on the name, from different sources
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "a,type_a,b,type_b,name_sim,ctx_sim,same_source",
    [
        # Real MiniLM similarities from the offline replays.
        ("Set collection", "CONCEPT", "Route planning", "CONCEPT", 0.098, 0.979, True),            # demo-p2
        ("Negotiation", "CONCEPT", "Resource trading", "CONCEPT", 0.417, 0.982, False),            # demo-p2
        ("plugin ecosystem", "CONCEPT", "IDE integrations", "CONCEPT", 0.343, 0.927, True),        # demo-p2
        ("Kaunas City Hall", "ORG", "Kaunas City Museum", "ORG", 0.758, 0.935, True),             # demo-p3
        ("failed status surfacing", "CONCEPT", "compile_progress.status", "OTHER", 0.296, 0.905, True),  # d2427ec2
        ("Kei Ito", "PERSON", "Masataka Okabe", "PERSON", 0.413, 0.994, True),                    # e55c740b
        ("English", "OTHER", "programming language", "CONCEPT", 0.422, 0.921, True),              # demo-p1
    ],
)
def test_context_alone_never_merges(client, encoder, a, type_a, b, type_b, name_sim, ctx_sim, same_source):
    encoder(_pair(a, b, name_sim, ctx_sim, 0))
    data = _embedding(client, [_entity(a, type_a, "s1", "a"), _entity(b, type_b, "s1" if same_source else "s2", "b")])
    assert data["resolved"] == []
    assert _pairs(data) == [(a, "s1", b, round(ctx_sim, 4))]


def test_a_source_naming_both_keeps_them_apart(client, encoder):
    """Alike by name and context, but one source names both: Layer 3 decides."""
    encoder(_pair("Zurich Opera House", "Zürich Opera House", 0.95, 0.95, 0))
    same = _embedding(client, [_entity("Zurich Opera House", "ORG", "s1", "a"), _entity("Zürich Opera House", "ORG", "s1", "b")])
    assert same["resolved"] == []
    assert len(same["ambiguous"]) == 1

    apart = _embedding(client, [_entity("Zurich Opera House", "ORG", "s1", "a"), _entity("Zürich Opera House", "ORG", "s2", "b")])
    assert [(g["canonical"], g["aliases"], g["method"]) for g in apart["resolved"]] == [
        ("Zurich Opera House", ["Zürich Opera House"], "embedding"),
    ]
    assert apart["ambiguous"] == []


def test_city_hall_and_town_hall_are_asked_about_even_from_two_sources(client, encoder):
    """"City" / "Town" (synonyms) and "North" / "South" (opposites) have the
    same shape; only the cosine told them apart, so neither merges here
    (audit 2026-10-23; more in test_resolution_layer2_gate.py)."""
    encoder(_pair("Vilnius City Hall", "Vilnius Town Hall", 0.95, 0.95, 0))
    apart = _embedding(client, [_entity("Vilnius City Hall", "ORG", "s1", "a"), _entity("Vilnius Town Hall", "ORG", "s2", "b")])
    assert apart["resolved"] == []
    assert len(apart["ambiguous"]) == 1
    assert apart["rerouted"] == 1


def test_alike_names_reach_layer_3_whatever_the_context(client, encoder):
    encoder(_pair("Colour Contrast Analyser", "Color Contrast Checker", 0.82, 0.3, 0))
    data = _embedding(client, [_entity("Colour Contrast Analyser", "PRODUCT", "s1", "a"),
                               _entity("Color Contrast Checker", "PRODUCT", "s2", "b")])
    assert _pairs(data) == [("Colour Contrast Analyser", "s1", "Color Contrast Checker", 0.82)]
    assert data["unresolved"] == []


def test_people_who_share_only_a_surname_are_not_asked_about(client, encoder):
    encoder({**_pair("George Steiner", "Thomas Steiner", 0.846, 0.434, 0),
             **_pair("Kei Ito", "K. Ito", 0.85, 0.4, 4)})
    data = _embedding(client, [_entity("George Steiner", "PERSON", "s1", "a"), _entity("Thomas Steiner", "PERSON", "s2", "b"),
                               _entity("Kei Ito", "PERSON", "s3", "a"), _entity("K. Ito", "PERSON", "s4", "b")])
    assert _pairs(data) == [("Kei Ito", "s3", "K. Ito", 0.85)]
    assert {e["name"] for e in data["unresolved"]} == {"George Steiner", "Thomas Steiner"}


def test_anchoring_to_a_page_needs_the_name_to_match(client, encoder):
    """Kei Ito's context matched the Masataka Okabe page (0.95); the names
    do not (0.40). Asked about, not anchored."""
    page = [0.0] * DIM
    page[0] = 1.0
    name = [0.0] * DIM
    name[0], name[1] = 0.4, math.sqrt(1 - 0.16)
    ctx = [0.0] * DIM
    ctx[0], ctx[2] = 0.95, math.sqrt(1 - 0.9025)
    encoder({"Masataka Okabe": page, "Kei Ito": name, "Kei Ito: a": ctx})
    data = _embedding(client, [_entity("Kei Ito", "PERSON", "s1", "a")],
                      pages=[{"title": "Masataka Okabe", "page_type": "entity"}])
    assert data["resolved"] == []
    assert _pairs(data) == [("Kei Ito", "s1", "Masataka Okabe", 0.95)]
    assert data["ambiguous"][0]["entity_b"]["source_id"] == "__existing_page__"


# ---------------------------------------------------------------------------
# 1.3 — Layer 1 groups in, final groups out, `__group__:<k>` in pairs
# ---------------------------------------------------------------------------


def test_groups_reach_layer_2_and_come_back(client, encoder):
    groups = [
        _group("Contrast ratio", "CONCEPT", ["s1", "s2"], aliases=["contrast ratio"], context="a"),
        _group("APCA", "CONCEPT", ["s3"], method="existing_page_title", aliases=["APCA"], context="a"),
        _group("Bauhaus", "ORG", ["s4", "s5"], context="a"),
        _group("prefers-reduced-motion", "CONCEPT", ["s6", "s7"], context="a"),
    ]
    encoder({
        **_pair("Contrast ratio", "Colour contrast ratio", 0.903, 0.763, 0),
        **_pair("APCA", "APCA contrast algorithm", 0.526, 0.801, 4),
        **_pair("prefers-reduced-motion", "prefers-reduced-motion media feature", 0.785, 0.877, 8),
        "Bauhaus": _like(1.0, 12), "Bauhaus: a": _like(1.0, 14),
    })
    data = _embedding(
        client,
        [_entity("Colour contrast ratio", "CONCEPT", "s8", "b"),
         _entity("APCA contrast algorithm", "CONCEPT", "s9", "b"),
         _entity("prefers-reduced-motion media feature", "CONCEPT", "s10", "b")],
        groups=groups,
        pages=[{"title": "APCA", "page_type": "concept"}],
    )
    # Every group comes back, first and in order; nothing joined them.
    assert data["resolved"] == [{k: v for k, v in g.items() if k != "context"} for g in groups]
    # Group sides name resolved[k]; the APCA page is asked about through its
    # group only, first: "APCA" reads as an abbreviation of the other name.
    assert _pairs(data) == [
        ("APCA", "__group__:1", "APCA contrast algorithm", 0.801),
        ("Contrast ratio", "__group__:0", "Colour contrast ratio", 0.903),
        ("prefers-reduced-motion", "__group__:3", "prefers-reduced-motion media feature", 0.877),
    ]
    assert data["ambiguous"][1]["entity_a"]["context"] == "a"
    assert data["unresolved"] == []


def test_a_group_takes_in_a_name_from_another_source(client, encoder):
    vectors = _pair("Machine translation", "Machine translations", 0.95, 0.95, 0)
    vectors["Translation software"] = [0.93, 0, 0, 0, math.sqrt(1 - 0.93 ** 2)] + [0.0] * (DIM - 5)
    vectors["Translation software: b"] = [0, 0, 0.93, 0, 0, math.sqrt(1 - 0.93 ** 2)] + [0.0] * (DIM - 6)
    encoder(vectors)
    data = _embedding(
        client,
        [_entity("Machine translations", "CONCEPT", "s3", "b"), _entity("Translation software", "CONCEPT", "s1", "b")],
        groups=[_group("Machine translation", "CONCEPT", ["s1", "s2"], aliases=["machine translation"], context="a")],
    )
    assert data["resolved"] == [{
        "canonical": "Machine translation", "type": "CONCEPT",
        "aliases": ["machine translation", "Machine translations"],
        "source_ids": ["s1", "s2", "s3"], "method": "embedding",
    }]
    # "Translation software" shares source s1 with the group: Layer 3 decides.
    assert _pairs(data) == [("Machine translation", "__group__:0", "Translation software", 0.93)]


def test_a_group_layer_2_forms_is_named_in_pairs(client, encoder):
    vectors = _pair("Large language model", "Large-language model", 0.95, 0.95, 0)
    vectors["Language model"] = [0.8, 0, 0, 0, 0, 0.6] + [0.0] * (DIM - 6)        # 0.8 / 0.76 to the two
    vectors["Language model: b"] = [0, 0, 0.8, 0, 0, 0, 0.6] + [0.0] * (DIM - 7)
    encoder(vectors)
    data = _embedding(client, [_entity("Large language model", "CONCEPT", "s1", "a"),
                               _entity("Large-language model", "CONCEPT", "s2", "b"),
                               _entity("Language model", "CONCEPT", "s3", "b")])
    assert [g["source_ids"] for g in data["resolved"]] == [["s1", "s2"]]
    assert [(a, sid, b) for a, sid, b, _ in _pairs(data)] == [(data["resolved"][0]["canonical"], "__group__:0", "Language model")]


def test_anchored_groups_skip_pages_and_never_pair(client, encoder):
    same = _like(1.0, 0)
    encoder({t: same for t in ["Ethereum", "Ethereum Foundation", "Ethereum network", "Ethereum-network",
                               "Ethereum: a", "Ethereum Foundation: a", "Ethereum-network: b"]})
    groups = [
        _group("Ethereum", "ORG", ["s1"], method="existing_page_title", aliases=["Ethereum"], context="a"),
        _group("Ethereum Foundation", "ORG", ["s2"], method="existing_alias", aliases=["EF"], context="a"),
    ]
    data = _embedding(
        client, [_entity("Ethereum-network", "ORG", "s3", "b")], groups=groups,
        pages=[{"title": "Ethereum", "page_type": "entity"}, {"title": "Ethereum Foundation", "page_type": "entity"},
               {"title": "Ethereum network", "page_type": "entity"}],
    )
    assert data["resolved"][:2] == [{k: v for k, v in g.items() if k != "context"} for g in groups]
    # "Ethereum-network" binds to the one page no group holds, and is then bound too.
    assert data["resolved"][2:] == [{"canonical": "Ethereum network", "type": "ORG", "aliases": ["Ethereum-network"],
                                     "source_ids": ["s3"], "method": "existing_page_title"}]
    assert data["ambiguous"] == []
    assert data["unresolved"] == []


def test_group_input_contract(client, encoder):
    encoder({})
    ok = client.post("/resolve/embedding", json={
        "entities": [], "groups": [{"canonical": "X", "type": "ORG", "aliases": [], "source_ids": ["s1"], "method": "exact"}],
    })
    assert ok.status_code == 200
    assert ok.json()["resolved"] == [{"canonical": "X", "type": "ORG", "aliases": [], "source_ids": ["s1"], "method": "exact"}]
    bad = client.post("/resolve/embedding", json={
        "entities": [], "groups": [{"canonical": "X", "type": "ORG", "aliases": [], "source_ids": ["s1"],
                                    "method": "exact", "context": "", "bogus": 1}],
    })
    assert bad.status_code == 422


def test_pairs_are_ranked_by_tier_then_name_then_similarity(client, encoder):
    """Layer 3 answers a capped number of pairs, so the order decides who is
    asked. Pairs across sources or against a page come before pairs one
    source names both sides of, and a pair alike only in context goes last
    however high its similarity (more in test_resolution_layer3.py)."""
    encoder({
        **_pair("Set collection", "Route planning", 0.1, 0.98, 0),       # context only, one source
        **_pair("Colour analyser", "Color analyzer", 0.85, 0.6, 4),      # alike names, two sources
        **_pair("Dutch auction", "Reverse auction", 0.85, 0.95, 8),      # alike names, one source
        **_pair("Web typography", "Typography on the web", 0.9, 0.75, 12),
        "Echo": _like(1.0, 16), "Echo: a": _like(1.0, 16), "Echo Corp": _like(0.8, 16),
    })
    data = _embedding(
        client,
        [_entity("Set collection", "CONCEPT", "s1", "a"), _entity("Route planning", "CONCEPT", "s1", "b"),
         _entity("Colour analyser", "CONCEPT", "s2", "a"), _entity("Color analyzer", "CONCEPT", "s3", "b"),
         _entity("Dutch auction", "CONCEPT", "s4", "a"), _entity("Reverse auction", "CONCEPT", "s4", "b"),
         _entity("Web typography", "CONCEPT", "s5", "a"), _entity("Typography on the web", "CONCEPT", "s6", "b"),
         _entity("Echo", "ORG", "s7", "a")],
        pages=[{"title": "Echo Corp", "page_type": "entity"}],
    )
    assert [(p["entity_a"]["name"], p["name_similarity"], p["similarity"]) for p in data["ambiguous"]] == [
        ("Web typography", 0.9, 0.9),
        ("Colour analyser", 0.85, 0.85),
        ("Echo", 0.8, 0.8),
        ("Dutch auction", 0.85, 0.95),
        ("Set collection", 0.1, 0.98),
    ]


def test_layer_3_accepts_pairs_without_name_similarity(client, monkeypatch):
    from services import llm_client as llm_client_mod  # noqa: PLC0415

    def fail(*_args, **_kwargs):
        raise AssertionError("LLM must not be called for version pairs")

    monkeypatch.setattr(llm_client_mod, "disambiguate_entities", fail)
    pair = {"entity_a": _entity("Python 3", "PRODUCT", "s1"), "entity_b": _entity("Python 2", "PRODUCT", "s2"),
            "similarity": 0.85}
    for body in ({"pairs": [pair]}, {"pairs": [{**pair, "name_similarity": 0.8}]}):
        resp = client.post("/resolve/disambiguate", json=body)
        assert resp.status_code == 200
        assert resp.json()["results"][0]["decision"] == "different"


# ---------------------------------------------------------------------------
# 1.4 — a concept against a named thing: compared by name, never merged here
# ---------------------------------------------------------------------------


def test_concept_and_named_thing_go_to_layer_3_by_name(client, encoder):
    encoder({
        **_pair("UNESCO World Heritage", "UNESCO World Heritage list", 0.923, 0.933, 0),
        "Polish School of Posters": _like(1.0, 4), "Polish School of Posters: a": _like(1.0, 6),
        "Polish School of Posters: b": _like(1.0, 6),
        **_pair("Francis Wolff", "Candid photography", 0.176, 0.857, 8),
    })
    data = _embedding(client, [
        _entity("UNESCO World Heritage", "CONCEPT", "s1", "a"), _entity("UNESCO World Heritage list", "ORG", "s2", "b"),
        _entity("Polish School of Posters", "CONCEPT", "s3", "a"), _entity("Polish School of Posters", "ORG", "s4", "b"),
        _entity("Francis Wolff", "PERSON", "s5", "a"), _entity("Candid photography", "CONCEPT", "s5", "b"),
    ])
    assert data["resolved"] == []
    assert _pairs(data) == [
        ("Polish School of Posters", "s3", "Polish School of Posters", 1.0),
        ("UNESCO World Heritage", "s1", "UNESCO World Heritage list", 0.923),
    ]
    assert {e["name"] for e in data["unresolved"]} == {"Francis Wolff", "Candid photography"}


def test_page_of_the_other_kind_is_asked_about_not_anchored(client, encoder):
    unesco_page = [0.0] * DIM
    unesco_page[0] = 1.0
    photo_page = [0.0] * DIM
    photo_page[5] = 1.0

    def toward(page_axis: int, sim: float, spare: int) -> list[float]:
        v = [0.0] * DIM
        v[page_axis], v[spare] = sim, math.sqrt(1 - sim * sim)
        return v

    encoder({
        "UNESCO World Heritage": unesco_page, "Candid photography": photo_page,
        "UNESCO World Heritage list": toward(0, 0.923, 1), "UNESCO World Heritage list: b": toward(0, 0.933, 2),
        "Francis Wolff": toward(5, 0.2, 6), "Francis Wolff: a": toward(5, 0.857, 7),
    })
    data = _embedding(
        client,
        [_entity("UNESCO World Heritage list", "ORG", "s1", "b"), _entity("Francis Wolff", "PERSON", "s2", "a")],
        pages=[{"title": "UNESCO World Heritage", "page_type": "concept"},
               {"title": "Candid photography", "page_type": "concept"}],
    )
    assert data["resolved"] == []
    assert _pairs(data) == [("UNESCO World Heritage list", "s1", "UNESCO World Heritage", 0.923)]
    assert data["ambiguous"][0]["entity_b"] == {"name": "UNESCO World Heritage", "type": "CONCEPT",
                                                "source_id": "__existing_page__", "context": ""}
    assert [e["name"] for e in data["unresolved"]] == ["Francis Wolff"]
