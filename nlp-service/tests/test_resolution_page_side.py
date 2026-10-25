"""Layer 3 sees the page side of a pair as the page, not as one sentence.

"colorblindness" against the page "Color Vision Deficiency" reached Layer 3
with the page side's context empty (or one source's sentence calling it "a
broader term"), so the model answered different; it never saw the page's
summary or its stored alias "Colour-blindness" (film run, 2026-10-25). A
side bound to a page now carries the page summary as its context and the
page's names as known_names; the prompts say how to read them.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from services import llm_client


@pytest.fixture
def captured(monkeypatch) -> list[dict[str, Any]]:
    from services.llm_client import DisambiguationResponse  # noqa: PLC0415

    calls: list[dict[str, Any]] = []

    def fake(pairs, model, pair_kind="entity"):  # noqa: ARG001
        calls.append({"pairs": pairs, "pair_kind": pair_kind})
        return DisambiguationResponse(results=[])

    monkeypatch.setattr(llm_client, "disambiguate_entities", fake)
    return calls


@pytest.fixture(scope="module")
def client():
    from routers.resolution import router  # noqa: PLC0415
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


_SUMMARY = "A condition in which a person is insensitive to some colours because a cone type is missing."


def _pair(b_extra: dict[str, Any]) -> dict[str, Any]:
    return {
        "entity_a": {"name": "colour blindness", "type": "CONCEPT", "source_id": "s1", "context": "a"},
        "entity_b": {"name": "Hue Insensitivity", "type": "CONCEPT", "source_id": "__existing_page__",
                     "context": _SUMMARY, **b_extra},
        "similarity": 0.8, "name_similarity": 0.8, "pair_id": "0",
    }


def test_a_page_side_goes_to_the_model_with_its_known_names(client, captured):
    resp = client.post("/resolve/disambiguate", json={"pairs": [_pair({"known_names": ["Daltonism"]})]})
    assert resp.status_code == 200
    [sent] = captured[0]["pairs"]
    assert sent["entity_b"] == {"name": "Hue Insensitivity", "type": "CONCEPT", "context": _SUMMARY,
                                "known_names": ["Daltonism"]}
    assert sent["entity_a"] == {"name": "colour blindness", "type": "CONCEPT", "context": "a"}


def test_a_page_with_no_stored_alias_is_still_marked_as_a_page(client, captured):
    client.post("/resolve/disambiguate", json={"pairs": [_pair({"known_names": []})]})
    assert captured[0]["pairs"][0]["entity_b"]["known_names"] == []


def test_a_caller_without_known_names_sends_what_it_always_sent(client, captured):
    resp = client.post("/resolve/disambiguate", json={"pairs": [_pair({})]})
    assert resp.status_code == 200
    assert set(captured[0]["pairs"][0]["entity_b"]) == {"name", "type", "context"}


def test_known_names_must_be_a_list_of_names(client, captured):
    resp = client.post("/resolve/disambiguate", json={"pairs": [_pair({"known_names": "Daltonism"})]})
    assert resp.status_code == 422
    assert captured == []


@pytest.mark.parametrize("name", ["_DISAMBIGUATION_SYSTEM_PROMPT", "_DISAMBIGUATION_CONCEPT_SYSTEM_PROMPT"])
def test_both_prompts_read_a_page_side_by_its_own_definition(name):
    prompt = getattr(llm_client, name)
    for rule in ("known_names", "page's own summary", "one source's wording", "weigh it",
                 "type, form, part or sub-topic"):
        assert rule in prompt, rule
