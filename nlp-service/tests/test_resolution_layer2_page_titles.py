"""Layer 2 against page titles: an abbreviation in brackets and kinds that cross.

Film run 2026-10-25: the concept "Colorblindness" never reached Layer 3
against the entity page "Color Vision Deficiency (CVD)". The bracket lowered
the name similarity (0.6829 → 0.5392, real MiniLM) and across kinds only the
name counted, so the pair stayed under the 0.70 band and the compile made a
second page. Now the title is compared without a bracket that abbreviates
it, and across kinds the "name: context" similarity may ask Layer 3 too
(0.7741 here) when the names score at least 0.6, so a name its article only
ties to the page takes no Layer 3 slot; a pair across kinds still never
merges in Layer 2, and the pair is still made against the exact title.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

DIM = 16
CVD_CONTEXT = "Color vision deficiency, discussed as the condition affecting readers."


class _Encoder:
    def __init__(self, vectors: dict[str, list[float]]):
        self.vectors = vectors

    def encode(self, texts, convert_to_numpy=True, normalize_embeddings=False):  # noqa: ARG002
        return np.array([self.vectors.get(t, [0.0] * DIM) for t in texts], dtype=np.float32)


def _toward(sim: float, axis: int, spare: int) -> list[float]:
    """A unit vector whose cosine with axis `axis` is `sim`."""
    v = [0.0] * DIM
    v[axis], v[spare] = sim, math.sqrt(max(0.0, 1 - sim * sim))
    return v


def _two_titles(name: str, text: str, title: str, plain_title: str,
                with_bracket: tuple[float, float], without: tuple[float, float]) -> dict[str, list[float]]:
    """The name and its "name: context" text, and the two titles at the
    given cosines (name, context) with them. The name lies on axis 0 and the
    text at cosine 0.6 with it, as a name and its own context do."""
    def title_at(ns: float, cs: float, spare: int) -> list[float]:
        v = [0.0] * DIM
        v[0], v[1] = ns, (cs - 0.6 * ns) / 0.8
        v[spare] = math.sqrt(max(0.0, 1 - v[0] ** 2 - v[1] ** 2))
        return v

    return {
        name: _toward(1.0, 0, 1), text: _toward(0.6, 0, 1),
        title: title_at(*with_bracket, 2), plain_title: title_at(*without, 3),
    }


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


def _embedding(client, entities, pages) -> dict[str, Any]:
    resp = client.post("/resolve/embedding", json={"entities": entities, "existing_page_titles": pages})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _entity(name: str, type_: str, context: str) -> dict[str, Any]:
    return {"name": name, "type": type_, "source_id": "s1", "context": context}


def _asked(data: dict[str, Any], *, by_meaning: bool = False) -> list[tuple[str, str, float, float]]:
    """The pairs asked by the name rules, or with by_meaning those asked only as closest by meaning."""
    return [(p["entity_a"]["name"], p["entity_b"]["name"], p["name_similarity"], p["similarity"])
            for p in data["ambiguous"] if p["by_meaning"] == by_meaning]


def test_a_concept_is_asked_about_an_entity_page_whose_title_ends_in_its_abbreviation(client, encoder):
    """Real MiniLM numbers: 0.5392 / 0.6355 against the title as written,
    0.6829 / 0.7741 against it without "(CVD)"."""
    text = f"Colorblindness: {CVD_CONTEXT}"
    encoder(_two_titles("Colorblindness", text, "Color Vision Deficiency (CVD)", "Color Vision Deficiency",
                        with_bracket=(0.5392, 0.6355), without=(0.6829, 0.7741)))
    data = _embedding(client, [_entity("Colorblindness", "CONCEPT", CVD_CONTEXT)],
                      [{"title": "Color Vision Deficiency (CVD)", "page_type": "entity"}])
    assert data["resolved"] == []
    assert _asked(data) == [("Colorblindness", "Color Vision Deficiency (CVD)", 0.6829, 0.7741)]
    assert data["ambiguous"][0]["entity_b"]["source_id"] == "__existing_page__"


def test_without_the_context_the_cross_kind_pair_is_not_asked(client, encoder):
    """The name alone (0.6829) stays under the band: the context is what
    asks. At 0.6 the page is still among its closest by meaning, so it is
    asked that way, after the rest."""
    encoder(_two_titles("Colorblindness", "Colorblindness: x", "Color Vision Deficiency (CVD)",
                        "Color Vision Deficiency", with_bracket=(0.5392, 0.5), without=(0.6829, 0.6)))
    data = _embedding(client, [_entity("Colorblindness", "CONCEPT", "x")],
                      [{"title": "Color Vision Deficiency (CVD)", "page_type": "entity"}])
    assert _asked(data) == []
    assert _asked(data, by_meaning=True) == [("Colorblindness", "Color Vision Deficiency (CVD)", 0.6829, 0.6)]


def test_a_bracket_that_is_not_an_abbreviation_stays_in_the_title(client, encoder):
    """"Mercury (planet)" is compared as written: the bracket tells it apart."""
    encoder(_two_titles("Mercury", "Mercury: a", "Mercury (planet)", "Mercury",
                        with_bracket=(0.4, 0.4), without=(1.0, 1.0)))
    data = _embedding(client, [_entity("Mercury", "CONCEPT", "a")],
                      [{"title": "Mercury (planet)", "page_type": "concept"}])
    assert data["ambiguous"] == [] and data["resolved"] == []


@pytest.mark.parametrize("name,type_,title,page_type", [
    ("Color universal design", "CONCEPT", "Color Universal Design Organization (CUDO)", "entity"),
    ("Color Oracle", "PRODUCT", "Color blindness simulation", "concept"),
])
def test_across_kinds_even_identical_texts_are_only_asked(client, encoder, name, type_, title, page_type):
    same = _toward(1.0, 0, 3)
    plain = title.rsplit(" (", 1)[0]
    encoder({name: same, f"{name}: a": same, title: same, plain: same})
    data = _embedding(client, [_entity(name, type_, "a")], [{"title": title, "page_type": page_type}])
    assert data["resolved"] == []
    assert [(a, b) for a, b, _ns, _s in _asked(data)] == [(name, title)]


@pytest.mark.parametrize("name_sim,asked", [(0.6, True), (0.62, True), (0.5999, False), (0.4523, False)])
def test_across_kinds_context_asks_only_for_names_alike_enough(client, encoder, name_sim, asked):
    """A product against a concept page with context 0.7658: asked by the
    name rules when the names score at least 0.6. Real MiniLM gives "Color
    Oracle" / "Color blindness simulation" 0.4523 by name, so the name
    rules do not ask; as its closest page by meaning it is asked last."""
    page = _toward(1.0, 0, 3)
    encoder({"Color blindness simulation": page, "Color Oracle": _toward(name_sim, 0, 4),
             "Color Oracle: a": _toward(0.7658, 0, 5)})
    data = _embedding(client, [_entity("Color Oracle", "PRODUCT", "a")],
                      [{"title": "Color blindness simulation", "page_type": "concept"}])
    assert data["resolved"] == []
    pair = [("Color Oracle", "Color blindness simulation", round(name_sim, 4), 0.7658)]
    assert _asked(data) == (pair if asked else [])
    assert _asked(data, by_meaning=True) == ([] if asked else pair)


def test_a_page_is_asked_about_by_meaning_through_its_summary(client, encoder):
    """Closest by meaning (owner decision 2026-10-25): a name the title alone
    never brings near a page is asked about it when its context is like the
    page's "title: summary", after the name-alike pairs; at most five pages
    per name, none under 0.5, and never a person against anything else."""
    summary = "A condition affecting the ability to distinguish certain shades of color."
    vectors = {
        "Colorblindness": _toward(1.0, 0, 9), "Colorblindness: x": _toward(1.0, 1, 9),
        "Color Vision Deficiency": _toward(0.3, 0, 8),
        f"Color Vision Deficiency: {summary}": _toward(0.71, 1, 7),
        "Kei Ito": _toward(1.0, 2, 9), "Kei Ito: x": _toward(1.0, 1, 9),
    }
    for k, sim in enumerate((0.69, 0.68, 0.65, 0.59, 0.55, 0.45)):
        vectors[f"Page {k}"] = _toward(0.0, 3, 10 + k)
        vectors[f"Page {k}: about {k}"] = _toward(sim, 1, 10 + k)
    encoder(vectors)
    pages = [{"title": "Color Vision Deficiency", "page_type": "concept", "summary": summary},
             *({"title": f"Page {k}", "page_type": "concept", "summary": f"about {k}"} for k in range(6))]
    data = _embedding(client, [_entity("Colorblindness", "CONCEPT", "x"), _entity("Kei Ito", "PERSON", "x")], pages)
    assert _asked(data) == []
    assert _asked(data, by_meaning=True) == [
        ("Colorblindness", "Color Vision Deficiency", 0.3, 0.71),
        ("Colorblindness", "Page 0", 0.0, 0.69),
        ("Colorblindness", "Page 1", 0.0, 0.68),
        ("Colorblindness", "Page 2", 0.0, 0.65),
        ("Colorblindness", "Page 3", 0.0, 0.59),
    ]


def test_without_a_summary_the_title_stands_for_the_page(client, encoder):
    """Older callers send no summary: the title is compared, as before."""
    encoder({"Colorblindness": _toward(1.0, 0, 9), "Colorblindness: x": _toward(1.0, 1, 9),
             "Color Vision Deficiency": _toward(0.62, 1, 8)})
    data = _embedding(client, [_entity("Colorblindness", "CONCEPT", "x")],
                      [{"title": "Color Vision Deficiency", "page_type": "concept"}])
    assert [p["by_meaning"] for p in data["ambiguous"]] == [True]
