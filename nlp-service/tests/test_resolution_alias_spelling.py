"""Layer 1 finds a stored alias by spelling, not only by exact lower case.

"colorblindness" missed the stored alias "Colour-blindness" of the page
"Color Vision Deficiency" (film run, 2026-10-25): the lookup compared exact
lower case. It now reads both names through the page-title skeleton (case,
spaces, hyphens, punctuation) and British -our / -ise spellings.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers.resolution_spelling import us_spelling


@pytest.fixture(scope="module")
def client():
    from routers.resolution import router  # noqa: PLC0415
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _fuzzy(client, names: list[str], aliases: list[tuple[str, str]], type_: str = "CONCEPT") -> dict[str, Any]:
    resp = client.post("/resolve/fuzzy", json={
        "entities": [{"name": n, "type": type_, "source_id": f"s{k}", "context": ""} for k, n in enumerate(names)],
        "existing_aliases": [{"alias": a, "canonical": c} for a, c in aliases],
        "existing_page_titles": [],
    })
    assert resp.status_code == 200
    return resp.json()


@pytest.mark.parametrize(("british", "american"), [
    ("colour", "color"), ("Colour-blindness", "color-blindness"), ("colourblindness", "colorblindness"),
    ("behaviour", "behavior"), ("behavioural", "behavioral"), ("honour", "honor"), ("neighbourhood", "neighborhood"),
    ("organise", "organize"), ("organisation", "organization"), ("organisational", "organizational"),
    ("realised", "realized"), ("visualising", "visualizing"), ("optimisers", "optimizers"),
])
def test_british_spellings_are_written_the_american_way(british, american):
    assert us_spelling(british) == american


@pytest.mark.parametrize("word", [
    "tour", "four", "hour", "flour", "your", "pour", "sour", "Fantastic Four", "our",
    "raise", "praise", "noise", "poise", "cruise", "maize", "prise", "rise", "wise", "Louise", "Elise",
])
def test_short_words_and_vowel_endings_keep_their_spelling(word):
    assert us_spelling(word) == word.lower()


def test_a_spelling_of_a_stored_alias_binds_to_its_canonical(client):
    out = _fuzzy(client, ["colorblindness"], [("Colour-blindness", "Color Vision Deficiency")])
    assert out["unresolved"] == []
    [group] = out["resolved"]
    assert (group["canonical"], group["aliases"], group["method"]) == \
        ("Color Vision Deficiency", ["colorblindness"], "existing_alias")


@pytest.mark.parametrize("name", ["Colour blindness", "colour-blindness", "COLOURBLINDNESS", "color blindness"])
def test_case_spaces_hyphens_and_spellings_all_find_the_alias(client, name):
    out = _fuzzy(client, [name], [("Colourblindness", "Color Vision Deficiency")])
    assert [g["canonical"] for g in out["resolved"]] == ["Color Vision Deficiency"]


def test_an_exact_alias_wins_over_a_spelling_of_another(client):
    out = _fuzzy(client, ["Colour-blindness"], [("Colour-blindness", "Color Vision Deficiency"),
                                                ("colourblindness", "Achromatopsia")])
    assert [g["canonical"] for g in out["resolved"]] == ["Color Vision Deficiency"]


@pytest.mark.parametrize(("name", "alias"), [
    ("Python 310", "Python 3.10"),     # same skeleton, different numbers
    ("tour", "tor"),                   # too short to be a spelling
    ("Fantastic Four", "Fantastic For"),
    ("colourblind", "Colour-blindness"),  # not a plural, not one name
])
def test_no_binding_without_one_spelling_and_the_same_numbers(client, name, alias):
    out = _fuzzy(client, [name], [(alias, "Some Page")])
    assert out["resolved"] == []
