"""Conversion reports a source's publication date from its own metadata
(plan 3.2, D5): YouTube's publishedAt, a repo's last push, the HTML a
MarkItDown fetch read (without fetching twice), Firecrawl's meta tags, an
uploaded file's metadata. No network: every fetch is stubbed.
"""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("markitdown")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from routers import conversion as conv  # noqa: E402

PAGE = (
    "<html><head><title>Night trams</title>"
    '<meta property="article:published_time" content="2024-03-05T08:00:00Z">'
    "</head><body><h1>Night trams</h1><p>" + "Lisbon runs trams after midnight. " * 30 + "</p></body></html>"
)


class _Response:
    def __init__(self, body: bytes, content_type: str, url: str) -> None:
        self.content = body
        self.headers = {"content-type": content_type}
        self.url = url
        self.status_code = 200
        self._content_consumed = True

    def raise_for_status(self) -> None:
        return None

    def iter_content(self, chunk_size: int = 512):
        for i in range(0, len(self.content), chunk_size):
            yield self.content[i:i + chunk_size]


def _stub_fetch(monkeypatch, body: bytes, content_type: str) -> list[dict]:
    """requests.Session.get answering `body`; returns the calls made."""
    calls: list[dict] = []

    def _get(self, url, **kwargs):
        calls.append({"url": url, **kwargs})
        return _Response(body, content_type, url)

    monkeypatch.setattr("requests.Session.get", _get)
    return calls


def test_a_markitdown_page_carries_its_meta_date_from_the_same_fetch(monkeypatch):
    calls = _stub_fetch(monkeypatch, PAGE.encode(), "text/html; charset=utf-8")
    result = conv._try_markitdown_url("src-1", "https://example.com/trams")
    assert result is not None
    assert (result.published_at, result.published_at_source) == ("2024-03-05", "page_published")
    assert len(calls) == 1  # one fetch serves the text and the date
    assert calls[0]["stream"] is False


def test_a_page_without_dates_or_not_html_has_none(monkeypatch):
    _stub_fetch(monkeypatch, PAGE.replace("article:published_time", "og:site").encode(), "text/html")
    result = conv._try_markitdown_url("src-1", "https://example.com/trams")
    assert result is not None and result.published_at is None and result.published_at_source is None
    _stub_fetch(monkeypatch, ("Plain words. " * 60).encode(), "text/plain")
    result = conv._try_markitdown_url("src-1", "https://example.com/notes.txt")
    assert result is not None and result.published_at is None


def test_firecrawl_meta_tags_give_the_date(monkeypatch):
    monkeypatch.setattr(conv, "_try_markitdown_url", lambda source_id, url: None)
    monkeypatch.setattr(conv, "_FIRECRAWL_API_KEY", "fc-test")
    monkeypatch.setattr(conv, "validate_outbound_url", lambda url: None)
    monkeypatch.setattr(conv._firecrawl_http, "post_json", lambda **kw: {
        "success": True,
        "data": {
            "markdown": "# Night trams\n\nText.",
            "metadata": {"title": "Night trams", "url": "https://example.com/t", "publishedTime": "2023-11-02T15:00:00Z"},
        },
    })
    result = conv.convert_url(conv.UrlConvertRequest(source_id="src-1", url="https://example.com/t"))
    assert (result.published_at, result.published_at_source) == ("2023-11-02", "page_published")


def test_youtube_uses_its_published_at(monkeypatch):
    monkeypatch.setattr(conv, "_fetch_youtube_transcript", lambda vid: ([{"text": "hello"}], "en"))
    monkeypatch.setattr(conv, "_fetch_youtube_metadata", lambda vid: {
        "title": "Talk", "channel": "C", "published_at": "2023-11-02T15:00:00Z",
        "description": None, "duration": None, "language": "en",
    })
    result = conv._convert_youtube("src-1", "https://www.youtube.com/watch?v=Ub3GoFaUcds")
    assert (result.published_at, result.published_at_source) == ("2023-11-02", "youtube")


def test_a_github_readme_is_dated_by_the_last_push(monkeypatch):
    class _R:
        def __init__(self, status: int, payload=None, text: str = "") -> None:
            self.status_code, self._payload, self.text = status, payload, text

        def json(self):
            return self._payload

    def _get(self, url, headers=None):
        if url.endswith("/readme"):
            return _R(200, text="# Readme")
        return _R(200, {"full_name": "o/r", "created_at": "2015-01-01T00:00:00Z", "pushed_at": "2024-02-10T12:00:00Z"})

    monkeypatch.setattr("httpx.Client.get", _get)
    result = conv._convert_github_repo("src-1", "https://github.com/o/r", "o", "r")
    assert result is not None
    assert (result.published_at, result.published_at_source) == ("2024-02-10", "github_push")


def test_an_uploaded_file_carries_its_metadata_date(tmp_path, monkeypatch):
    monkeypatch.setattr(conv, "_DATA_ROOT", Path(tmp_path))
    (tmp_path / "saved.html").write_text(PAGE, encoding="utf-8")
    (tmp_path / "note.md").write_text("# Note\n\nPublished March 5, 2024.", encoding="utf-8")
    app = FastAPI()
    app.include_router(conv.router)
    tc = TestClient(app)

    dated = tc.post("/convert/file-path", json={"source_id": "s1", "file_path": "saved.html"}).json()
    assert (dated["published_at"], dated["published_at_source"]) == ("2024-03-05", "page_published")
    # A date in the text is the app's fallback, not file metadata.
    plain = tc.post("/convert/file-path", json={"source_id": "s2", "file_path": "note.md"}).json()
    assert plain["published_at"] is None and plain["published_at_source"] is None
