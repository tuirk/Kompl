"""The name rules in routers/resolution_rules.py, on their own."""

from __future__ import annotations

import pytest

from routers.resolution_rules import content_words, content_words_agree, hubs, majority_kind


@pytest.mark.parametrize("name,words", [
    ("The Zürich Opera House", ["zurich", "opera", "house"]),
    ("Kraków", ["krakow"]),
    ("Straße", ["strasse"]),
    ("Ethereum's roadmap", ["ethereum", "roadmap"]),
    ("GPT4", ["gpt", "4"]),
    ("Bank of England", ["bank", "england"]),
])
def test_content_words(name, words):
    assert content_words(name) == words


@pytest.mark.parametrize("a,b,person,agree", [
    ("Zurich", "Zürich", False, True),
    ("Large Language Model", "large language models", False, True),
    ("CSS media query", "CSS media queries", False, True),
    ("Process", "Processes", False, True),
    ("The Beatles", "Beatles", False, True),
    ("North Korea", "South Korea", False, False),
    ("Vilnius City Hall", "Vilnius Town Hall", False, False),
    ("Machine translation", "Automatic translation", False, False),
    ("ML", "Machine Learning", False, False),
    ("Web Content Accessibility", "Accessibility of Web Content", False, False),   # order kept
    ("John Edward", "John Edwards", True, False),
    ("John Edward", "john edward", True, True),
    ("The", "the", False, False),                                                  # no content words
])
def test_content_words_agree(a, b, person, agree):
    assert content_words_agree([a], [b], person=person) is agree
    assert content_words_agree([b], [a], person=person) is agree


def test_content_words_agree_through_any_name_of_each_side():
    assert content_words_agree(["Zürich", "City of Zurich"], ["Stadt", "Zurich"])
    assert not content_words_agree([], ["Zurich"])


@pytest.mark.parametrize("kinds,expected", [
    ([("OTHER", 1), ("CONCEPT", 2)], "CONCEPT"),
    ([("OTHER", 3), ("CONCEPT", 2)], "OTHER"),
    ([("PRODUCT", 1), ("ORG", 1)], "ORG"),
    ([("CONCEPT", 1), ("OTHER", 1)], "CONCEPT"),
])
def test_majority_kind(kinds, expected):
    assert majority_kind(kinds) == expected
    assert majority_kind(reversed(kinds)) == expected


def test_hubs_are_names_between_two_names_that_differ():
    # 0 "Paul" matches 1 "Paul Graham" and 2 "Paul Allen", which differ;
    # 3 "A. Karpathy" matches 4 and 5, which match each other.
    links = {(0, 1), (0, 2), (3, 4), (3, 5), (4, 5)}

    def linked(j: int, k: int) -> bool:
        return (min(j, k), max(j, k)) in links

    partners = {0: [1, 2], 1: [0], 2: [0], 3: [4, 5], 4: [3, 5], 5: [3, 4]}
    assert hubs(partners, linked) == {0}
