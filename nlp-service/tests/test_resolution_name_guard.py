"""Entity resolution must not merge different things.

The 2026-10-09 e2e wiki stored aliases "Python 3" → "Python 2",
"Python" → "Python 2", "Ethereum" → "Ethereum Foundation" and
"Bitcoin" → "Bitcoin network": Levenshtein ≤ 2 merged versions, the
substring rule merged a name with its parent, union-find chained them, and
the longest name won. These tests pin the name guard and the merges that
must keep working.
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

CASES = json.loads((Path(__file__).parent / "fixtures" / "name_guard_cases.json").read_text(encoding="utf-8"))


class _FakeEncoder:
    """Maps known names to fixed vectors so cosine similarity is predictable."""

    def __init__(self, mapping: dict[str, list[float]]):
        self.mapping = mapping

    def encode(self, texts, convert_to_numpy=True, normalize_embeddings=False):  # noqa: ARG002
        return np.array([self.mapping.get(t.split(":", 1)[0].strip(), [0.0] * 8) for t in texts], dtype=np.float32)


@pytest.fixture(scope="module")
def client():
    from routers.resolution import router  # noqa: PLC0415
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _entity(name: str, type_: str = "PRODUCT", source: str = "s1") -> dict[str, Any]:
    return {"name": name, "type": type_, "source_id": source, "context": ""}


def _fuzzy(client, entities, page_titles=None, aliases=None) -> dict[str, Any]:
    resp = client.post(
        "/resolve/fuzzy",
        json={"entities": entities, "existing_aliases": aliases or [], "existing_page_titles": page_titles or []},
    )
    assert resp.status_code == 200
    return resp.json()


def _groups(data: dict[str, Any]) -> list[set[str]]:
    return [{g["canonical"], *g["aliases"]} for g in data["resolved"]]


# ---------------------------------------------------------------------------
# Name guard vectors (shared with app/src/lib/name-guard.ts)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("case", CASES, ids=lambda c: f"{c['a']}|{c['b']}")
def test_name_guard_vectors(case):
    from routers.resolution import _is_token_extension, _numeric_conflict  # noqa: PLC0415
    assert _numeric_conflict(case["a"], case["b"]) == case["conflict"]
    assert _numeric_conflict(case["b"], case["a"]) == case["conflict"]
    assert _is_token_extension(case["a"], case["b"]) == case["extension"]


# ---------------------------------------------------------------------------
# Layer 1 — same session
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "a,b",
    [
        ("Python 2", "Python 3"),
        ("Python", "Python 2"),
        ("Stage 16", "Stage 17"),
        ("GPT-4", "GPT-5"),
        ("GPT-4", "GPT-4o"),
        ("Windows 10", "Windows 11"),
        ("iPhone 15", "iPhone 16"),
        ("Python 3.11", "Python 3.12"),
    ],
)
def test_versions_never_merge(client, a, b):
    data = _fuzzy(client, [_entity(a, source="s1"), _entity(b, source="s2")])
    assert data["resolved"] == []
    assert len(data["unresolved"]) == 2


def test_no_chain_across_versions(client):
    data = _fuzzy(
        client,
        [_entity("Python", source="s1"), _entity("Python 2", source="s2"), _entity("Python 3", source="s3"),
         _entity("Python3", source="s4")],
    )
    for group in _groups(data):
        numbers = {"2" if "2" in n else "3" if "3" in n else "" for n in group}
        assert len(numbers) == 1, group
    # "Python 3" and "Python3" are the same version and still merge.
    assert {"Python 3", "Python3"} in _groups(data)


@pytest.mark.parametrize(
    "a,b,type_",
    [
        ("Ethereum", "Ethereum Foundation", "ORG"),
        ("Bitcoin", "Bitcoin network", "PRODUCT"),
        ("LLM", "LLM draft path", "CONCEPT"),
        ("min_source_chars", "min_source_chars threshold", "CONCEPT"),
        ("Bitcoin", "Bitcoin Cash", "PRODUCT"),
    ],
)
def test_parent_and_part_are_left_to_later_layers(client, a, b, type_):
    data = _fuzzy(client, [_entity(a, type_, "s1"), _entity(b, type_, "s2")])
    assert data["resolved"] == []
    assert len(data["unresolved"]) == 2


def test_eth_does_not_chain_into_the_foundation(client):
    data = _fuzzy(
        client,
        [_entity("ETH", "ORG", "s1"), _entity("Ethereum", "ORG", "s2"), _entity("Ethereum Foundation", "ORG", "s3")],
    )
    assert data["resolved"] == []


def test_same_name_variants_still_merge(client):
    data = _fuzzy(client, [_entity("GPT 4", source="s1"), _entity("GPT-4", source="s2"),
                           _entity("SHA256", "CONCEPT", "s3"), _entity("SHA-256", "CONCEPT", "s4")])
    assert {"GPT 4", "GPT-4"} in _groups(data)
    assert {"SHA256", "SHA-256"} in _groups(data)


def test_case_variants_take_the_capitalised_name(client):
    data = _fuzzy(
        client,
        [_entity("decentralized applications", "CONCEPT", "s1"), _entity("Decentralized applications", "CONCEPT", "s2")],
    )
    assert data["resolved"][0]["canonical"] == "Decentralized applications"


def test_people_merge_by_surname_and_initials(client):
    data = _fuzzy(
        client,
        [
            _entity("Karpathy", "PERSON", "s1"),
            _entity("A. Karpathy", "PERSON", "s2"),
            _entity("Andrej Karpathy", "PERSON", "s3"),
            _entity("Bob Karpathy", "PERSON", "s4"),
            _entity("Satoshi", "PERSON", "s5"),
            _entity("Satoshi Nakamoto", "PERSON", "s6"),
            _entity("Buterin", "PERSON", "s7"),
            _entity("Vitalik Buterin", "PERSON", "s8"),
        ],
    )
    by_canonical = {g["canonical"]: g for g in data["resolved"]}
    assert set(by_canonical["Andrej Karpathy"]["aliases"]) == {"Karpathy", "A. Karpathy"}
    assert all("Bob Karpathy" not in ({g["canonical"], *g["aliases"]}) for g in data["resolved"])
    assert by_canonical["Satoshi Nakamoto"]["aliases"] == ["Satoshi"]
    assert by_canonical["Vitalik Buterin"]["aliases"] == ["Buterin"]
    assert by_canonical["Satoshi Nakamoto"]["method"] == "person_subset"


def test_non_people_do_not_merge_by_surname_rule(client):
    data = _fuzzy(client, [_entity("Karpathy", "ORG", "s1"), _entity("Andrej Karpathy", "ORG", "s2")])
    assert data["resolved"] == []


def test_canonical_is_the_name_most_sources_use(client):
    data = _fuzzy(
        client,
        [_entity("Bitcoin", source="s1"), _entity("Bitcoin", source="s2"), _entity("Bitcoin", source="s3"),
         _entity("Bitcoins", source="s4")],
    )
    assert data["resolved"][0]["canonical"] == "Bitcoin"


def test_method_is_reported_per_group(client):
    data = _fuzzy(
        client,
        [_entity("GPT-4", source="s1"), _entity("gpt-4", source="s2"), _entity("Claude", source="s3")],
        page_titles=[{"title": "Claude", "page_type": "entity"}],
    )
    methods = {g["canonical"]: g["method"] for g in data["resolved"]}
    assert methods["Claude"] == "existing_page_title"
    assert methods["GPT-4"] == "exact"


# ---------------------------------------------------------------------------
# Layer 1 — cross-session anchoring
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name,title",
    [("London", "London Eye"), ("Apple", "Apple TV"), ("OpenAI", "OpenAI API"), ("Python 3", "Python 2")],
)
def test_no_anchor_to_a_different_page(client, name, title):
    data = _fuzzy(client, [_entity(name)], page_titles=[{"title": title, "page_type": "entity"}])
    assert data["resolved"] == []
    assert len(data["unresolved"]) == 1


def test_versions_anchored_to_their_own_pages_stay_apart(client):
    data = _fuzzy(
        client,
        [_entity("GPT 4", source="s1"), _entity("GPT 4o", source="s2")],
        page_titles=[{"title": "GPT-4", "page_type": "entity"}, {"title": "GPT-4o", "page_type": "entity"}],
    )
    assert sorted(g["canonical"] for g in data["resolved"]) == ["GPT-4", "GPT-4o"]


def test_stored_aliases_still_resolve(client):
    data = _fuzzy(
        client,
        [_entity("proof-of-work", "CONCEPT")],
        aliases=[{"alias": "proof-of-work", "canonical": "proof-of-work consensus"}],
    )
    assert data["resolved"][0]["canonical"] == "proof-of-work consensus"


# ---------------------------------------------------------------------------
# Layer 2 — embedding
# ---------------------------------------------------------------------------


def _unit(sim: float) -> list[float]:
    """A vector whose cosine with [1, 0, …] is `sim`."""
    return [sim, math.sqrt(max(0.0, 1 - sim * sim)), 0, 0, 0, 0, 0, 0]


@pytest.fixture
def encoder(monkeypatch):
    from routers import resolution  # noqa: PLC0415

    def install(mapping: dict[str, list[float]]):
        monkeypatch.setattr(resolution, "_get_embed_model", lambda: _FakeEncoder(mapping))

    return install


def _embedding(client, entities, page_titles=None) -> dict[str, Any]:
    resp = client.post("/resolve/embedding", json={"entities": entities, "existing_page_titles": page_titles or []})
    assert resp.status_code == 200
    return resp.json()


def test_embedding_never_merges_versions(client, encoder):
    encoder({"GPT-4": _unit(1.0), "GPT-4o": _unit(0.95)})
    data = _embedding(client, [_entity("GPT-4", source="s1"), _entity("GPT-4o", source="s2")])
    assert data["resolved"] == []
    assert data["ambiguous"] == []
    assert len(data["unresolved"]) == 2


@pytest.mark.parametrize("a,b", [("Python", "Python 2"), ("GPT-4", "GPT-4 Turbo")])
def test_embedding_sends_guarded_pairs_to_layer_3(client, encoder, a, b):
    encoder({a: _unit(1.0), b: _unit(0.95)})
    data = _embedding(client, [_entity(a, source="s1"), _entity(b, source="s2")])
    assert data["resolved"] == []
    assert len(data["ambiguous"]) == 1


def test_embedding_still_merges_close_unguarded_names(client, encoder):
    encoder({"Large Language Model": _unit(1.0), "Large Language Models": _unit(0.95)})
    data = _embedding(
        client, [_entity("Large Language Model", "CONCEPT", "s1"), _entity("Large Language Models", "CONCEPT", "s2")]
    )
    assert len(data["resolved"]) == 1
    assert data["resolved"][0]["method"] == "embedding"


def test_embedding_never_anchors_to_another_version(client, encoder):
    encoder({"Python 3": _unit(1.0), "Python 2": _unit(0.95)})
    data = _embedding(client, [_entity("Python 3")], page_titles=[{"title": "Python 2", "page_type": "entity"}])
    assert data["resolved"] == []
    assert data["ambiguous"] == []
    assert data["unresolved"][0]["name"] == "Python 3"


def test_embedding_sends_parent_page_to_layer_3(client, encoder):
    encoder({"Ethereum": _unit(1.0), "Ethereum Foundation": _unit(0.95)})
    data = _embedding(client, [_entity("Ethereum", "ORG")], page_titles=[{"title": "Ethereum Foundation", "page_type": "entity"}])
    assert data["resolved"] == []
    assert data["ambiguous"][0]["entity_b"]["name"] == "Ethereum Foundation"


# ---------------------------------------------------------------------------
# Layer 3 — disambiguation
# ---------------------------------------------------------------------------


def test_version_pairs_are_different_without_an_llm_call(client, monkeypatch):
    from services import llm_client as llm_client_mod  # noqa: PLC0415

    def fail(*_args, **_kwargs):
        raise AssertionError("LLM must not be called for version pairs")

    monkeypatch.setattr(llm_client_mod, "disambiguate_entities", fail)
    resp = client.post(
        "/resolve/disambiguate",
        json={"pairs": [{"entity_a": _entity("Python 3"), "entity_b": _entity("Python 2"), "similarity": 0.85}]},
    )
    assert resp.status_code == 200
    result = resp.json()["results"][0]
    assert result["decision"] == "different"
    assert result["reason"].startswith("numeric_conflict")
