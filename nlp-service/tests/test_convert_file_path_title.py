"""Tests for body-heading title extraction in /convert/file-path.

Phase 1 of the file-upload title-quality work: extract the first usable H1/H2
from the markdown body when MarkItDown didn't give us a title (PDFs always,
DOCX with junk core.xml titles often) and before we fall back to the
filename hint. Phase 2 (LLM fallback) is deferred until phase-1 telemetry
shows the residual filename-fallback rate justifies it.

Unit tests hit ``_extract_title_from_markdown_body`` directly.
End-to-end tests exercise the cascade through ``POST /convert/file-path``
with on-disk .md fixtures rooted at a tmp_path-monkeypatched _DATA_ROOT.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers import conversion as conv
from routers.conversion import (
    _extract_title_from_markdown_body,
    router as conversion_router,
)


# ─── Unit tests for the helper ───────────────────────────────────────────────


def test_h1_wins_over_h2_abstract():
    md = "# Attention Is All You Need\n\n## Abstract\n\nWe propose..."
    assert _extract_title_from_markdown_body(md) == (
        "Attention Is All You Need",
        "body_h1",
    )


def test_continues_past_rejected_h1():
    md = "# Abstract\n\n# Real Title\n\nbody"
    assert _extract_title_from_markdown_body(md) == ("Real Title", "body_h1")


def test_skips_fenced_code_block():
    md = "```\n# not a heading\n```\n\n# Real Title\n"
    assert _extract_title_from_markdown_body(md) == ("Real Title", "body_h1")


def test_numbered_section_label_rejected():
    assert _extract_title_from_markdown_body("# 1. Introduction\n\nbody") is None


def test_anchored_regex_no_false_reject_abstract_algebra():
    md = "# Abstract Algebra\n\nA textbook by..."
    assert _extract_title_from_markdown_body(md) == ("Abstract Algebra", "body_h1")


def test_cap_respected_heading_beyond_4kb():
    md = ("x" * 5000) + "\n# Real Title\n"
    assert _extract_title_from_markdown_body(md) is None


@pytest.mark.parametrize("md", ["", "   \n\n  ", "\n\n\n"])
def test_empty_and_whitespace_returns_none(md):
    assert _extract_title_from_markdown_body(md) is None


def test_too_short_heading_rejected():
    assert _extract_title_from_markdown_body("# AB\n\nbody") is None


def test_h2_fallback_when_no_h1():
    assert _extract_title_from_markdown_body("## Real H2\n\nbody") == (
        "Real H2",
        "body_h2",
    )


def test_junk_fragment_rejects_untitled():
    assert _extract_title_from_markdown_body("# Untitled\n\nbody") is None


def test_junk_fragment_rejects_document1():
    assert _extract_title_from_markdown_body("# Document1\n\nbody") is None


def test_continues_past_two_rejected_h1s():
    md = "# Abstract\n\n# Introduction\n\n# Real Title\n"
    assert _extract_title_from_markdown_body(md) == ("Real Title", "body_h1")


def test_h1_too_long_rejected_then_h2_used():
    long_title = "x" * 201
    md = f"# {long_title}\n\n## Good H2\n"
    assert _extract_title_from_markdown_body(md) == ("Good H2", "body_h2")


def test_heading_with_trailing_whitespace_stripped():
    assert _extract_title_from_markdown_body("#   Spaced Title   \n") == (
        "Spaced Title",
        "body_h1",
    )


# ─── End-to-end tests through /convert/file-path ─────────────────────────────


@pytest.fixture
def client(tmp_path, monkeypatch):
    # _DATA_ROOT controls safe_join; pointing it at tmp_path lets us stage
    # fixture files under a real tmpdir without needing /data to exist.
    monkeypatch.setattr(conv, "_DATA_ROOT", Path(tmp_path))
    app = FastAPI()
    app.include_router(conversion_router)
    return TestClient(app), tmp_path


def _write_md(root: Path, relpath: str, content: str) -> str:
    p = root / relpath
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return relpath


def test_e2e_md_h1_wins_over_filename(client, caplog):
    tc, root = client
    rel = _write_md(
        root,
        "junk_filename.md",
        "# Attention Is All You Need\n\n## Abstract\n\nWe propose...",
    )
    with caplog.at_level("INFO", logger="routers.conversion"):
        res = tc.post(
            "/convert/file-path",
            json={
                "source_id": "src-1",
                "file_path": rel,
                "title_hint": "junk_filename",
            },
        )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["title"] == "Attention Is All You Need"
    assert body["title_source"] == "body_h1"
    assert any("title_source=body_h1" in r.message for r in caplog.records)
    assert any("source_id=src-1" in r.message for r in caplog.records)


def test_e2e_md_h1_beats_junk_filename(client):
    tc, root = client
    rel = _write_md(root, "Document1.md", "# Q3 Roadmap\n\nbody")
    res = tc.post(
        "/convert/file-path",
        json={
            "source_id": "src-2",
            "file_path": rel,
            "title_hint": "Document1",
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["title"] == "Q3 Roadmap"
    assert body["title_source"] == "body_h1"


def test_e2e_no_h1_falls_through_to_hint(client, caplog):
    tc, root = client
    rel = _write_md(root, "real_doc.md", "Just body text, no headings here.\n")
    with caplog.at_level("INFO", logger="routers.conversion"):
        res = tc.post(
            "/convert/file-path",
            json={
                "source_id": "src-3",
                "file_path": rel,
                "title_hint": "real_doc",
            },
        )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["title"] == "real_doc"
    assert body["title_source"] == "filename"
    assert any("title_source=filename" in r.message for r in caplog.records)


def test_convert_response_requires_title_source():
    # Pydantic extra='forbid' + Literal: missing title_source MUST raise,
    # invalid value MUST raise. Guards against a future refactor that drops
    # the field or accepts arbitrary strings (rule #2 — strict contracts).
    from pydantic import ValidationError
    from routers.conversion import ConvertResponse, ContentMetadata

    base_kwargs = dict(
        source_id="x",
        source_type="file",
        title="t",
        source_url=None,
        markdown="md",
        content_hash="abc",
        metadata=ContentMetadata(),
    )

    # Missing title_source → ValidationError
    with pytest.raises(ValidationError):
        ConvertResponse(**base_kwargs)

    # Invalid title_source → ValidationError
    with pytest.raises(ValidationError):
        ConvertResponse(**base_kwargs, title_source="not_a_real_value")

    # All valid values construct cleanly
    for ts in (
        "markitdown", "body_h1", "body_h2", "filename", "stem",
        "firecrawl", "firecrawl_url_fallback", "github_api", "youtube_oembed",
    ):
        ConvertResponse(**base_kwargs, title_source=ts)


def test_e2e_rejected_h1_falls_through_to_hint(client):
    tc, root = client
    rel = _write_md(root, "scan_2023.md", "# Abstract\n\nThis is a paper.\n")
    res = tc.post(
        "/convert/file-path",
        json={
            "source_id": "src-4",
            "file_path": rel,
            "title_hint": "scan_2023",
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    # Body H1 "Abstract" is rejected as section-label; cascade falls through
    # to title_hint (filename). This is the case phase 2 LLM titling would
    # address; phase 1 acknowledges it as a known limit.
    assert body["title"] == "scan_2023"
    assert body["title_source"] == "filename"
