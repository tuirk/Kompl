"""A redirect never takes a URL fetch to an address the SSRF guard refuses.

Regression target: POST /convert/url checked only the URL it was given.
MarkItDown fetched it through _KeepBodySession, a requests.Session, which
follows redirects on its own, so a public page answering 302 to
http://169.254.169.254/ (cloud metadata), http://app:3000/api/export (the
whole wiki) or http://n8n:5678 was fetched and stored as a source. Agents
can now add links through MCP add_source, so any link they are handed
could do this.

No network: DNS (url_safety.socket.getaddrinfo) and requests' transport
(HTTPAdapter.send) are stubbed, so requests' own redirect handling runs.
"""

from __future__ import annotations

import socket

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient
from requests.structures import CaseInsensitiveDict

pytest.importorskip("markitdown")

from routers import conversion as conv  # noqa: E402
from services import url_safety  # noqa: E402
from services.http_client import HttpClientError  # noqa: E402

ARTICLE = "<html><head><title>Night trams</title></head><body><p>" + "Lisbon runs trams after midnight. " * 30 + "</p></body></html>"

# Public names resolve to a public address; Kompl's compose names to the bridge network.
_DNS = {"public-site.org": "93.184.215.14", "other-public.org": "93.184.215.15", "app": "172.18.0.2", "n8n": "172.18.0.4"}


@pytest.fixture(autouse=True)
def _dns(monkeypatch):
    def _getaddrinfo(host, port, *args, **kwargs):  # noqa: ANN002, ANN003
        if host not in _DNS:
            raise socket.gaierror("Name or service not known")
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (_DNS[host], port))]

    monkeypatch.setattr(url_safety.socket, "getaddrinfo", _getaddrinfo)


def _serve(monkeypatch, pages: dict[str, tuple[int, str | None, str]]) -> list[str]:
    """Answer every request requests sends from `pages` (url -> status,
    Location, body), below the Session's own redirect handling; returns the
    URLs fetched. A URL not in `pages` fails the test."""
    fetched: list[str] = []

    def _send(self, request, **kwargs):  # noqa: ANN001, ANN003
        fetched.append(request.url)
        assert request.url in pages, f"fetched {request.url}"
        status, location, body = pages[request.url]
        r = requests.Response()
        r.status_code = status
        r.url = request.url
        r.request = request
        r.headers = CaseInsensitiveDict({"content-type": "text/html; charset=utf-8", **({"location": location} if location else {})})
        r._content = body.encode()
        r._content_consumed = True
        return r

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", _send)
    return fetched


@pytest.fixture
def firecrawl(monkeypatch) -> list[dict]:
    """Firecrawl, configured but failing; returns the scrapes asked of it.
    A URL whose redirect was refused must not be handed to it."""
    asked: list[dict] = []

    def _post_json(**kwargs):  # noqa: ANN003
        asked.append(kwargs["json_body"])
        raise HttpClientError("stub", status_code=500, upstream_body=None)

    monkeypatch.setattr(conv, "_FIRECRAWL_API_KEY", "fc-test")
    monkeypatch.setattr(conv._firecrawl_http, "post_json", _post_json)
    return asked


@pytest.fixture
def client(firecrawl):
    app = FastAPI()
    app.include_router(conv.router)
    return TestClient(app)


@pytest.mark.parametrize(
    "target",
    [
        "http://169.254.169.254/latest/meta-data/",
        "http://app:3000/api/export",
        "http://n8n:5678/",
        "http://127.0.0.1:8000/storage/read-file",
        "file:///etc/passwd",
    ],
)
def test_a_redirect_to_a_refused_address_is_never_fetched(client, firecrawl, monkeypatch, target):
    fetched = _serve(monkeypatch, {"https://public-site.org/post": (302, target, "")})
    resp = client.post("/convert/url", json={"source_id": "src-redirect", "url": "https://public-site.org/post"})
    assert fetched == ["https://public-site.org/post"]
    assert resp.status_code == 422
    assert "url_blocked" in resp.json()["detail"]
    assert firecrawl == []


def test_a_redirect_chain_is_checked_at_every_hop(client, firecrawl, monkeypatch):
    fetched = _serve(
        monkeypatch,
        {
            "https://public-site.org/a": (301, "https://other-public.org/b", ""),
            "https://other-public.org/b": (307, "http://app:3000/api/export", ""),
        },
    )
    resp = client.post("/convert/url", json={"source_id": "src-redirect", "url": "https://public-site.org/a"})
    assert fetched == ["https://public-site.org/a", "https://other-public.org/b"]
    assert resp.status_code == 422
    assert firecrawl == []


def test_a_redirect_to_a_public_page_is_followed(monkeypatch):
    fetched = _serve(
        monkeypatch,
        {
            "https://public-site.org/old": (301, "/new", ""),
            "https://public-site.org/new": (302, "https://other-public.org/article", ""),
            "https://other-public.org/article": (200, None, ARTICLE),
        },
    )
    result = conv._try_markitdown_url("src-1", "https://public-site.org/old")
    assert result is not None and result.title == "Night trams"
    assert fetched == [
        "https://public-site.org/old",
        "https://public-site.org/new",
        "https://other-public.org/article",
    ]


def test_endless_redirects_stop(monkeypatch):
    fetched = _serve(monkeypatch, {"https://public-site.org/loop": (302, "https://public-site.org/loop", "")})
    assert conv._try_markitdown_url("src-1", "https://public-site.org/loop") is None
    assert 1 < len(fetched) <= 11
