"""Tests for nlp-service/services/file_store.py — write_page() / read_page().

write_page is the canonical implementation of CLAUDE.md architecture rule #4
(version-preserving wiki page writes). It must:
  - Atomically write new content to {page_id}.md.gz
  - Archive any existing file to {page_id}.{timestamp}.md.gz BEFORE overwriting
  - Return (current_path, previous_path|None) so the caller can update DB rows
  - Clean up the temporary write file on failure
"""

from __future__ import annotations

import gzip
import os
from pathlib import Path

import pytest

from services import file_store


@pytest.fixture
def isolated_pages_dir(tmp_path, monkeypatch):
    """Redirect _PAGES_DIR at the module so writes land under pytest tmp_path."""
    pages_dir = tmp_path / "pages"
    pages_dir.mkdir()
    monkeypatch.setattr(file_store, "_PAGES_DIR", str(pages_dir))
    return pages_dir


def _read_gz(path: str | Path) -> str:
    with gzip.open(str(path), "rb") as f:
        return f.read().decode("utf-8")


def test_first_write_creates_file_and_returns_no_previous(isolated_pages_dir):
    current, previous = file_store.write_page("bitcoin", "# Bitcoin\nFirst version.")

    assert previous is None
    assert current == str(isolated_pages_dir / "bitcoin.md.gz")
    assert os.path.exists(current)
    assert _read_gz(current) == "# Bitcoin\nFirst version."


def test_overwrite_archives_existing_file_to_timestamped_path(isolated_pages_dir):
    current_v1, _ = file_store.write_page("bitcoin", "v1 content")

    # Backdate the file by ~5 seconds so v2's timestamp differs from v1's.
    # write_page uses os.stat(current).st_mtime to build the archive name.
    older = os.path.getmtime(current_v1) - 5
    os.utime(current_v1, (older, older))

    current_v2, previous = file_store.write_page("bitcoin", "v2 content")

    assert current_v2 == current_v1, "current path is stable across writes"
    assert previous is not None and previous != current_v1
    assert os.path.exists(previous), "archived previous version must exist on disk"
    assert os.path.exists(current_v2), "new current must exist on disk"

    assert _read_gz(current_v2) == "v2 content"
    assert _read_gz(previous) == "v1 content", "previous path holds the OLD content"

    # Archive name uses the stat-based timestamp pattern: {page_id}.{ts}.md.gz
    name = os.path.basename(previous)
    assert name.startswith("bitcoin.") and name.endswith(".md.gz")


def test_multiple_overwrites_preserve_each_historical_version(isolated_pages_dir):
    current, _ = file_store.write_page("ethereum", "v1")
    archives: list[str] = []

    for v, label in enumerate(["v2", "v3", "v4"], start=1):
        # Backdate by an offset unique to each iteration so archive names differ.
        # (Without this, three writes within one second would all stat-down to the
        # same mtime → same archive name → os.replace would clobber prior archives.)
        backdate = os.path.getmtime(current) - (v * 5)
        os.utime(current, (backdate, backdate))
        _, previous = file_store.write_page("ethereum", label)
        assert previous is not None
        archives.append(previous)

    # Three distinct archive paths means each historical version was preserved.
    assert len(set(archives)) == 3
    for arch in archives:
        assert os.path.exists(arch)

    # Latest current holds the most recent write.
    assert _read_gz(current) == "v4"


def test_read_page_returns_decompressed_content(isolated_pages_dir):
    file_store.write_page("solana", "Solana page body.")
    assert file_store.read_page("solana") == "Solana page body."


def test_read_page_returns_none_for_missing_file(isolated_pages_dir):
    assert file_store.read_page("does-not-exist") is None


def test_tmp_files_are_cleaned_up_after_successful_write(isolated_pages_dir):
    file_store.write_page("cardano", "content")
    leftover = [p for p in os.listdir(isolated_pages_dir) if p.endswith(".tmp.gz")]
    assert leftover == [], f"unexpected tmp files: {leftover}"


def test_creates_pages_directory_if_missing(tmp_path, monkeypatch):
    # _PAGES_DIR points to a path that does NOT exist yet — write_page must mkdir.
    pages_dir = tmp_path / "fresh" / "pages"
    monkeypatch.setattr(file_store, "_PAGES_DIR", str(pages_dir))
    assert not pages_dir.exists()

    current, previous = file_store.write_page("first", "hello")
    assert previous is None
    assert os.path.exists(current)
