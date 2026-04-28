"""Tests for services/_safe_paths."""

from __future__ import annotations

import pytest

from services._safe_paths import safe_join, validate_page_id, validate_source_id


# ─── validate_page_id / validate_source_id ──────────────────────────────────


@pytest.mark.parametrize("page_id", [
    "bitcoin",
    "saved-links",
    "page-deadbeef",
    "x",
    "0",
    "competes_with",
    "a" * 80,
])
def test_validate_page_id_accepts_valid(page_id):
    validate_page_id(page_id)


@pytest.mark.parametrize("bad", [
    "",
    "-leading-hyphen",
    "_leading-underscore",
    "UPPER",
    "with space",
    "../etc/passwd",
    "..",
    ".",
    "/abs",
    "with.dot",
    "with/slash",
    "with\\backslash",
    "a" * 81,
    "page\x00id",
])
def test_validate_page_id_rejects_invalid(bad):
    with pytest.raises(ValueError, match="invalid_page_id"):
        validate_page_id(bad)


def test_validate_page_id_rejects_non_string():
    with pytest.raises(ValueError, match="invalid_page_id"):
        validate_page_id(None)  # type: ignore[arg-type]


@pytest.mark.parametrize("source_id", [
    "550e8400-e29b-41d4-a716-446655440000",  # uuid v4
    "src-1-competes_with",
    "keep",
    "drop",
    "s1",
])
def test_validate_source_id_accepts_valid(source_id):
    validate_source_id(source_id)


def test_validate_source_id_rejects_invalid():
    with pytest.raises(ValueError, match="invalid_source_id"):
        validate_source_id("../oops")


# ─── safe_join ─────────────────────────────────────────────────────────────


def test_safe_join_relative_under_base(tmp_path):
    out = safe_join(tmp_path, "subdir/file.txt")
    assert out == (tmp_path / "subdir" / "file.txt").resolve()


def test_safe_join_rejects_traversal(tmp_path):
    with pytest.raises(ValueError, match="path_escape"):
        safe_join(tmp_path, "../outside.txt")


def test_safe_join_rejects_deep_traversal(tmp_path):
    with pytest.raises(ValueError, match="path_escape"):
        safe_join(tmp_path, "subdir/../../escape")


def test_safe_join_rejects_absolute_outside(tmp_path):
    with pytest.raises(ValueError, match="path_escape"):
        safe_join(tmp_path, "/etc/passwd")


def test_safe_join_accepts_absolute_inside(tmp_path):
    inside = str(tmp_path / "inside.txt")
    out = safe_join(tmp_path, inside)
    assert out == (tmp_path / "inside.txt").resolve()


def test_safe_join_rejects_empty():
    with pytest.raises(ValueError, match="empty_path"):
        safe_join("/data", "")


def test_safe_join_rejects_nul_byte(tmp_path):
    with pytest.raises(ValueError, match="nul_byte"):
        safe_join(tmp_path, "ok\x00.txt")
