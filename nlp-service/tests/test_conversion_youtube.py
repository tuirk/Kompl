"""Tests for the YouTube branch of /convert/url (routers/conversion.py).

These tests do NOT hit the network. youtube-transcript-api and HttpClient.get_json
are monkeypatched so we can assert the transcript-vs-no-transcript and
metadata-vs-no-metadata branches without flakiness or quota use.

Coverage:
  - happy path: transcript + Data API metadata both succeed → 200 with full markdown
  - missing transcript → 422 youtube_no_transcript
  - missing API key → 422 youtube_metadata_unavailable
  - Data API HTTP error → 422 youtube_metadata_unavailable
  - URL-form variants (watch, youtu.be, shorts, embed, m., music.) all extract
    the same video ID and route through _convert_youtube

The five cases above are the bug surfaces uncovered in session 4a00f339-...
where MarkItDown's HTML-scrape fallback for transcript-less YouTube URLs
returned 801 chars of footer chrome and silently passed the quality gate.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers import conversion as conv
from routers.conversion import (
    _extract_youtube_video_id,
    router as conversion_router,
)
from services.http_client import HttpClientError


# ─── Test client ─────────────────────────────────────────────────────────────


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(conversion_router)
    return TestClient(app)


# ─── Stubs for youtube-transcript-api ────────────────────────────────────────


class _StubTranscript:
    def __init__(self, segments: list[dict[str, Any]], language_code: str = "en", is_generated: bool = False) -> None:
        self._segments = segments
        self.language_code = language_code
        self.is_generated = is_generated

    def fetch(self) -> list[dict[str, Any]]:
        return self._segments


class _StubTranscriptList:
    """Iterable wrapper matching the youtube-transcript-api TranscriptList shape
    that our code consumes (iterates + `is_generated` per item)."""

    def __init__(self, transcripts: list[_StubTranscript]) -> None:
        self._transcripts = transcripts

    def __iter__(self):
        return iter(self._transcripts)


def _stub_transcript_api(monkeypatch, *, segments=None, raise_class=None):
    """Patch youtube-transcript-api.YouTubeTranscriptApi.list_transcripts to
    return a stubbed transcript list or raise a given exception class.

    Imports inside the patched module so we don't pull the real package's
    network side effects into test collection. The real exception classes are
    imported via the same path our helper uses.
    """
    from youtube_transcript_api import YouTubeTranscriptApi

    if raise_class is not None:
        def _raise(_video_id):  # noqa: ARG001 - signature match
            # Most exception classes in this package take a video_id arg; others
            # need (video_id, language_codes). Construct defensively.
            try:
                raise raise_class(_video_id)
            except TypeError:
                raise raise_class(_video_id, [], None)
        monkeypatch.setattr(YouTubeTranscriptApi, "list_transcripts", _raise)
        return

    transcripts = [_StubTranscript(segments or [{"text": "hello world", "start": 0.0, "duration": 2.0}])]
    monkeypatch.setattr(
        YouTubeTranscriptApi,
        "list_transcripts",
        lambda _video_id: _StubTranscriptList(transcripts),
    )


def _stub_data_api(monkeypatch, *, payload=None, raises: HttpClientError | None = None, api_key: str = "fake-key"):
    """Patch the module-level _YOUTUBE_API_KEY and HttpClient.get_json to control
    the Data API v3 response. payload=None means "no items"."""
    monkeypatch.setattr(conv, "_YOUTUBE_API_KEY", api_key)

    if raises is not None:
        def _raise(*_args, **_kw):
            raise raises
        monkeypatch.setattr(conv._http, "get_json", _raise)
        return

    response = payload if payload is not None else {"items": []}
    monkeypatch.setattr(conv._http, "get_json", lambda *_args, **_kw: response)


def _data_api_response(title="Stub Title", channel="Stub Channel"):
    return {
        "items": [
            {
                "snippet": {
                    "title": title,
                    "channelTitle": channel,
                    "publishedAt": "2024-01-15T12:00:00Z",
                    "description": "A stub description.",
                    "defaultLanguage": "en",
                },
                "contentDetails": {"duration": "PT1H23M45S"},
            }
        ]
    }


# ─── Video ID extraction — covers all 6 URL forms ────────────────────────────


@pytest.mark.parametrize(
    "url,expected_id",
    [
        ("https://www.youtube.com/watch?v=Ub3GoFaUcds", "Ub3GoFaUcds"),
        ("http://youtube.com/watch?v=Ub3GoFaUcds&t=42", "Ub3GoFaUcds"),
        ("https://youtu.be/Ub3GoFaUcds?si=BOq4ehRCLJlK_liX", "Ub3GoFaUcds"),
        ("https://m.youtube.com/watch?v=Ub3GoFaUcds", "Ub3GoFaUcds"),
        ("https://music.youtube.com/watch?v=Ub3GoFaUcds", "Ub3GoFaUcds"),
        ("https://www.youtube.com/shorts/Ub3GoFaUcds", "Ub3GoFaUcds"),
        ("https://www.youtube.com/embed/Ub3GoFaUcds", "Ub3GoFaUcds"),
        ("https://www.youtube.com/v/Ub3GoFaUcds", "Ub3GoFaUcds"),
    ],
)
def test_extract_video_id_supported_forms(url, expected_id):
    assert _extract_youtube_video_id(url) == expected_id


@pytest.mark.parametrize(
    "url",
    [
        "https://www.youtube.com/playlist?list=PL...",   # playlist, no video
        "https://www.youtube.com/channel/UCabc",          # channel page
        "https://www.youtube.com/@SomeChannel",           # @-handle
        "https://www.youtube.com/watch",                  # missing v= param
        "https://youtu.be/short",                         # not 11 chars
        "https://example.com/watch?v=Ub3GoFaUcds",        # wrong host
    ],
)
def test_extract_video_id_rejects_non_video_urls(url):
    assert _extract_youtube_video_id(url) is None


# ─── /convert/url: happy path ────────────────────────────────────────────────


def test_youtube_happy_path(monkeypatch, client):
    _stub_transcript_api(
        monkeypatch,
        segments=[
            {"text": "Hello", "start": 0.0, "duration": 1.0},
            {"text": "world.", "start": 1.0, "duration": 1.0},
        ],
    )
    _stub_data_api(monkeypatch, payload=_data_api_response(title="My Lecture", channel="My Channel"))

    res = client.post(
        "/convert/url",
        json={"source_id": "src-1", "url": "https://youtu.be/Ub3GoFaUcds"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["title"] == "My Lecture"
    assert body["source_type"] == "url"
    assert body["source_url"] == "https://youtu.be/Ub3GoFaUcds"
    assert body["metadata"]["description"] == "A stub description."
    assert body["metadata"]["language"] == "en"
    # markdown shape: heading, channel + meta lines, then the transcript section
    md = body["markdown"]
    assert md.startswith("# My Lecture")
    assert "**Channel:** My Channel" in md
    assert "**Published:** 2024-01-15T12:00:00Z" in md
    assert "**Duration:** PT1H23M45S" in md
    assert "## Transcript" in md
    assert "Hello world." in md


# ─── /convert/url: transcript missing ────────────────────────────────────────


def test_youtube_no_transcript(monkeypatch, client):
    from youtube_transcript_api._errors import NoTranscriptFound
    _stub_transcript_api(monkeypatch, raise_class=NoTranscriptFound)
    # Data API stubs should NOT be hit; if they were, the test would still pass
    # but we want to be explicit that the failure happens before metadata fetch.
    monkeypatch.setattr(conv, "_YOUTUBE_API_KEY", "fake-key")

    res = client.post(
        "/convert/url",
        json={"source_id": "src-2", "url": "https://youtu.be/Ub3GoFaUcds"},
    )
    assert res.status_code == 422
    assert res.json()["detail"] == "youtube_no_transcript"


def test_youtube_transcripts_disabled(monkeypatch, client):
    from youtube_transcript_api._errors import TranscriptsDisabled
    _stub_transcript_api(monkeypatch, raise_class=TranscriptsDisabled)

    res = client.post(
        "/convert/url",
        json={"source_id": "src-3", "url": "https://www.youtube.com/watch?v=Ub3GoFaUcds"},
    )
    assert res.status_code == 422
    assert res.json()["detail"] == "youtube_no_transcript"


def test_youtube_fetch_raises_unexpected_exception(monkeypatch, client):
    """list_transcripts() SUCCEEDS (captions exist) but fetch() raises bare
    xml.etree.ElementTree.ParseError because YouTube returned an empty body —
    the cloud-IP / bot-detection fingerprint. Must surface as the distinct
    `youtube_transcript_blocked` code (NOT youtube_no_transcript) so the app
    can show a workaround-specific message. Observed live on session smoke
    test `youtu.be/Ub3GoFaUcds` and again on `Q7Ryv1M7CvI` (2026-05-18)."""
    import xml.etree.ElementTree as ET
    from youtube_transcript_api import YouTubeTranscriptApi

    class _BadTranscript:
        is_generated = False
        language_code = "en"
        def fetch(self):
            raise ET.ParseError("no element found: line 1, column 0")

    monkeypatch.setattr(
        YouTubeTranscriptApi,
        "list_transcripts",
        lambda _vid: _StubTranscriptList([_BadTranscript()]),
    )

    res = client.post(
        "/convert/url",
        json={"source_id": "src-empty-xml", "url": "https://youtu.be/Ub3GoFaUcds"},
    )
    assert res.status_code == 422
    assert res.json()["detail"] == "youtube_transcript_blocked"


# ─── /convert/url: metadata missing ──────────────────────────────────────────


def test_youtube_no_api_key(monkeypatch, client):
    """Transcript succeeds but YOUTUBE_API_KEY is unset → 422 metadata_unavailable."""
    _stub_transcript_api(monkeypatch)
    monkeypatch.setattr(conv, "_YOUTUBE_API_KEY", "")

    res = client.post(
        "/convert/url",
        json={"source_id": "src-4", "url": "https://youtu.be/Ub3GoFaUcds"},
    )
    assert res.status_code == 422
    assert res.json()["detail"] == "youtube_metadata_unavailable"


def test_youtube_data_api_http_error(monkeypatch, client):
    _stub_transcript_api(monkeypatch)
    _stub_data_api(
        monkeypatch,
        raises=HttpClientError(
            message="HTTP 403 from googleapis",
            status_code=403,
            upstream_body='{"error": "quota"}',
        ),
    )

    res = client.post(
        "/convert/url",
        json={"source_id": "src-5", "url": "https://youtu.be/Ub3GoFaUcds"},
    )
    assert res.status_code == 422
    assert res.json()["detail"] == "youtube_metadata_unavailable"


def test_youtube_data_api_empty_items(monkeypatch, client):
    """Video deleted / private — Data API returns 200 with no items."""
    _stub_transcript_api(monkeypatch)
    _stub_data_api(monkeypatch, payload={"items": []})

    res = client.post(
        "/convert/url",
        json={"source_id": "src-6", "url": "https://youtu.be/Ub3GoFaUcds"},
    )
    assert res.status_code == 422
    assert res.json()["detail"] == "youtube_metadata_unavailable"


# ─── /convert/url: regex coverage routes all forms through _convert_youtube ──


@pytest.mark.parametrize(
    "url",
    [
        "https://www.youtube.com/watch?v=Ub3GoFaUcds",
        "https://youtu.be/Ub3GoFaUcds",
        "https://m.youtube.com/watch?v=Ub3GoFaUcds",
        "https://music.youtube.com/watch?v=Ub3GoFaUcds",
        "https://www.youtube.com/shorts/Ub3GoFaUcds",
        "https://www.youtube.com/embed/Ub3GoFaUcds",
    ],
)
def test_youtube_url_forms_route_to_youtube_path(monkeypatch, client, url):
    """Every supported form should hit _convert_youtube — confirm by stubbing
    transcript-api to raise so we get a 422 youtube_no_transcript. If the URL
    fell through to MarkItDown/Firecrawl we'd see a different status code or
    a hit on the real network, neither of which is acceptable."""
    from youtube_transcript_api._errors import NoTranscriptFound
    _stub_transcript_api(monkeypatch, raise_class=NoTranscriptFound)

    # Guard against accidental fall-through: if anything tries to invoke
    # MarkItDown, fail loudly. We patch _try_markitdown_url to raise so a
    # regression on the routing branch surfaces clearly.
    def _markitdown_must_not_be_called(*_args, **_kw):
        raise AssertionError("MarkItDown was invoked for a YouTube URL — routing regression")
    monkeypatch.setattr(conv, "_try_markitdown_url", _markitdown_must_not_be_called)

    res = client.post("/convert/url", json={"source_id": "src-r", "url": url})
    assert res.status_code == 422
    assert res.json()["detail"] == "youtube_no_transcript"
