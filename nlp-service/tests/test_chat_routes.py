"""Regression tests for the /chat/synthesize endpoint contract.

Validates that the Pydantic Literal on SynthesizeRequest.chat_model rejects
any string outside the allowed 3-model union. No Gemini calls are made —
the request fails at Pydantic validation before ever reaching the handler.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def chat_client():
    from routers.chat import router as chat_router  # noqa: PLC0415
    app = FastAPI()
    app.include_router(chat_router)
    return TestClient(app)


_BASE_BODY = {
    "question": "what is x",
    "pages": [],
    "history": [],
}


def test_synthesize_rejects_unknown_chat_model(chat_client):
    body = {**_BASE_BODY, "chat_model": "gemini-1.5-pro"}
    resp = chat_client.post("/chat/synthesize", json=body)
    assert resp.status_code == 422
    assert "chat_model" in resp.text


def test_synthesize_rejects_empty_chat_model(chat_client):
    body = {**_BASE_BODY, "chat_model": ""}
    resp = chat_client.post("/chat/synthesize", json=body)
    assert resp.status_code == 422


def test_synthesize_rejects_extra_fields(chat_client):
    """extra='forbid' still enforced — unknown fields must 422."""
    body = {**_BASE_BODY, "unknown_field": "x"}
    resp = chat_client.post("/chat/synthesize", json=body)
    assert resp.status_code == 422
