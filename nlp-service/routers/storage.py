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

from services.file_store import write_page

router = APIRouter(tags=["storage"])


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
