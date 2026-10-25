"""Layer 1 merges only what spelling alone can be sure of.

Audit 2026-10-23 ran the real resolve_fuzzy and found merges that became
permanent aliases:
- "Continuous Integration (CI)" matched "Confidence Interval": the bracket
  rule accepted any expansion of the abbreviation.
- A short name chained different things: [Product Manager, PM, Project
  Manager], [Paul Graham, Paul, Paul Allen]; and through an anchored page,
  "Paul Allen" joined the page "Paul".
- People merged by plural and by a one-letter edit ("John Edward" / "John
  Edwards", "Louis Martin" / "Louise Martin"); long single words one letter
  apart merged ("Wikipedia" / "Wikimedia").
- Bare initials merged whatever the case ("it" / "Information Technology").
Owner decision (2026-10-23): no automatic acronym merges; an acronym and
its expansion, and single words one letter apart, are asked of Layer 3
instead (test_resolution_layer2_gate.py).
"""

from __future__ import annotations

import random
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.resolution import (
    EntityInput,
    _cross_session_method,
    _fuzzy_method,
    _GuardedUnion,
    _layer3_only_method,
    _parenthetical_match,
)


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


def _groups(data: dict[str, Any]) -> list[set[str]]:
    return [{g["canonical"], *g["aliases"]} for g in data["resolved"]]


# ---------------------------------------------------------------------------
# "Full Name (ABBR)" matches only its own full name
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("a,b", [
    ("Continuous Integration (CI)", "Confidence Interval"),
    ("Machine Learning (ML)", "Maximum Likelihood"),
    ("Machine Learning (ML)", "Markup Language"),
])
def test_a_bracketed_abbreviation_matches_no_other_expansion(a, b):
    assert _parenthetical_match(a, b) is None
    assert _fuzzy_method(a, b) is None
    assert _cross_session_method(b, a) is None


@pytest.mark.parametrize("other,expected", [
    ("Continuous Integration", "expansion"),
    ("continuous-integration", "expansion"),
    ("Continuous Integrations", "expansion"),
    ("CI", "abbreviation"),
    ("ci", None),           # an abbreviation is written in capitals
])
def test_a_bracketed_abbreviation_still_matches_its_own_names(other, expected):
    assert _parenthetical_match("Continuous Integration (CI)", other) == expected


def test_a_bracketed_page_binds_no_other_expansion(client):
    data = _fuzzy(client, [_entity("Confidence Interval")],
                  page_titles=[{"title": "Continuous Integration (CI)", "page_type": "concept"}])
    assert data["resolved"] == []


# ---------------------------------------------------------------------------
# Acronyms: never merged here, capitals required to be asked about at all
# ---------------------------------------------------------------------------


def test_an_acronym_and_its_expansion_never_merge_in_layer_1(client):
    data = _fuzzy(client, [
        _entity("ML", "CONCEPT", "s1"), _entity("Machine Learning", "CONCEPT", "s2"),
        _entity("API", "CONCEPT", "s3"), _entity("Application Programming Interface", "CONCEPT", "s4"),
        _entity("WCAG", "ORG", "s5"),
    ], page_titles=[{"title": "Web Content Accessibility Guidelines", "page_type": "concept"}])
    assert data["resolved"] == []
    assert len(data["unresolved"]) == 5


@pytest.mark.parametrize("a,b,expected", [
    ("ML", "Machine Learning", "acronym"),
    ("Machine Learning", "ML", "acronym"),
    ("IT", "Information Technology", "acronym"),
    ("it", "Information Technology", None),
    ("art", "Adaptive Resonance Theory", None),
    ("Go", "Google Optimize", None),
    ("WCAG", "Web Content Accessibility Guidelines (WCAG)", None),   # Layer 1's bracket rule
    ("ML", "Machine Learning 2", None),                               # numbers differ
])
def test_an_acronym_is_asked_about_only_in_capitals(a, b, expected):
    assert _layer3_only_method(a, b) == expected


# ---------------------------------------------------------------------------
# A short name between two names that differ joins neither
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("names,type_", [
    (["Product Manager", "PM", "Project Manager"], "CONCEPT"),
    (["Continuous Integration", "CI", "Confidence Interval"], "CONCEPT"),
    (["Paul Graham", "Paul", "Paul Allen"], "PERSON"),
    (["Paul Graham", "Graham", "Graham Allison"], "PERSON"),
    (["Steiner", "George Steiner", "Thomas Steiner"], "PERSON"),
])
def test_a_hub_name_chains_nothing_whatever_the_order(client, names, type_):
    entities = [_entity(n, type_, f"s{k}") for k, n in enumerate(names)]
    first = _fuzzy(client, entities)
    assert first["resolved"] == []
    rng = random.Random(4)
    for _ in range(3):
        rng.shuffle(entities)
        assert _fuzzy(client, entities) == first


def test_a_surname_between_two_people_stays_alone_and_the_rest_still_merge(client):
    data = _fuzzy(client, [_entity("Karpathy", "PERSON", "s1"), _entity("A. Karpathy", "PERSON", "s2"),
                           _entity("Andrej Karpathy", "PERSON", "s3"), _entity("Bob Karpathy", "PERSON", "s4")])
    assert _groups(data) == [{"A. Karpathy", "Andrej Karpathy"}]
    assert sorted(e["name"] for e in data["unresolved"]) == ["Bob Karpathy", "Karpathy"]


def test_a_surname_with_one_full_name_still_merges(client):
    data = _fuzzy(client, [_entity("Karpathy", "PERSON", "s1"), _entity("Andrej Karpathy", "PERSON", "s2")])
    assert [(g["canonical"], g["aliases"]) for g in data["resolved"]] == [("Andrej Karpathy", ["Karpathy"])]


def test_the_union_refuses_two_names_that_do_not_match_each_other():
    people = [EntityInput(name=n, type="PERSON", source_id=f"s{k}") for k, n in enumerate(["Paul", "Paul Graham", "Paul Allen"])]
    guard = _GuardedUnion(people)
    assert guard.try_union(0, 1, "person_subset")
    assert not guard.try_union(0, 2, "person_subset")


# ---------------------------------------------------------------------------
# A name joining an anchored group must match the anchored page itself
# ---------------------------------------------------------------------------


def test_a_name_joins_a_page_only_if_it_matches_the_page(client):
    data = _fuzzy(client, [_entity("Paul", "PERSON", "s1"), _entity("Paul Allen", "PERSON", "s2")],
                  page_titles=[{"title": "Paul", "page_type": "entity"}])
    assert [(g["canonical"], g["aliases"], g["method"]) for g in data["resolved"]] == [("Paul", [], "existing_page_title")]
    assert [e["name"] for e in data["unresolved"]] == ["Paul Allen"]


def test_a_spelling_of_a_stored_alias_still_joins_its_page(client):
    data = _fuzzy(client, [_entity("ML", "CONCEPT", "s1"), _entity("MLs", "CONCEPT", "s2")],
                  aliases=[{"alias": "ML", "canonical": "Machine Learning"}])
    assert [(g["canonical"], sorted(g["aliases"])) for g in data["resolved"]] == [("Machine Learning", ["ML", "MLs"])]


# ---------------------------------------------------------------------------
# People: no plurals, no edits inside a name; single words one letter apart
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("a,b", [
    ("John Edward", "John Edwards"),
    ("Louis Martin", "Louise Martin"),
    ("Maria Garcia", "Mario Garcia"),
    ("William", "Williams"),
    ("Peter", "Peters"),
])
def test_people_merge_by_no_plural_and_no_edit(client, a, b):
    data = _fuzzy(client, [_entity(a, "PERSON", "s1"), _entity(b, "PERSON", "s2")])
    assert data["resolved"] == []
    page = _fuzzy(client, [_entity(a, "PERSON", "s1")], page_titles=[{"title": b, "page_type": "entity"}])
    assert page["resolved"] == []


@pytest.mark.parametrize("a,b,type_", [
    ("Wikipedia", "Wikimedia", "ORG"),
    ("Kubernetes", "Kubernetis", "PRODUCT"),
    ("Columbia", "Colombia", "LOCATION"),
])
def test_single_words_one_letter_apart_are_left_to_layer_3(client, a, b, type_):
    data = _fuzzy(client, [_entity(a, type_, "s1"), _entity(b, type_, "s2")])
    assert data["resolved"] == []
    page = _fuzzy(client, [_entity(b, type_, "s1")], page_titles=[{"title": a, "page_type": "entity"}])
    assert page["resolved"] == []
    assert _layer3_only_method(a, b) == "slip"
    assert _layer3_only_method(a, b, person=True) is None


def test_spellings_of_one_name_still_merge(client):
    data = _fuzzy(client, [
        _entity("CSS media query", "CONCEPT", "s1"), _entity("CSS media queries", "CONCEPT", "s2"),
        _entity("Colour contrast ratio", "CONCEPT", "s3"), _entity("Color contrast ratio", "CONCEPT", "s4"),
        _entity("Jean-Luc Picard", "PERSON", "s5"), _entity("Jean Luc Picard", "PERSON", "s6"),
    ])
    assert sorted(sorted(g) for g in _groups(data)) == [
        ["CSS media queries", "CSS media query"],
        ["Color contrast ratio", "Colour contrast ratio"],
        ["Jean Luc Picard", "Jean-Luc Picard"],
    ]


# ---------------------------------------------------------------------------
# Group kind by majority
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("kinds,expected", [
    (["OTHER", "CONCEPT", "CONCEPT"], "CONCEPT"),
    (["OTHER", "OTHER", "CONCEPT"], "OTHER"),
    (["OTHER", "CONCEPT"], "CONCEPT"),        # a tie: alphabetical
])
def test_a_group_takes_the_kind_most_of_its_names_have(client, kinds, expected):
    spellings = ["Bitcoin", "bitcoin", "BITCOIN"]
    data = _fuzzy(client, [_entity(spellings[k], kind, f"s{k}") for k, kind in enumerate(kinds)])
    assert [g["type"] for g in data["resolved"]] == [expected]
