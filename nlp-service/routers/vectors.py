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
from services.vector_store import get_indexed_ids, search_pages, upsert_page

logger = logging.getLogger(__name__)

router = APIRouter(tags=["vectors"])


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class VectorUpsertRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    page_id: str
    metadata: dict  # {title, page_type, category, source_count}


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


class BackfillRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    page_ids: list[str]
    metadata_map: dict  # page_id → {title, page_type, category, source_count}


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
        upsert_page(req.page_id, content, req.metadata)
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

        metadata = req.metadata_map.get(page_id, {})
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
