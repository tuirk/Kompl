"""Storage router for Kompl v2 nlp-service (commit 4).

Exposes the version-preserving write_page() from services/file_store.py
over HTTP so that Next.js can call it during the Phase 1 pre-work of the
compile commit route (before the synchronous db.transaction()).

Endpoint:
  POST /storage/write-page
    Request:  {page_id: str, markdown: str}
    Response: {current_path: str, previous_path: str | null}

This is an internal-network-only endpoint (nlp-service never exposed to
browser). No auth required — security comes from the Docker network isolation.

This router NEVER opens kompl.db. rule #1 in CLAUDE.md.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

import os

from services.file_store import read_page, write_page

router = APIRouter(tags=["storage"])

_DATA_ROOT = "/data"


def _safe_path(file_path: str) -> str:
    """Resolve path and verify it's under /data. Raises HTTPException if not."""
    import pathlib
    resolved = str(pathlib.Path(file_path).resolve())
    if not resolved.startswith(_DATA_ROOT + "/") and resolved != _DATA_ROOT:
        raise HTTPException(status_code=403, detail="path_outside_data_volume")
    return resolved


class WritePageRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    page_id: str
    markdown: str


class WritePageResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    current_path: str
    previous_path: str | None = None


@router.post("/storage/write-page", response_model=WritePageResponse)
def storage_write_page(req: WritePageRequest) -> WritePageResponse:
    """Write a compiled wiki page with version preservation (rule #4).

    If a current version exists it is moved to a timestamped archive file
    before the new content is written. Returns both paths so the caller
    can store previous_content_path in the pages table.
    """
    try:
        current_path, previous_path = write_page(req.page_id, req.markdown)
    except OSError as e:
        raise HTTPException(
            status_code=500,
            detail=f"file_store_error: {e}",
        ) from e
    return WritePageResponse(current_path=current_path, previous_path=previous_path)


# ---------------------------------------------------------------------------
# Generic file read/write (schema.md and other data-volume text files)
# ---------------------------------------------------------------------------


class ReadFileRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    path: str


class ReadFileResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    content: str
    exists: bool


class WriteFileRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    path: str
    content: str


class WriteFileResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    path: str
    written: bool


class ReadPageRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    page_id: str


class ReadPageResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    content: str
    exists: bool


@router.post("/storage/read-page", response_model=ReadPageResponse)
def storage_read_page(req: ReadPageRequest) -> ReadPageResponse:
    """Read a compiled wiki page by page_id (decompresses .md.gz automatically).

    Returns exists=False if the page file does not exist yet.
    """
    content = read_page(req.page_id)
    if content is None:
        return ReadPageResponse(content="", exists=False)
    return ReadPageResponse(content=content, exists=True)


@router.post("/storage/read-file", response_model=ReadFileResponse)
def storage_read_file(req: ReadFileRequest) -> ReadFileResponse:
    """Read a text file from the data volume. Returns exists=False if missing."""
    resolved = _safe_path(req.path)
    if not os.path.exists(resolved):
        return ReadFileResponse(content="", exists=False)
    try:
        with open(resolved, "r", encoding="utf-8") as f:
            content = f.read()
        return ReadFileResponse(content=content, exists=True)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"read_file_error: {e}") from e


@router.post("/storage/write-file", response_model=WriteFileResponse)
def storage_write_file(req: WriteFileRequest) -> WriteFileResponse:
    """Write a text file to the data volume. Creates parent directories if needed."""
    resolved = _safe_path(req.path)
    try:
        os.makedirs(os.path.dirname(resolved), exist_ok=True)
        with open(resolved, "w", encoding="utf-8") as f:
            f.write(req.content)
        return WriteFileResponse(path=resolved, written=True)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"write_file_error: {e}") from e


@router.post("/storage/file-exists")
def storage_file_exists(req: ReadFileRequest) -> dict[str, bool]:
    """Check whether a file exists on the data volume."""
    resolved = _safe_path(req.path)
    return {"exists": os.path.exists(resolved)}
