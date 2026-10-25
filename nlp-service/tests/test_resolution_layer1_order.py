"""Layer 1 gives the same result whatever order its input arrives in.

The route reads extractions in the order they finished (created_at has
one-second resolution, four extract at once) and page titles with no ORDER
BY, so a recompile could group a name differently: "Steiner" joined George
Steiner or Thomas Steiner by input order, and "CI" bound whichever of two
matching pages came first (audit 2026-10-23). Also: a name bound alone to
the page it equals gave a self-alias row ("APCA" → "APCA"), and "OpenAI "
with a trailing space or a decomposed "Zürich" missed the exact page title.
"""

from __future__ import annotations

import json
import random
import unicodedata
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client():
    from routers.resolution import router  # noqa: PLC0415
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _entity(name: str, type_: str = "CONCEPT", source: str = "s1") -> dict[str, Any]:
    return {"name": name, "type": type_, "source_id": source, "context": ""}


def _fuzzy(client, entities, page_titles=None, aliases=None) -> dict[str, Any]:
    resp = client.post(
        "/resolve/fuzzy",
        json={"entities": entities, "existing_aliases": aliases or [], "existing_page_titles": page_titles or []},
    )
    assert resp.status_code == 200
    return resp.json()


def test_a_short_name_joins_the_same_person_whatever_the_order(client):
    people = [_entity("Steiner", "PERSON", "s1"), _entity("George Steiner", "PERSON", "s2"),
              _entity("Thomas Steiner", "PERSON", "s3")]
    first = _fuzzy(client, people)
    second = _fuzzy(client, [people[0], people[2], people[1]])
    assert first == second


def test_an_acronym_binds_the_same_page_whatever_the_page_order(client):
    pages = [{"title": "Continuous Integration", "page_type": "concept"},
             {"title": "Confidence Interval", "page_type": "concept"}]
    first = _fuzzy(client, [_entity("CI")], pages)
    second = _fuzzy(client, [_entity("CI")], pages[::-1])
    assert first == second
    assert first["resolved"][0]["method"] == "existing_page_title"


def test_a_group_takes_the_same_type_whatever_the_order(client):
    names = [_entity("Bitcoin", "OTHER", "s1"), _entity("bitcoin", "CONCEPT", "s2"),
             _entity("BITCOIN", "CONCEPT", "s3")]
    results = {json.dumps(_fuzzy(client, order), sort_keys=True)
               for order in (names, names[::-1], [names[1], names[0], names[2]])}
    assert len(results) == 1


@pytest.mark.parametrize("seed", [3, 5])
def test_shuffled_input_gives_the_same_output(client, seed: int):
    rng = random.Random(seed)
    words = "graph model data network search engine colour color ratio contrast system".split()
    names = [" ".join(rng.choice(words).capitalize() for _ in range(rng.randint(1, 3))) for _ in range(40)]
    names += [n.lower() for n in names[:10]] + [n + "s" for n in names[10:20]]
    names += ["".join(w[0] for w in n.split()).upper() for n in names[20:30]]
    entities = [_entity(n, rng.choice(["CONCEPT", "OTHER", "ORG", "PRODUCT"]), f"s{rng.randint(1, 5)}")
                for n in names]
    pages = [{"title": rng.choice(names), "page_type": rng.choice(["entity", "concept"])} for _ in range(15)]
    expected = _fuzzy(client, entities, pages)
    for _ in range(3):
        rng.shuffle(entities)
        rng.shuffle(pages)
        assert _fuzzy(client, entities, pages) == expected


def test_a_name_bound_to_the_page_it_equals_is_not_its_own_alias(client):
    data = _fuzzy(client, [_entity("APCA")], [{"title": "APCA", "page_type": "concept"}])
    assert data["resolved"] == [{"canonical": "APCA", "type": "CONCEPT", "aliases": [], "source_ids": ["s1"],
                                 "method": "existing_page_title"}]


def test_a_case_variant_bound_to_its_page_stays_an_alias(client):
    data = _fuzzy(client, [_entity("apca")], [{"title": "APCA", "page_type": "concept"}])
    assert data["resolved"][0]["aliases"] == ["apca"]


@pytest.mark.parametrize("name", ["OpenAI ", " OpenAI", unicodedata.normalize("NFD", "Zürich AG")])
def test_exact_title_ignores_surrounding_spaces_and_unicode_composition(client, name: str):
    title = name.strip() if "OpenAI" in name else "Zürich AG"
    # A CONCEPT name and an entity page: only the exact-title binding crosses kinds.
    data = _fuzzy(client, [_entity(name, "CONCEPT")], [{"title": title, "page_type": "entity"}])
    assert data["unresolved"] == []
    assert data["resolved"][0]["canonical"] == title
    assert data["resolved"][0]["method"] == "existing_page_title"
