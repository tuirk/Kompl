"""Vector store router for Kompl v2 nlp-service (commit 7).

Endpoints:
  POST /vectors/upsert    — embed a wiki page and store in Chroma
  POST /vectors/search    — semantic search over stored page embeddings
  POST /vectors/backfill  — upsert all pages not yet in Chroma (idempotent)

The upsert endpoint reads page content internally via file_store.read_page()
so callers only need to pass the page_id and metadata — no content in request.

This router NEVER opens kompl.db. Rule #1 in CLAUDE.md.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

from services.file_store import read_page
from services.vector_store import delete_page, export_all, get_indexed_ids, restore_bulk, search_pages, upsert_page

logger = logging.getLogger(__name__)

router = APIRouter(tags=["vectors"])


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class VectorMetadata(BaseModel):
    """Strict metadata schema for wiki page embeddings.

    Mirrors the four fields consumed by `services.vector_store.upsert_page`.
    All call sites (compile/commit, recompile, backfill-vectors) send exactly
    these keys — see commit/route.ts:334-339.
    """
    model_config = ConfigDict(extra='forbid')

    title: str
    page_type: str
    category: str = ''
    source_count: int = 0


class VectorUpsertRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    page_id: str
    metadata: VectorMetadata


class VectorUpsertResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    ok: bool


class VectorSearchRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    query_text: str
    n_results: int = 20


class VectorMatch(BaseModel):
    model_config = ConfigDict(extra='forbid')

    page_id: str
    similarity: float  # 0–1, higher = more similar


class VectorSearchResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    matches: list[VectorMatch]


class VectorExportItem(BaseModel):
    model_config = ConfigDict(extra='forbid')

    page_id: str
    embedding: list[float]
    metadata: dict
    document: str


class VectorExportResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    count: int
    items: list[VectorExportItem]


class VectorRestoreRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    items: list[VectorExportItem]


class VectorRestoreResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    restored: int


class VectorDeleteRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    page_id: str


class VectorDeleteResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    deleted: str


class BackfillRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    page_ids: list[str]
    metadata_map: dict[str, VectorMetadata]  # page_id → VectorMetadata


class BackfillResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    total: int
    upserted: int
    already_indexed: int
    errors: int


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/vectors/upsert", response_model=VectorUpsertResponse)
def vectors_upsert(req: VectorUpsertRequest) -> VectorUpsertResponse:
    """Embed page content and upsert into Chroma.

    Reads page content from /data/pages/{page_id}.md.gz via file_store.
    Returns 404 if the page file does not exist yet.
    """
    content = read_page(req.page_id)
    if content is None:
        raise HTTPException(status_code=404, detail="page_not_found")

    try:
        upsert_page(req.page_id, content, req.metadata.model_dump())
    except Exception as e:
        logger.error("vector upsert failed for %s: %s", req.page_id, e)
        raise HTTPException(status_code=500, detail=f"vector_upsert_failed: {e}") from e

    return VectorUpsertResponse(ok=True)


@router.post("/vectors/search", response_model=VectorSearchResponse)
def vectors_search(req: VectorSearchRequest) -> VectorSearchResponse:
    """Embed query_text and return the top n_results by cosine similarity.

    Returns an empty matches list when the collection is empty.
    """
    if req.n_results < 1:
        return VectorSearchResponse(matches=[])

    try:
        raw_matches = search_pages(req.query_text, req.n_results)
    except Exception as e:
        logger.error("vector search failed: %s", e)
        raise HTTPException(status_code=500, detail=f"vector_search_failed: {e}") from e

    matches = [VectorMatch(page_id=m["page_id"], similarity=m["similarity"]) for m in raw_matches]
    return VectorSearchResponse(matches=matches)


@router.get("/vectors/export", response_model=VectorExportResponse)
def vectors_export() -> VectorExportResponse:
    """Export all stored embeddings for backup purposes.

    Called by GET /api/export?format=kompl&include_vectors=true.
    Returns all page embeddings so they can be restored without re-embedding.
    """
    try:
        raw = export_all()
    except Exception as e:
        logger.error("vectors export failed: %s", e)
        raise HTTPException(status_code=500, detail=f"vectors_export_failed: {e}") from e
    items = [
        VectorExportItem(
            page_id=item["page_id"],
            embedding=item["embedding"],
            metadata=item["metadata"],
            document=item["document"],
        )
        for item in raw
    ]
    return VectorExportResponse(count=len(items), items=items)


@router.post("/vectors/restore", response_model=VectorRestoreResponse)
def vectors_restore(req: VectorRestoreRequest) -> VectorRestoreResponse:
    """Restore pre-computed embeddings directly into Chroma without re-embedding.

    Called by POST /api/import when vectors.json is present in the zip.
    Skips items with empty embeddings gracefully.
    """
    try:
        restored = restore_bulk([item.model_dump() for item in req.items])
    except Exception as e:
        logger.error("vectors restore failed: %s", e)
        raise HTTPException(status_code=500, detail=f"vectors_restore_failed: {e}") from e
    return VectorRestoreResponse(restored=restored)


@router.post("/vectors/delete", response_model=VectorDeleteResponse)
def vectors_delete(req: VectorDeleteRequest) -> VectorDeleteResponse:
    """Delete a page's embedding from Chroma.

    Called fire-and-forget when a wiki page is permanently deleted.
    No-ops silently if the page_id is not indexed.
    """
    try:
        delete_page(req.page_id)
    except Exception as e:
        logger.error("vector delete failed for %s: %s", req.page_id, e)
        raise HTTPException(status_code=500, detail=f"vector_delete_failed: {e}") from e
    return VectorDeleteResponse(deleted=req.page_id)


@router.post("/vectors/backfill", response_model=BackfillResponse)
def vectors_backfill(req: BackfillRequest) -> BackfillResponse:
    """Upsert any pages from page_ids that are not yet in Chroma.

    Idempotent — safe to call anytime. Already-indexed pages are skipped.
    Errors on individual page upserts are logged and counted but do not abort
    the backfill — all pages are attempted.
    """
    total = len(req.page_ids)
    if total == 0:
        return BackfillResponse(total=0, upserted=0, already_indexed=0, errors=0)

    try:
        existing_ids = get_indexed_ids(req.page_ids)
    except Exception as e:
        logger.error("backfill get_indexed_ids failed: %s", e)
        existing_ids = set()

    missing_ids = [pid for pid in req.page_ids if pid not in existing_ids]
    already_indexed = len(req.page_ids) - len(missing_ids)

    upserted = 0
    errors = 0
    for page_id in missing_ids:
        content = read_page(page_id)
        if content is None:
            logger.warning("backfill: page file missing for %s, skipping", page_id)
            errors += 1
            continue

        meta_model = req.metadata_map.get(page_id)
        metadata = meta_model.model_dump() if meta_model is not None else {}
        try:
            upsert_page(page_id, content, metadata)
            upserted += 1
        except Exception as e:
            logger.error("backfill upsert failed for %s: %s", page_id, e)
            errors += 1

    logger.info(
        "backfill complete: total=%d already_indexed=%d upserted=%d errors=%d",
        total, already_indexed, upserted, errors,
    )
    return BackfillResponse(
        total=total,
        upserted=upserted,
        already_indexed=already_indexed,
        errors=errors,
    )
