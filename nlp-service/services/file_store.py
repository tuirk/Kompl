"""Version-preserving wiki page storage for Kompl v2 nlp-service (commit 4).

Architecture rule #4 (CLAUDE.md): any function that overwrites a content file
MUST first move the existing file to a versioned name. This module is the
canonical implementation of that rule for wiki pages.

write_page(page_id, markdown) contract:
  - If /data/pages/{page_id}.md.gz already holds exactly this text, nothing is
    written or archived (the outbox can flush one page more than once).
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
The tmp file is fsynced before the rename and the directory after it, so a
power loss can't leave an empty page file or undo the rename once the caller
has been told the write succeeded (and has cleared its outbox row).

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
import zlib
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
    content_bytes = markdown.encode("utf-8")

    # Same text as the current file: nothing to write and nothing to archive.
    # A retry, the commit reconcile pass and the boot reconciler can all flush
    # the same page; archiving an identical copy each time would push the real
    # previous versions out of the MAX_ARCHIVED_VERSIONS window.
    if _current_content_equals(current_path, content_bytes):
        archives = _archive_names(page_id)
        newest = str(safe_join(_PAGES_DIR, archives[-1])) if archives else None
        return current_path, newest

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
    tmp_fd, tmp_path = tempfile.mkstemp(dir=_PAGES_DIR, suffix=".tmp.gz")
    try:
        with os.fdopen(tmp_fd, "wb") as raw:
            with gzip.GzipFile(fileobj=raw, mode="wb") as gz:
                gz.write(content_bytes)
            # gzip trailer written; push the bytes to disk before the rename
            # makes them the page.
            raw.flush()
            os.fsync(raw.fileno())
        os.replace(tmp_path, current_path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise

    # Persist the renames (archive and new file) in the directory entry.
    _fsync_dir(_PAGES_DIR)

    # Only after the new version is safely written: trim old archives. A
    # failed trim never fails the write.
    try:
        prune_archives(page_id)
    except OSError as exc:
        logger.warning("could not trim archives of %s: %s", page_id, exc)

    return current_path, previous_path


def prune_archives(page_id: str, keep: int = MAX_ARCHIVED_VERSIONS) -> list[str]:
    """Delete all but the newest `keep` archived versions of one page.

    Returns the deleted file names.
    """
    validate_page_id(page_id)
    if keep < 1:
        return []
    removed: list[str] = []
    for name in _archive_names(page_id)[:-keep]:
        os.unlink(str(safe_join(_PAGES_DIR, name)))
        removed.append(name)
    return removed


def _archive_names(page_id: str) -> list[str]:
    """File names of one page's archived versions, oldest first.

    Archive names are {page_id}.{YYYYMMDD-HHMMSS}[-{usec}].md.gz; page ids are
    slugs without dots, so the pattern can't match another page's files.
    """
    if not os.path.isdir(_PAGES_DIR):
        return []
    pattern = re.compile(rf"^{re.escape(page_id)}\.(\d{{8}}-\d{{6}}(?:-\d{{6}})?)\.md\.gz$")
    archives = sorted(
        (match.group(1), entry.name)
        for entry in os.scandir(_PAGES_DIR)
        if entry.is_file() and (match := pattern.match(entry.name))
    )
    return [name for _stamp, name in archives]


def _current_content_equals(path: str, content_bytes: bytes) -> bool:
    """True when the page file at `path` already holds exactly these bytes.

    A missing or unreadable file never matches, so it is archived and
    replaced as before.
    """
    try:
        with gzip.open(path, "rb") as f:
            return f.read() == content_bytes
    except FileNotFoundError:
        return False
    except (OSError, EOFError, zlib.error) as exc:
        logger.warning("could not read %s to compare it: %s", path, exc)
        return False


def _fsync_dir(path: str) -> None:
    """Flush a directory's entries (the renames in it) to disk.

    POSIX only: Windows can't open a directory for fsync, and the service
    runs on Linux in Docker.
    """
    if os.name != "posix":
        return
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read_page(page_id: str) -> str | None:
    """Read and decompress a wiki page. Returns None if the file does not exist."""
    validate_page_id(page_id)
    current_path = str(safe_join(_PAGES_DIR, f"{page_id}.md.gz"))
    if not os.path.exists(current_path):
        return None
    with gzip.open(current_path, "rb") as f:
        return f.read().decode("utf-8")
