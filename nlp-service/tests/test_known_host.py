"""nlp-service answers only to the host names Kompl's own callers use.

Regression target: there was no Host check, and the service is published on
127.0.0.1:8000. After DNS rebinding (a hostile page's name re-pointed at
127.0.0.1) the browser treats that page as same-origin with the service, so
it could call /pipeline/* (paid model calls) or /storage/write-file (any
file under /data, kompl.db included). Such a request still carries the
hostile name in its Host header; Kompl's callers never do:
  - the app: http://nlp-service:8000 (NLP_SERVICE_URL);
  - the compose healthcheck and scripts/integration-test.sh: localhost:8000;
  - nlp-service/scripts/*_replay.py: 127.0.0.1:8000.
"""

from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from services.known_host import is_known_host

# main.py imports every router; stub the keyphrase libraries routers/extraction.py
# loads at import time, as tests/test_tfidf_rank.py does.
for name in ("keybert", "rake_nltk", "yake"):
    if name not in sys.modules:
        stub = types.ModuleType(name)
        for attr in ("KeyBERT", "Rake"):
            setattr(stub, attr, MagicMock())
        sys.modules[name] = stub


def _client(host: str) -> TestClient:
    from main import app  # noqa: PLC0415
    return TestClient(app, base_url=f"http://{host}")


@pytest.mark.parametrize(
    "host",
    ["evil.test:8000", "localhost.evil.test:8000", "nlp-service.evil.test", "testserver"],
)
def test_a_rebound_host_name_is_refused_before_any_route(host):
    client = _client(host)
    for method, path in [("GET", "/health"), ("POST", "/storage/write-file"), ("POST", "/pipeline/draft-page")]:
        r = client.request(method, path, json={} if method == "POST" else None)
        assert r.status_code == 403, f"{method} {path}"
        assert r.json()["detail"].startswith("unknown_host")


@pytest.mark.parametrize(
    "host",
    ["nlp-service:8000", "localhost:8000", "LOCALHOST", "kompl.localhost", "127.0.0.1:8000", "[::1]:8000", "172.18.0.3:8000", "app", "n8n:5678"],
)
def test_kompl_callers_get_through(host):
    assert _client(host).get("/health").status_code == 200


def test_names_in_kompl_allowed_hosts_get_through(monkeypatch):
    monkeypatch.setenv("KOMPL_ALLOWED_HOSTS", " Kompl.Example.com , wiki.home:8443")
    assert _client("kompl.example.com").get("/health").status_code == 200
    assert _client("wiki.home:8443").get("/health").status_code == 200
    assert _client("other.example.com").get("/health").status_code == 403


def test_host_check_rules():
    assert is_known_host(None)  # no Host header: no browser sent it
    assert not is_known_host("")
    assert not is_known_host("evil.test")
    assert is_known_host("sub.kompl.localhost:3000")
    assert is_known_host("192.168.1.20")
