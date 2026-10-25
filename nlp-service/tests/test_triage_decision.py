"""Triage decisions: an answer outside update / contradiction / skip is an error.

It used to come back as 'skip', which the app turns into a provenance link
(the source recorded on the page) although nothing decided that. Now
triage_page_update raises LLMCompileError and /pipeline/triage answers 500,
which the app records as a failed triage (reason triage_error) and can
re-check later.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest
from pydantic import ValidationError

from services import llm_client
from services.llm_client import LLMCompileError
from services.providers import LLMResult

_REQUEST = {"source_claims": "c", "existing_page_summary": "s", "page_title": "A"}


def _answer(monkeypatch, decision: str) -> None:
    class _Provider:
        def complete(self, req):
            parsed = llm_client.TriageResponse(decision=decision, reason="because")
            text = f'{{"decision": "{decision}", "reason": "because"}}'
            return LLMResult(text=text, parsed=parsed, parse_error=None, usage={}, finish_reason="STOP")

    monkeypatch.setattr(llm_client, "get_provider", lambda model: _Provider())


@pytest.mark.parametrize("decision", ["update", "contradiction", "skip"])
def test_known_decisions_are_returned_unchanged(monkeypatch, decision):
    _answer(monkeypatch, decision)
    assert llm_client.triage_page_update("claims", "summary", "A") == {"decision": decision, "reason": "because"}


def test_case_and_spacing_of_a_known_decision_are_ignored(monkeypatch):
    _answer(monkeypatch, " Update ")
    assert llm_client.triage_page_update("claims", "summary", "A")["decision"] == "update"


@pytest.mark.parametrize("decision", ["maybe", "no_update", ""])
def test_an_unknown_decision_is_an_error_not_a_skip(monkeypatch, decision):
    _answer(monkeypatch, decision)
    with pytest.raises(LLMCompileError, match="triage_unknown_decision"):
        llm_client.triage_page_update("claims", "summary", "A")


def test_route_answers_500_for_an_unknown_decision(client, monkeypatch):
    _answer(monkeypatch, "maybe")
    resp = client.post("/pipeline/triage", json=_REQUEST)
    assert resp.status_code == 500
    assert "triage_unknown_decision" in resp.json()["detail"]


def test_route_never_sends_an_unknown_decision(client):
    """The response model only allows the three decisions."""
    with patch("routers.pipeline.triage_page_update", return_value={"decision": "maybe", "reason": "r"}):
        with pytest.raises(ValidationError):
            client.post("/pipeline/triage", json=_REQUEST)
