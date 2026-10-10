"""Version-preserving wiki page storage for Kompl v2 nlp-service (commit 4).

Architecture rule #4 (CLAUDE.md): any function that overwrites a content file
MUST first move the existing file to a versioned name. This module is the
canonical implementation of that rule for wiki pages.

write_page(page_id, markdown) contract:
  - If /data/pages/{page_id}.md.gz exists: move it to
    /data/pages/{page_id}.{timestamp}.md.gz before writing the new content.
  - Write new gzip-compressed content to /data/pages/{page_id}.md.gz atomically
    (write to .tmp.gz in same directory, then os.replace onto final path).
  - After the new version is in place, keep only the newest
    MAX_ARCHIVED_VERSIONS archives of that page; older ones are deleted.
    Pages that are never rewritten keep whatever archives they have.
  - Returns (current_path, previous_path | None).

Atomic write guarantee: the tmp file lives in _PAGES_DIR (same filesystem as
the target) so os.replace() is a single rename(2) syscall — never a partial
write is visible at the final path. The tmp file is cleaned up on any error.

This module NEVER opens kompl.db. rule #1 in CLAUDE.md: kompl.db is held by
the Next.js process exclusively.
"""

from __future__ import annotations

import gzip
import logging
import os
import re
import tempfile
import time
from pathlib import Path

from services._safe_paths import safe_join, validate_page_id

_DATA_ROOT = "/data"
_PAGES_DIR = os.path.join(_DATA_ROOT, "pages")

# Previous versions kept per page (owner decision, 2026-10-10): the latest one
# backs "View previous version" / "Restore this version", and one more allows a
# second undo. Older archives are deleted when the page is next written.
MAX_ARCHIVED_VERSIONS = 2

logger = logging.getLogger(__name__)


def write_page(page_id: str, markdown: str) -> tuple[str, str | None]:
    """Write a wiki page to gzip-compressed storage with version preservation.

    The write is atomic: content is written to a sibling .tmp.gz file in the
    same directory, then os.replace() renames it onto the final path. A crash
    mid-write leaves only the .tmp.gz (which is cleaned up), never a corrupt
    or truncated final file.

    Args:
        page_id:  URL-safe page identifier (e.g. "bitcoin-abc12345")
        markdown: Compiled markdown content for this page version

    Returns:
        (current_path, previous_path)
        current_path  — absolute path to the newly written file
        previous_path — absolute path to the archived previous version, or None
                        if this is the first version of the page

    Raises:
        ValueError — if page_id fails the slug regex or the resulting path
                     escapes _PAGES_DIR (defence-in-depth on top of the regex)
        OSError    — if the directory cannot be created or files cannot be
                     moved/written
    """
    validate_page_id(page_id)
    os.makedirs(_PAGES_DIR, exist_ok=True)

    current_path = str(safe_join(_PAGES_DIR, f"{page_id}.md.gz"))
    previous_path: str | None = None

    # Version archive — atomically move existing file before overwriting.
    # os.replace() is used instead of shutil.move() for clarity; both are
    # atomic on POSIX when source and dest are on the same filesystem.
    # Microsecond suffix on the timestamp prevents collisions when the same
    # page_id is rewritten 3+ times within one wall-clock second (the
    # second-resolution format used to silently overwrite the second archive).
    if os.path.exists(current_path):
        mtime = os.stat(current_path).st_mtime
        ts = time.strftime("%Y%m%d-%H%M%S", time.gmtime(mtime))
        usec = int((mtime - int(mtime)) * 1_000_000)
        previous_path = str(safe_join(_PAGES_DIR, f"{page_id}.{ts}-{usec:06d}.md.gz"))
        os.replace(current_path, previous_path)

    # Atomic write: write to .tmp.gz in the same directory (same filesystem),
    # then os.replace() onto the final path. dir=_PAGES_DIR is required —
    # /tmp is a separate tmpfs in Docker and would cause EXDEV on rename.
    content_bytes = markdown.encode("utf-8")
    tmp_fd, tmp_path = tempfile.mkstemp(dir=_PAGES_DIR, suffix=".tmp.gz")
    try:
        with os.fdopen(tmp_fd, "wb") as raw:
            with gzip.GzipFile(fileobj=raw, mode="wb") as gz:
                gz.write(content_bytes)
        # Both handles fully closed above — gzip trailer is flushed.
        os.replace(tmp_path, current_path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

    # Only after the new version is safely written: trim old archives. A
    # failed trim never fails the write.
    try:
        prune_archives(page_id)
    except OSError as exc:
        logger.warning("could not trim archives of %s: %s", page_id, exc)

    return current_path, previous_path


def prune_archives(page_id: str, keep: int = MAX_ARCHIVED_VERSIONS) -> list[str]:
    """Delete all but the newest `keep` archived versions of one page.

    Archive names are {page_id}.{YYYYMMDD-HHMMSS}[-{usec}].md.gz; page ids are
    slugs without dots, so the pattern can't match another page's files.
    Returns the deleted file names.
    """
    validate_page_id(page_id)
    if keep < 1 or not os.path.isdir(_PAGES_DIR):
        return []
    pattern = re.compile(rf"^{re.escape(page_id)}\.(\d{{8}}-\d{{6}}(?:-\d{{6}})?)\.md\.gz$")
    archives = sorted(
        (match.group(1), entry.name)
        for entry in os.scandir(_PAGES_DIR)
        if entry.is_file() and (match := pattern.match(entry.name))
    )
    removed: list[str] = []
    for _stamp, name in archives[:-keep]:
        os.unlink(str(safe_join(_PAGES_DIR, name)))
        removed.append(name)
    return removed


def read_page(page_id: str) -> str | None:
    """Read and decompress a wiki page. Returns None if the file does not exist."""
    validate_page_id(page_id)
    current_path = str(safe_join(_PAGES_DIR, f"{page_id}.md.gz"))
    if not os.path.exists(current_path):
        return None
    with gzip.open(current_path, "rb") as f:
        return f.read().decode("utf-8")
