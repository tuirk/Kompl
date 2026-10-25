"""Layer 1 merges spellings of one name, not names that are spelt alike.

Levenshtein ≤ 2 and Jaro-Winkler ≥ 0.92 over whole names merged "NVDA" /
"NAVA", "WebKit" / "WebAIM", "vestibular motion triggers" / "vestibular
motion disorders" and "anti-aliasing and font weight" / "Antialiasing and
font smoothing" (2026-10-17, offline replay of session 61c8bb37). These
tests pin the stricter rules: skeleton, simple plural, one slip in a long
word, near-spellings that keep the head word, and the acronym rule.
"""

from __future__ import annotations

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


def _fuzzy(client, entities, page_titles=None) -> dict[str, Any]:
    resp = client.post(
        "/resolve/fuzzy",
        json={"entities": entities, "existing_aliases": [], "existing_page_titles": page_titles or []},
    )
    assert resp.status_code == 200
    return resp.json()


@pytest.mark.parametrize(
    "a,b,type_",
    [
        ("NVDA", "NAVA", "ORG"),                                     # Levenshtein 2
        ("WebKit", "WebAIM", "ORG"),                                 # Levenshtein 2
        ("Chrome", "Chroma", "PRODUCT"),                             # Levenshtein 1, six letters
        ("Ethereum", "Ethereal", "PRODUCT"),                         # Levenshtein 2, eight letters
        ("vestibular motion triggers", "vestibular motion disorders", "CONCEPT"),
        ("anti-aliasing and font weight", "Antialiasing and font smoothing", "CONCEPT"),
        ("WCAG contrast algorithm", "WCAG contrast ratio", "CONCEPT"),
        ("Colour contrast ratio", "Color contrast", "CONCEPT"),
        ("North America", "South America", "LOCATION"),              # same head, Levenshtein 2
    ],
)
def test_names_spelt_alike_are_left_to_layer_2(client, a, b, type_):
    data = _fuzzy(client, [_entity(a, type_, "s1"), _entity(b, type_, "s2")])
    assert data["resolved"] == []
    assert {e["name"] for e in data["unresolved"]} == {a, b}


def test_spellings_of_one_name_still_merge(client):
    data = _fuzzy(
        client,
        [
            _entity("GPT-4", "PRODUCT", "s1"), _entity("GPT 4", "PRODUCT", "s2"), _entity("gpt4", "PRODUCT", "s3"),
            _entity("LLM", "CONCEPT", "s4"), _entity("LLMs", "CONCEPT", "s5"),
            _entity("AI", "CONCEPT", "s6"), _entity("AIs", "CONCEPT", "s7"),
            _entity("CSS media query", "CONCEPT", "s8"), _entity("CSS media queries", "CONCEPT", "s9"),
            _entity("Colour contrast ratio", "CONCEPT", "s10"), _entity("Color contrast ratio", "CONCEPT", "s11"),
            _entity("WCAG 2", "OTHER", "s12"), _entity("WCAG 2.0", "OTHER", "s13"),
            _entity("Kubernetes", "PRODUCT", "s14"), _entity("Kubernetis", "PRODUCT", "s15"),
            _entity("API", "CONCEPT", "s16"), _entity("Application Programming Interface", "CONCEPT", "s17"),
        ],
    )
    methods = {frozenset([g["canonical"], *g["aliases"]]): g["method"] for g in data["resolved"]}
    assert methods == {
        frozenset({"GPT-4", "GPT 4", "gpt4"}): "skeleton",
        frozenset({"LLM", "LLMs"}): "plural",
        frozenset({"AI", "AIs"}): "plural",
        frozenset({"CSS media query", "CSS media queries"}): "plural",
        frozenset({"Colour contrast ratio", "Color contrast ratio"}): "levenshtein",
        frozenset({"WCAG 2", "WCAG 2.0"}): "levenshtein",
        frozenset({"Kubernetes", "Kubernetis"}): "levenshtein",
        frozenset({"API", "Application Programming Interface"}): "acronym",
    }
    assert data["unresolved"] == []


def test_skeleton_keeps_symbols_that_name_a_language(client):
    data = _fuzzy(client, [_entity("C", "PRODUCT", "s1"), _entity("C++", "PRODUCT", "s2"), _entity("C#", "PRODUCT", "s3"),
                           _entity("C ++", "PRODUCT", "s4")])
    assert [(sorted([g["canonical"], *g["aliases"]]), g["method"]) for g in data["resolved"]] == [
        (["C ++", "C++"], "skeleton"),
    ]


@pytest.mark.parametrize(
    "name,title",
    [("NAVA", "NVDA"), ("Chroma", "Chrome"), ("vestibular motion triggers", "vestibular motion disorders")],
)
def test_page_titles_bind_by_the_same_rules(client, name, title):
    """The cross-session matcher follows the in-session rules: a page title
    spelt like the name is not that name's page."""
    data = _fuzzy(client, [_entity(name, "CONCEPT")], page_titles=[{"title": title, "page_type": "concept"}])
    assert data["resolved"] == []


@pytest.mark.parametrize(
    "name,title,method",
    [
        ("gpt4", "GPT-4", "skeleton"),
        ("LLMs", "LLM", "plural"),
        ("AIs", "AI", "plural"),
        ("WebAIM", "WebKit", None),
        ("Chroma", "Chrome", None),
    ],
)
def test_cross_session_matcher_uses_the_layer_1_rules(name, title, method):
    from routers.resolution import _cross_session_method, _fuzzy_method  # noqa: PLC0415
    assert _cross_session_method(name, title) == method
    assert _fuzzy_method(name, title) == method


def test_capitalised_acronym_binds_its_page_whatever_the_kind(client):
    """Sources type "WCAG" ORG or PRODUCT and the guidelines CONCEPT; the
    acronym still lands on the existing page. A word that happens to spell
    initials ("Web") does not."""
    data = _fuzzy(
        client,
        [_entity("WCAG", "ORG", "s1"), _entity("Web", "CONCEPT", "s2")],
        page_titles=[
            {"title": "Web Content Accessibility Guidelines", "page_type": "concept"},
            {"title": "World Economic Bank", "page_type": "entity"},
        ],
    )
    assert [(g["canonical"], g["aliases"], g["method"]) for g in data["resolved"]] == [
        ("Web Content Accessibility Guidelines", ["WCAG"], "existing_page_title"),
    ]
    assert [e["name"] for e in data["unresolved"]] == ["Web"]


# ---------------------------------------------------------------------------
# "Full Name (ABBR)"
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "a,b,expected",
    [
        ("Web Content Accessibility Guidelines (WCAG)", "WCAG", "abbreviation"),
        ("WCAG", "Web Content Accessibility Guidelines (WCAG)", "abbreviation"),
        ("Web Content Accessibility Guidelines (WCAG)", "Web Content Accessibility Guidelines", "expansion"),
        ("United Nations Educational, Scientific and Cultural Organization (UNESCO)", "UNESCO", "abbreviation"),
        ("Mercury (planet)", "Mercury (element)", None),       # both in brackets
        ("Mercury (planet)", "Mercury", None),                 # a qualifier
        ("Avatar (2009)", "Avatar", None),                     # a year
        ("Labour Party (UK)", "UK", None),                     # capitals, not its abbreviation
        ("Color Universal Design (CUD)", "Color Universal Design Organization (CUDO)", None),
    ],
)
def test_parenthetical_match(a, b, expected):
    from routers.resolution import _parenthetical_match  # noqa: PLC0415
    assert _parenthetical_match(a, b) == expected


def test_full_name_with_its_abbreviation_in_brackets_merges(client):
    """2026-10-17, session 61c8bb37: "Web Content Accessibility Guidelines
    (WCAG)" never met "WCAG"; the bracket read as one more word."""
    data = _fuzzy(client, [
        _entity("Web Content Accessibility Guidelines (WCAG)", "CONCEPT", "s1"), _entity("WCAG", "OTHER", "s2"),
        _entity("Mercury (planet)", "LOCATION", "s3"), _entity("Mercury (element)", "LOCATION", "s4"),
        _entity("Avatar (2009)", "PRODUCT", "s5"), _entity("Avatar", "PRODUCT", "s6"),
    ])
    assert [(sorted([g["canonical"], *g["aliases"]]), g["method"]) for g in data["resolved"]] == [
        (["WCAG", "Web Content Accessibility Guidelines (WCAG)"], "parenthetical"),
    ]


def test_bracketed_page_binds_its_abbreviation_whatever_the_kind(client):
    page = [{"title": "Web Content Accessibility Guidelines (WCAG)", "page_type": "concept"}]
    data = _fuzzy(client, [_entity("WCAG", "ORG", "s1"), _entity("WCAG 2", "ORG", "s2")], page_titles=page)
    assert [(g["canonical"], g["aliases"]) for g in data["resolved"]] == [
        ("Web Content Accessibility Guidelines (WCAG)", ["WCAG"]),
    ]
    assert [e["name"] for e in data["unresolved"]] == ["WCAG 2"]  # numbers still guarded


def test_bracketed_page_binds_its_full_name_within_its_kind_only(client):
    page = [{"title": "Web Content Accessibility Guidelines (WCAG)", "page_type": "concept"}]
    same = _fuzzy(client, [_entity("Web Content Accessibility Guidelines", "CONCEPT")], page_titles=page)
    assert [g["canonical"] for g in same["resolved"]] == ["Web Content Accessibility Guidelines (WCAG)"]
    other = _fuzzy(client, [_entity("Web Content Accessibility Guidelines", "ORG")], page_titles=page)
    assert other["resolved"] == []


def test_people_one_letter_apart_stay_apart(client):
    """"Anderson" / "Andersen" are two surnames, not a slip."""
    data = _fuzzy(client, [_entity("Anderson", "PERSON", "s1"), _entity("Andersen", "PERSON", "s2"),
                           _entity("Kubernetes", "PRODUCT", "s3"), _entity("Kubernetis", "PRODUCT", "s4")])
    assert [sorted([g["canonical"], *g["aliases"]]) for g in data["resolved"]] == [["Kubernetes", "Kubernetis"]]
    page = _fuzzy(client, [_entity("Andersen", "PERSON", "s1")], page_titles=[{"title": "Anderson", "page_type": "entity"}])
    assert page["resolved"] == []
