"""Path-traversal guards for nlp-service.

  - validate_page_id  — regex-based ID whitelist (CLAUDE.md slug convention)
  - validate_source_id — same shape (UUIDs and test fixtures both fit)
  - safe_join          — Path.resolve().relative_to() canonical containment

safe_join is the only sanctioned way to compose a user-supplied path with a
trusted base. CodeQL recognises Path.relative_to() raising on escape as a
sanitizer barrier, which is why the function is structured this way and why
older startswith()-based checks are being retired.
"""

from __future__ import annotations

import re
from pathlib import Path

_PAGE_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9_-]{0,79})$")
_SOURCE_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9_-]{0,79})$")


def validate_page_id(page_id: str) -> None:
    if not isinstance(page_id, str) or not _PAGE_ID_RE.match(page_id):
        raise ValueError("invalid_page_id")


def validate_source_id(source_id: str) -> None:
    if not isinstance(source_id, str) or not _SOURCE_ID_RE.match(source_id):
        raise ValueError("invalid_source_id")


def safe_join(base: Path | str, user_path: str) -> Path:
    if not isinstance(user_path, str) or not user_path:
        raise ValueError("empty_path")
    if "\x00" in user_path:
        raise ValueError("nul_byte")

    base_path = Path(base)
    base_resolved = base_path.resolve()

    p_input = Path(user_path)
    if p_input.is_absolute():
        candidate = p_input.resolve(strict=False)
    else:
        candidate = (base_path / p_input).resolve(strict=False)

    try:
        candidate.relative_to(base_resolved)
    except ValueError as e:
        raise ValueError("path_escape") from e

    return candidate
