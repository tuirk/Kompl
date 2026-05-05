"""Unit tests for nlp-service/main.py.

Phase 5 added a provider_keys flag to /health for the Settings UI to gate
the dropdown by key presence. The test asserts the JSON shape; the
heavy ML deps are stubbed via conftest.py the same way every other
nlp-service test does.
"""

from __future__ import annotations


def _build_app():
    """Import main inside the test (after conftest stubs heavy deps)."""
    from main import app  # noqa: PLC0415
    return app


def test_health_returns_provider_keys_shape(monkeypatch):
    """/health must include {gemini: bool, deepseek: bool} under provider_keys."""
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "test-key")

    from fastapi.testclient import TestClient  # noqa: PLC0415
    client = TestClient(_build_app())
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "provider_keys" in body
    assert body["provider_keys"]["gemini"] is True
    assert body["provider_keys"]["deepseek"] is True


def test_health_provider_keys_reflect_unset_env(monkeypatch):
    """Both flags should be False when neither env var is set."""
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    from fastapi.testclient import TestClient  # noqa: PLC0415
    client = TestClient(_build_app())
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["provider_keys"]["gemini"] is False
    assert body["provider_keys"]["deepseek"] is False


def test_health_provider_keys_reflect_partial_env(monkeypatch):
    """One key set → one True one False (the Phase 6 gating use case)."""
    monkeypatch.setenv("GEMINI_API_KEY", "g")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    from fastapi.testclient import TestClient  # noqa: PLC0415
    client = TestClient(_build_app())
    r = client.get("/health")
    body = r.json()
    assert body["provider_keys"]["gemini"] is True
    assert body["provider_keys"]["deepseek"] is False


def test_health_provider_keys_treat_whitespace_as_unset(monkeypatch):
    """A whitespace-only env var should still register as unset."""
    monkeypatch.setenv("GEMINI_API_KEY", "   ")
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)

    from fastapi.testclient import TestClient  # noqa: PLC0415
    client = TestClient(_build_app())
    body = client.get("/health").json()
    assert body["provider_keys"]["gemini"] is False
