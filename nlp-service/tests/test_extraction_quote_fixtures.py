"""Before/after check of the extraction contract on saved fixture sources
(plan 3.2, D4; relation prompt 3b). No real LLM calls: each saved reply goes
through the real provider class with only its transport stubbed.

  <name>.md             the source text
  <name>.before.json    an extraction made before quotes (old contract)
  <name>.deepseek.json  the new contract as DeepSeek's json_object mode can
                        return it: a missing quote key, a quote that is a
                        number or empty, an extra key, a type spelt freely
  <name>.gemini.json    the same content as Gemini's response_schema returns
                        it: every key, in schema order, null where unsure

Old extractions keep parsing (no quotes, nothing verified); new ones parse
on both shapes, and the soft check marks every quote without dropping one.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from services import llm_client

FIXTURES = Path(__file__).parent / "fixtures" / "extraction_quotes"
NAMES = ("news", "paper", "transcript")

# quote_verified per claim / relationship, and ends_listed per relationship,
# for the new-contract replies (the same on both providers' shapes).
EXPECTED = {
    "news": {"claims": [True, True, False, None, None], "relations": [True, True], "ends": [True, False]},
    "paper": {"claims": [True, True, None], "relations": [True, True, None], "ends": [True, True, False]},
    "transcript": {"claims": [True, True, True], "relations": [True, True, True], "ends": [True, True, True]},
}


def _source(name: str) -> str:
    return (FIXTURES / f"{name}.md").read_text(encoding="utf-8")


def _reply(name: str, shape: str) -> str:
    return (FIXTURES / f"{name}.{shape}.json").read_text(encoding="utf-8")


def _deepseek(monkeypatch, reply: str) -> str:
    """The real DeepSeek provider, its HTTP call answering `reply`."""
    pytest.importorskip("pyrate_limiter")
    from services import providers as P  # noqa: PLC0415
    from services.providers import deepseek as D  # noqa: PLC0415

    P._REGISTRY.clear()
    monkeypatch.setattr(D, "_DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(D, "_client", None)
    limiter = MagicMock()
    limiter.try_acquire.return_value = True
    monkeypatch.setattr(D, "_get_limiter", lambda: limiter)
    body = {
        "choices": [{"message": {"content": reply}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 2000, "completion_tokens": 900, "prompt_cache_hit_tokens": 0},
    }

    class _Response:
        status_code = 200
        text = ""

        def json(self):
            return body

    monkeypatch.setattr("httpx.Client.post", lambda self, url, json=None, **kw: _Response())
    return "deepseek-flash"


def _gemini(monkeypatch, reply: str) -> str:
    """The real Gemini provider, its SDK client answering `reply`."""
    pytest.importorskip("google.genai")
    from services import providers as P  # noqa: PLC0415
    from services.providers import gemini as G  # noqa: PLC0415

    P._REGISTRY.clear()
    response = MagicMock()
    response.text = reply
    response.candidates = []
    response.usage_metadata.prompt_token_count = 2000
    response.usage_metadata.cached_content_token_count = 0
    response.usage_metadata.candidates_token_count = 900
    response.usage_metadata.thoughts_token_count = 0
    client = MagicMock()
    client.models.generate_content.return_value = response
    monkeypatch.setattr(G, "get_client", lambda: client)
    limiter = MagicMock()
    limiter.try_acquire.return_value = True
    monkeypatch.setattr(G, "_get_limiter", lambda: limiter)
    return "gemini-2.5-flash"


PROVIDERS = {"deepseek": _deepseek, "gemini": _gemini}


def _extract(monkeypatch, provider: str, name: str, shape: str) -> llm_client.LLMExtractionResponse:
    model = PROVIDERS[provider](monkeypatch, _reply(name, shape))
    return llm_client.extract_source(
        source_id=name,
        markdown=_source(name),
        ner_output={},
        keyphrase_output=None,
        tfidf_output=None,
        model=model,
    )


@pytest.mark.parametrize("provider", PROVIDERS)
@pytest.mark.parametrize("name", NAMES)
def test_an_extraction_made_before_quotes_still_parses(monkeypatch, provider, name):
    result = _extract(monkeypatch, provider, name, "before")
    old = json.loads(_reply(name, "before"))
    assert len(result.claims) == len(old["claims"]) and len(result.relationships) == len(old["relationships"])
    for item in [*result.claims, *result.relationships]:
        assert item.quote is None and item.quote_verified is None
    # The old replies name only listed entities and concepts.
    assert all(r.ends_listed for r in result.relationships)


@pytest.mark.parametrize("provider", PROVIDERS)
@pytest.mark.parametrize("name", NAMES)
def test_the_new_contract_parses_on_both_shapes_and_is_checked(monkeypatch, provider, name):
    shape = provider  # each provider answers in its own JSON shape
    result = _extract(monkeypatch, provider, name, shape)
    want = EXPECTED[name]
    assert [c.quote_verified for c in result.claims] == want["claims"]
    assert [r.quote_verified for r in result.relationships] == want["relations"]
    assert [r.ends_listed for r in result.relationships] == want["ends"]
    # Nothing is dropped: every claim and relationship the reply had is kept.
    reply = json.loads(_reply(name, shape))
    assert len(result.claims) == len(reply["claims"])
    assert len(result.relationships) == len(reply["relationships"])


@pytest.mark.parametrize("provider", PROVIDERS)
def test_a_verified_quote_is_the_sources_own_text(monkeypatch, provider):
    news = _extract(monkeypatch, provider, "news", provider)
    # The LLM dropped an apostrophe; the stored quote is the source's sentence.
    assert news.relationships[1].quote == (
        "They share the line with the newer Siemens articulated trams on route 15, "
        "which compete for tourists with the city's tuk-tuk operators."
    )
    # A paraphrase stays as written, marked unverified.
    assert news.claims[2].quote == "The Remodelado trams were originally built in the 1930s."
    # The direction the prompt defines: the made thing first, its maker second.
    assert (news.relationships[0].from_entity, news.relationships[0].to) == ("Remodelado", "Carris")

    transcript = _extract(monkeypatch, provider, "transcript", provider)
    # The LLM capitalised and punctuated an unpunctuated transcript.
    assert transcript.claims[0].quote == (
        "the borrow checker is the part of the rust compiler that makes sure "
        "references never outlive the data they point to"
    )


def test_the_route_returns_the_check_with_the_extraction(monkeypatch, client):
    """The fields the LLM never sees still reach the app. The TestClient
    speaks httpx itself, so the provider is faked here, parsing as the
    DeepSeek provider does."""
    from services.providers import LLMResult  # noqa: PLC0415

    reply = _reply("paper", "deepseek")

    class _Provider:
        def complete(self, req):
            parsed = req.response_model.model_validate_json(reply)
            return LLMResult(text=reply, parsed=parsed, parse_error=None, usage={}, finish_reason="STOP")

    monkeypatch.setattr(llm_client, "get_provider", lambda model: _Provider())
    resp = client.post("/pipeline/extract-llm", json={
        "source_id": "paper",
        "markdown": _source("paper"),
        "ner_output": {},
        "compile_model": "deepseek-flash",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert [c["quote_verified"] for c in body["claims"]] == EXPECTED["paper"]["claims"]
    assert [r["ends_listed"] for r in body["relationships"]] == EXPECTED["paper"]["ends"]
    assert body["relationships"][2]["quote"] is None
