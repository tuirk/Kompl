"""SSRF guard tests for POST /convert/url (routers/conversion.py).

The guard calls services.url_safety.validate_outbound_url() before the
generic fetch layers (MarkItDown / Firecrawl). These tests assert that
internal / non-public targets are rejected with 422 url_blocked BEFORE any
converter runs, and that public URLs pass the guard and reach the
MarkItDown layer.

No network: DNS resolution (socket.getaddrinfo) is monkeypatched inside
services.url_safety for every case that needs name resolution, and
_try_markitdown_url is stubbed so nothing fetches.
"""

from __future__ import annotations

import socket

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers import conversion as conv
from routers.conversion import router as conversion_router
from services import url_safety


# ─── Test client ─────────────────────────────────────────────────────────────


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(conversion_router)
    return TestClient(app)


def _post(client: TestClient, url: str):
    return client.post(
        "/convert/url",
        json={"source_id": "src-ssrf-test", "url": url},
    )


def _fail_if_fetched(monkeypatch):
    """Stub the fetch layers so a guard bypass fails loudly, not over the network."""

    def _boom(*args, **kwargs):  # noqa: ANN002, ANN003
        raise AssertionError("fetch layer reached — SSRF guard did not block the URL")

    monkeypatch.setattr(conv, "_try_markitdown_url", _boom)


def _stub_dns(monkeypatch, ip: str):
    """Make every hostname resolve to a single fixed IP (no real DNS)."""

    def _fake_getaddrinfo(host, port, *args, **kwargs):  # noqa: ANN002, ANN003
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))]

    monkeypatch.setattr(url_safety.socket, "getaddrinfo", _fake_getaddrinfo)


# ─── Blocked: literal private / loopback / link-local IPs ────────────────────


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data/",  # AWS metadata (link-local)
        "http://127.0.0.1:8000/storage/write-page",  # nlp-service itself
        "http://10.0.0.5/",                          # RFC1918
        "http://172.18.0.3:3000/api/import",         # Docker bridge range
        "http://[::1]:5678/",                        # IPv6 loopback
        "http://0.0.0.0/",                           # unspecified
    ],
)
def test_literal_private_ip_blocked(client, monkeypatch, url):
    _fail_if_fetched(monkeypatch)
    resp = _post(client, url)
    assert resp.status_code == 422
    assert "url_blocked" in resp.json()["detail"]


# ─── Blocked: cloud metadata hostnames ───────────────────────────────────────


@pytest.mark.parametrize(
    "url",
    [
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://metadata/latest/",
        "http://instance-data/latest/meta-data/",
    ],
)
def test_metadata_host_blocked(client, monkeypatch, url):
    _fail_if_fetched(monkeypatch)
    resp = _post(client, url)
    assert resp.status_code == 422
    assert "url_blocked" in resp.json()["detail"]


# ─── Blocked: non-http(s) schemes ────────────────────────────────────────────


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.org/file.txt",
        "file:///etc/passwd",
        "gopher://example.org/",
    ],
)
def test_non_http_scheme_blocked(client, monkeypatch, url):
    _fail_if_fetched(monkeypatch)
    resp = _post(client, url)
    assert resp.status_code == 422
    assert "url_blocked" in resp.json()["detail"]


# ─── Blocked: hostname resolving to a private address (Docker DNS names) ────


def test_hostname_resolving_private_blocked(client, monkeypatch):
    """`http://app:3000` style Docker service names resolve to bridge-network
    private IPs — the guard must reject after resolution."""
    _fail_if_fetched(monkeypatch)
    _stub_dns(monkeypatch, "172.18.0.2")
    resp = _post(client, "http://app:3000/api/import")
    assert resp.status_code == 422
    assert "url_blocked" in resp.json()["detail"]


def test_dns_failure_blocked(client, monkeypatch):
    _fail_if_fetched(monkeypatch)

    def _fail_getaddrinfo(host, port, *args, **kwargs):  # noqa: ANN002, ANN003
        raise socket.gaierror("Name or service not known")

    monkeypatch.setattr(url_safety.socket, "getaddrinfo", _fail_getaddrinfo)
    resp = _post(client, "http://does-not-resolve.kompl-test.org/")
    assert resp.status_code == 422
    assert "url_blocked" in resp.json()["detail"]


# ─── Pass-through: public URL reaches the MarkItDown layer ───────────────────


def test_public_url_passes_guard(client, monkeypatch):
    """A publicly-resolving URL must get PAST the guard and into layer 1.

    We stub _try_markitdown_url to return None and ensure no Firecrawl key,
    so the request fails later with conversion_failed — proving the 422 did
    NOT come from the SSRF guard.
    """
    _stub_dns(monkeypatch, "93.184.215.14")  # public address
    monkeypatch.setattr(conv, "_try_markitdown_url", lambda source_id, url: None)
    monkeypatch.setattr(conv, "_FIRECRAWL_API_KEY", "")

    resp = _post(client, "https://public-site.org/article")
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert "url_blocked" not in detail
    assert "conversion_failed" in detail
