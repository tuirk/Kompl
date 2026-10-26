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


@pytest.mark.parametrize("name", ["_DISAMBIGUATION_PAGE_SYSTEM_PROMPT", "_DISAMBIGUATION_CONCEPT_PAGE_SYSTEM_PROMPT"])
def test_both_prompts_read_a_page_side_by_its_own_definition(name):
    prompt = getattr(llm_client, name)
    for rule in ("known_names", "page's own summary", "one source's wording", "weigh it",
                 "type, form, part or sub-topic", "token, coin or ticker",
                 "product and its maker", "Judge the names first"):
        assert rule in prompt, rule


def _plain(a: str, b: str) -> dict[str, Any]:
    return {"entity_a": {"name": a, "type": "CONCEPT", "source_id": "s1", "context": "a"},
            "entity_b": {"name": b, "type": "CONCEPT", "source_id": "s2", "context": "b"},
            "similarity": 0.8, "name_similarity": 0.8}


def test_pairs_with_a_page_side_go_in_batches_of_their_own(client, captured):
    """The page rules leaked into every batch and turned an asset and its
    platform into "same"; a pair with no page side never shares a batch, and
    so never a prompt, with one that has."""
    pairs = [_plain("Alpha", "Beta"), _pair({"known_names": []}), _plain("Gamma", "Delta")]
    resp = client.post("/resolve/disambiguate", json={"pairs": pairs})
    assert resp.status_code == 200
    batches = [[p["entity_a"]["name"] for p in c["pairs"]] for c in captured]
    assert batches == [["Alpha", "Gamma"], ["colour blindness"]]
    assert [any("known_names" in s for p in c["pairs"] for s in (p["entity_a"], p["entity_b"])) for c in captured] \
        == [False, True]


def test_the_page_block_is_absent_from_a_batch_with_no_page_side(monkeypatch):
    """disambiguate_entities picks the prompt per batch: the prompts without
    the page rules for a batch with no known_names side."""
    from services.providers import LLMResult  # noqa: PLC0415

    sent: list[str] = []

    class _Provider:
        def complete(self, req):
            sent.append(req.messages[0]["content"])
            return LLMResult(text='{"results": []}', parsed=llm_client.DisambiguationResponse(results=[]),
                             parse_error=None, usage={}, finish_reason="STOP")

    monkeypatch.setattr(llm_client, "get_provider", lambda model: _Provider())
    plain = {"entity_a": {"name": "A", "type": "ORG", "context": "a"},
             "entity_b": {"name": "B", "type": "ORG", "context": "b"}, "same_source": False}
    page = {**plain, "entity_b": {**plain["entity_b"], "known_names": ["Bee"]}}
    for kind in ("entity", "concept"):
        llm_client.disambiguate_entities([plain], model="deepseek-flash", pair_kind=kind)
        llm_client.disambiguate_entities([page], model="deepseek-flash", pair_kind=kind)
    assert sent == [llm_client._DISAMBIGUATION_SYSTEM_PROMPT, llm_client._DISAMBIGUATION_PAGE_SYSTEM_PROMPT,
                    llm_client._DISAMBIGUATION_CONCEPT_SYSTEM_PROMPT, llm_client._DISAMBIGUATION_CONCEPT_PAGE_SYSTEM_PROMPT]
    for prompt in (sent[0], sent[2]):
        assert "known_names" not in prompt and llm_client._DISAMBIGUATION_WIKI_PAGE not in prompt
    for prompt in (sent[1], sent[3]):
        assert llm_client._DISAMBIGUATION_WIKI_PAGE in prompt
