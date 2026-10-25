"""The triage prompt: judged on the source's cited claims about the page.

The app sends the claims the source's extraction makes about the page's
subject (each with the source's own sentence when one was kept) and the
page's section most related to them (evidence='claims'). An extraction with
no such claims falls back to the source text (evidence='source_text', the
default, which keeps the old request shape working).
"""

from __future__ import annotations

from unittest.mock import patch

from services import llm_client
from services.providers import LLMResult

_CLAIMS = '- GPT-4 has a 32k context window.\n  Source sentence: "GPT-4 supports 32,768 tokens."'
_SECTION = "## Context window\nGPT-4 accepts 128k tokens."


def _capture(monkeypatch) -> list:
    sent: list = []

    class _Provider:
        def complete(self, req):
            sent.append(req)
            parsed = llm_client.TriageResponse(decision="skip", reason="r")
            return LLMResult(text='{"decision": "skip", "reason": "r"}', parsed=parsed, parse_error=None, usage={}, finish_reason="STOP")

    monkeypatch.setattr(llm_client, "get_provider", lambda model: _Provider())
    return sent


def _prompt(req) -> str:
    return req.messages[0]["content"]


def test_claims_evidence_puts_the_claims_and_the_page_section_in_the_prompt(monkeypatch):
    sent = _capture(monkeypatch)
    llm_client.triage_page_update(_CLAIMS, "A large language model.", "GPT-4", page_section=_SECTION, evidence="claims")
    prompt = _prompt(sent[0])
    assert "What the new source claims about this page's subject" in prompt
    assert _CLAIMS in prompt
    assert "The page's section most related to these claims:\n" + _SECTION in prompt
    assert "New information from ingested source" not in prompt


def test_source_text_evidence_keeps_the_old_prompt(monkeypatch):
    sent = _capture(monkeypatch)
    llm_client.triage_page_update("Full source text.", "Summary.", "GPT-4")
    prompt = _prompt(sent[0])
    assert "New information from ingested source:\nFull source text." in prompt
    assert "section most related" not in prompt
    assert "claims about this page's subject" not in prompt


def test_a_contradiction_reason_names_both_claims(monkeypatch):
    sent = _capture(monkeypatch)
    llm_client.triage_page_update(_CLAIMS, "Summary.", "GPT-4", evidence="claims")
    assert "the reason quotes the page's claim and the source's claim" in _prompt(sent[0])


def test_call_settings_are_unchanged(monkeypatch):
    sent = _capture(monkeypatch)
    llm_client.triage_page_update(_CLAIMS, "Summary.", "GPT-4", evidence="claims")
    req = sent[0]
    assert (req.temperature, req.max_output_tokens, req.step) == (0.0, 512, "triage")
    assert req.response_model is llm_client.TriageResponse


def test_route_passes_the_section_and_evidence(client):
    with patch("routers.pipeline.triage_page_update", return_value={"decision": "skip", "reason": "r"}) as call:
        resp = client.post(
            "/pipeline/triage",
            json={
                "source_claims": _CLAIMS,
                "existing_page_summary": "s",
                "page_title": "GPT-4",
                "page_section": _SECTION,
                "evidence": "claims",
            },
        )
    assert resp.status_code == 200
    assert call.call_args.kwargs["page_section"] == _SECTION
    assert call.call_args.kwargs["evidence"] == "claims"


def test_route_defaults_to_source_text_for_the_old_request(client):
    with patch("routers.pipeline.triage_page_update", return_value={"decision": "skip", "reason": "r"}) as call:
        resp = client.post("/pipeline/triage", json={"source_claims": "c", "existing_page_summary": "s", "page_title": "A"})
    assert resp.status_code == 200
    assert call.call_args.kwargs["page_section"] == ""
    assert call.call_args.kwargs["evidence"] == "source_text"


def test_route_refuses_an_unknown_evidence_kind(client):
    resp = client.post(
        "/pipeline/triage",
        json={"source_claims": "c", "existing_page_summary": "s", "page_title": "A", "evidence": "vibes"},
    )
    assert resp.status_code == 422
