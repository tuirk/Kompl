"""Tests for the /metadata/peek endpoint.

These tests do NOT hit the network. httpx.AsyncClient is stubbed via
monkeypatching the module-level `httpx.AsyncClient` used by the router so we
can assert how og-tag parsing handles success, partial responses, malformed
HTML, redirects, non-HTML payloads, and timeouts — all without flakiness.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncIterator
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers import metadata_peek as mp
from routers.metadata_peek import (
    MetadataPeekResponse,
    _extract,
    router as metadata_peek_router,
)
from services.url_safety import ValidatedURL


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(metadata_peek_router)
    return TestClient(app)


# ─── _extract: pure HTML-parser unit tests ──────────────────────────────────


def test_extract_picks_og_title_over_html_title():
    html = """
    <html><head>
      <title>Plain Title</title>
      <meta property="og:title" content="OG Title">
      <meta property="og:description" content="A great description">
      <meta property="og:image" content="https://x.test/img.png">
    </head><body>ignored</body></html>
    """
    out = _extract(html)
    assert out.title == "OG Title"
    assert out.description == "A great description"
    assert out.og_image == "https://x.test/img.png"


def test_extract_falls_back_to_html_title_when_no_og_title():
    html = "<html><head><title>Only HTML Title</title></head><body></body></html>"
    out = _extract(html)
    assert out.title == "Only HTML Title"
    assert out.description is None
    assert out.og_image is None


def test_extract_uses_meta_description_when_no_og_description():
    html = """
    <html><head>
      <title>T</title>
      <meta name="description" content="meta desc fallback">
    </head></html>
    """
    out = _extract(html)
    assert out.description == "meta desc fallback"


def test_extract_returns_all_null_for_empty_html():
    out = _extract("<html><head></head></html>")
    assert out == MetadataPeekResponse()


def test_extract_handles_malformed_html_without_raising():
    # Unclosed tags + stray characters — parser must not throw.
    html = '<html><head><title>broken<meta property="og:title" content="X"'
    out = _extract(html)
    # We're permissive: we just need the call to not raise. Whatever parsed is fine.
    assert isinstance(out, MetadataPeekResponse)


def test_extract_strips_whitespace_and_treats_empty_as_null():
    html = '<html><head><meta property="og:title" content="   "></head></html>'
    out = _extract(html)
    assert out.title is None


# ─── /metadata/peek: route-level tests with stubbed httpx ───────────────────


class _FakeResponse:
    def __init__(
        self,
        body: bytes,
        content_type: str = "text/html; charset=utf-8",
        charset: str | None = "utf-8",
        status_code: int = 200,
        location: str | None = None,
    ) -> None:
        self._body = body
        self.status_code = status_code
        headers = {"content-type": content_type}
        if location is not None:
            headers["location"] = location
        self.headers = headers
        self.charset_encoding = charset

    async def aiter_bytes(self) -> AsyncIterator[bytes]:
        yield self._body


class _FakeClient:
    def __init__(self, response: _FakeResponse | None = None, raises: Exception | None = None) -> None:
        self._response = response
        self._raises = raises

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc) -> None:
        return None

    def stream(self, _method: str, _url: str, **_kw):
        if self._raises is not None:
            raise self._raises

        @asynccontextmanager
        async def cm():
            yield self._response

        return cm()


def _patch_httpx(monkeypatch, fake: _FakeClient) -> None:
    monkeypatch.setattr(mp.httpx, "AsyncClient", lambda **_kw: fake)
    monkeypatch.setattr(
        mp,
        "validate_outbound_url",
        lambda url: ValidatedURL(pinned_url=url, host_header="example.test", sni_hostname="example.test"),
    )


def test_peek_happy_path(monkeypatch, client):
    body = (
        b'<html><head><title>X</title>'
        b'<meta property="og:title" content="OG"><meta property="og:description" content="D">'
        b'</head></html>'
    )
    _patch_httpx(monkeypatch, _FakeClient(_FakeResponse(body)))
    res = client.post("/metadata/peek", json={"url": "https://example.test"})
    assert res.status_code == 200
    assert res.json() == {"title": "OG", "description": "D", "og_image": None}


def test_peek_swallows_network_errors(monkeypatch, client):
    _patch_httpx(monkeypatch, _FakeClient(raises=RuntimeError("boom")))
    res = client.post("/metadata/peek", json={"url": "https://broken.test"})
    assert res.status_code == 200
    assert res.json() == {"title": None, "description": None, "og_image": None}


def test_peek_skips_non_html_content_type(monkeypatch, client):
    fake = _FakeClient(_FakeResponse(b"%PDF-1.5", content_type="application/pdf"))
    _patch_httpx(monkeypatch, fake)
    res = client.post("/metadata/peek", json={"url": "https://x.test/doc.pdf"})
    assert res.status_code == 200
    assert res.json() == {"title": None, "description": None, "og_image": None}


def test_peek_rejects_extra_fields():
    # Pydantic strict (extra='forbid'): nudges callers toward contract-first.
    app = FastAPI()
    app.include_router(metadata_peek_router)
    c = TestClient(app)
    res = c.post("/metadata/peek", json={"url": "https://x.test", "extra": "no"})
    assert res.status_code == 422


def test_peek_returns_empty_when_url_validation_rejects(monkeypatch, client):
    """SSRF gate: validate_outbound_url raising ValueError yields the empty
    response without any HTTP request being attempted."""
    stream_calls = []

    class _TrackingClient(_FakeClient):
        def stream(self, method, url, **kw):
            stream_calls.append((method, url))
            return super().stream(method, url, **kw)

    fake = _TrackingClient(_FakeResponse(b""))
    monkeypatch.setattr(mp.httpx, "AsyncClient", lambda **_kw: fake)
    monkeypatch.setattr(mp, "validate_outbound_url", lambda _u: (_ for _ in ()).throw(ValueError("private_address")))

    res = client.post("/metadata/peek", json={"url": "http://169.254.169.254/"})
    assert res.status_code == 200
    assert res.json() == {"title": None, "description": None, "og_image": None}
    assert stream_calls == [], "stream must not be called when validation rejects"


def test_peek_follows_redirect_with_revalidation(monkeypatch, client):
    """Each redirect hop runs validate_outbound_url again. A redirect to a
    blocked target after a successful first hop must yield the empty response."""
    seen_urls: list[str] = []

    def _validate(url: str):
        seen_urls.append(url)
        if "evil" in url:
            raise ValueError("private_address")
        return ValidatedURL(pinned_url=url, host_header="ex.test", sni_hostname="ex.test")

    monkeypatch.setattr(mp, "validate_outbound_url", _validate)

    # First call returns a 302 redirect to an evil URL; second hop should
    # be rejected by validation.
    redirect_resp = _FakeResponse(b"", status_code=302, location="http://evil.test/")
    monkeypatch.setattr(mp.httpx, "AsyncClient", lambda **_kw: _FakeClient(redirect_resp))

    res = client.post("/metadata/peek", json={"url": "http://safe.test/"})
    assert res.status_code == 200
    assert res.json() == {"title": None, "description": None, "og_image": None}
    assert "http://safe.test/" in seen_urls
    assert any("evil" in u for u in seen_urls), "redirect target must hit validator"
