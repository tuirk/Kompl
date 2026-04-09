"""Version-preserving wiki page storage for Kompl v2 nlp-service (commit 4).

Architecture rule #4 (CLAUDE.md): any function that overwrites a content file
MUST first move the existing file to a versioned name. This module is the
canonical implementation of that rule for wiki pages.

write_page(page_id, markdown) contract:
  - If /data/pages/{page_id}.md.gz exists: move it to
    /data/pages/{page_id}.{timestamp}.md.gz before writing the new content.
  - Write new gzip-compressed content to /data/pages/{page_id}.md.gz.
  - Returns (current_path, previous_path | None).

This module NEVER opens kompl.db. rule #1 in CLAUDE.md: kompl.db is held by
the Next.js process exclusively.
"""

from __future__ import annotations

import gzip
import os
import shutil
from pathlib import Path

_DATA_ROOT = "/data"
_PAGES_DIR = os.path.join(_DATA_ROOT, "pages")


def write_page(page_id: str, markdown: str) -> tuple[str, str | None]:
    """Write a wiki page to gzip-compressed storage with version preservation.

    Args:
        page_id:  URL-safe page identifier (e.g. "bitcoin-abc12345")
        markdown: Compiled markdown content for this page version

    Returns:
        (current_path, previous_path)
        current_path  — absolute path to the newly written file
        previous_path — absolute path to the archived previous version, or None
                        if this is the first version of the page

    Raises:
        OSError — if the directory cannot be created or files cannot be moved/written
    """
    os.makedirs(_PAGES_DIR, exist_ok=True)

    current_path = os.path.join(_PAGES_DIR, f"{page_id}.md.gz")
    previous_path: str | None = None

    # Version archive — move existing file before overwriting.
    if os.path.exists(current_path):
        stat = os.stat(current_path)
        # Use mtime (integer seconds) for the version timestamp so filenames
        # are deterministic across time zones. Format: YYYYMMDD-HHMMSS in UTC.
        import time
        ts = time.strftime("%Y%m%d-%H%M%S", time.gmtime(stat.st_mtime))
        previous_path = os.path.join(_PAGES_DIR, f"{page_id}.{ts}.md.gz")
        shutil.move(current_path, previous_path)

    # Write new gzip-compressed content.
    content_bytes = markdown.encode("utf-8")
    with gzip.open(current_path, "wb") as f:
        f.write(content_bytes)

    return current_path, previous_path


def read_page(page_id: str) -> str | None:
    """Read and decompress a wiki page. Returns None if the file does not exist."""
    current_path = os.path.join(_PAGES_DIR, f"{page_id}.md.gz")
    if not os.path.exists(current_path):
        return None
    with gzip.open(current_path, "rb") as f:
        return f.read().decode("utf-8")
