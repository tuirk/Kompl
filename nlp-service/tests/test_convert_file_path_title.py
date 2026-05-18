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

import pytest

from routers.conversion import _extract_title_from_markdown_body


# ─── Unit tests for the helper ───────────────────────────────────────────────


def test_h1_wins_over_h2_abstract():
    md = "# Attention Is All You Need\n\n## Abstract\n\nWe propose..."
    assert _extract_title_from_markdown_body(md) == "Attention Is All You Need"


def test_continues_past_rejected_h1():
    md = "# Abstract\n\n# Real Title\n\nbody"
    assert _extract_title_from_markdown_body(md) == "Real Title"


def test_skips_fenced_code_block():
    md = "```\n# not a heading\n```\n\n# Real Title\n"
    assert _extract_title_from_markdown_body(md) == "Real Title"


def test_numbered_section_label_rejected():
    assert _extract_title_from_markdown_body("# 1. Introduction\n\nbody") is None


def test_anchored_regex_no_false_reject_abstract_algebra():
    md = "# Abstract Algebra\n\nA textbook by..."
    assert _extract_title_from_markdown_body(md) == "Abstract Algebra"


def test_cap_respected_heading_beyond_4kb():
    md = ("x" * 5000) + "\n# Real Title\n"
    assert _extract_title_from_markdown_body(md) is None


@pytest.mark.parametrize("md", ["", "   \n\n  ", "\n\n\n"])
def test_empty_and_whitespace_returns_none(md):
    assert _extract_title_from_markdown_body(md) is None


def test_too_short_heading_rejected():
    assert _extract_title_from_markdown_body("# AB\n\nbody") is None


def test_h2_fallback_when_no_h1():
    assert _extract_title_from_markdown_body("## Real H2\n\nbody") == "Real H2"


def test_junk_fragment_rejects_untitled():
    assert _extract_title_from_markdown_body("# Untitled\n\nbody") is None


def test_junk_fragment_rejects_document1():
    assert _extract_title_from_markdown_body("# Document1\n\nbody") is None


def test_continues_past_two_rejected_h1s():
    md = "# Abstract\n\n# Introduction\n\n# Real Title\n"
    assert _extract_title_from_markdown_body(md) == "Real Title"


def test_h1_too_long_rejected_then_h2_used():
    long_title = "x" * 201
    md = f"# {long_title}\n\n## Good H2\n"
    assert _extract_title_from_markdown_body(md) == "Good H2"


def test_heading_with_trailing_whitespace_stripped():
    assert _extract_title_from_markdown_body("#   Spaced Title   \n") == "Spaced Title"


# End-to-end tests through /convert/file-path are added in commit 2,
# once the cascade is wired to call _extract_title_from_markdown_body.
