"""Chroma vector store wrapper for Kompl v2 (commit 7).

Provides upsert, search, and delete operations for wiki page embeddings.
Embeddings are generated using the same all-MiniLM-L6-v2 model singleton
already loaded by routers/resolution.py — no second model load.

Storage: PersistentClient at /data/vectors (on the kompl-data named volume,
alongside /data/pages and /data/raw). No separate Chroma container needed —
chromadb 0.4.x runs embedded within the nlp-service process.

Collection distance metric: cosine (returns distances; similarity = 1 - distance).

This module NEVER opens kompl.db. Rule #1 in CLAUDE.md.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_CHROMA_DIR = "/data/vectors"
_COLLECTION_NAME = "wiki_pages"
# all-MiniLM-L6-v2 accepts up to 512 word-piece tokens (~2048 chars of prose)
_MAX_EMBED_CHARS = 2000

_client: Any = None
_collection: Any = None


def _get_collection() -> Any:
    global _client, _collection
    if _collection is not None:
        return _collection
    import chromadb
    _client = chromadb.PersistentClient(path=_CHROMA_DIR)
    _collection = _client.get_or_create_collection(
        name=_COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"},
    )
    logger.info("Chroma collection '%s' ready at %s", _COLLECTION_NAME, _CHROMA_DIR)
    return _collection


def _embed(text: str) -> list[float]:
    """Embed text using the shared all-MiniLM-L6-v2 singleton."""
    from routers.resolution import _get_embed_model
    model = _get_embed_model()
    truncated = text[:_MAX_EMBED_CHARS]
    embedding = model.encode(truncated, normalize_embeddings=True)
    return embedding.tolist()


def upsert_page(page_id: str, page_content: str, metadata: dict[str, Any]) -> None:
    """Embed page_content and upsert into Chroma.

    Metadata keys: title (str), page_type (str), category (str), source_count (int).
    """
    collection = _get_collection()
    embedding = _embed(page_content)
    # Chroma metadata values must be str | int | float | bool
    safe_meta: dict[str, Any] = {
        "title": str(metadata.get("title", "")),
        "page_type": str(metadata.get("page_type", "")),
        "category": str(metadata.get("category", "")),
        "source_count": int(metadata.get("source_count", 0)),
    }
    collection.upsert(
        ids=[page_id],
        embeddings=[embedding],
        documents=[page_content[:_MAX_EMBED_CHARS]],
        metadatas=[safe_meta],
    )


def search_pages(query_text: str, n_results: int = 20) -> list[dict[str, Any]]:
    """Embed query_text and return top n_results by cosine similarity.

    Returns list of {"page_id": str, "similarity": float} sorted descending.
    Returns [] if collection is empty or n_results < 1.
    """
    if n_results < 1:
        return []
    collection = _get_collection()
    try:
        count = collection.count()
    except Exception:
        count = 0
    if count == 0:
        return []

    actual_n = min(n_results, count)
    embedding = _embed(query_text)
    results = collection.query(
        query_embeddings=[embedding],
        n_results=actual_n,
        include=["distances"],
    )
    ids = results.get("ids", [[]])[0]
    distances = results.get("distances", [[]])[0]
    # Chroma cosine distance: 0 = identical, 2 = opposite. similarity = 1 - distance.
    matches = [
        {"page_id": pid, "similarity": max(0.0, 1.0 - float(dist))}
        for pid, dist in zip(ids, distances)
    ]
    return sorted(matches, key=lambda m: m["similarity"], reverse=True)


def export_all() -> list[dict[str, Any]]:
    """Return all stored embeddings as a list of dicts for backup/export.

    Each item: {page_id, embedding, metadata, document}.
    Returns [] if the collection is empty. Paginates in batches of 500 to
    avoid OOM on large collections.
    """
    collection = _get_collection()
    try:
        total = collection.count()
        if total == 0:
            return []
        items: list[dict[str, Any]] = []
        batch_size = 500
        offset = 0
        while offset < total:
            batch = collection.get(
                limit=batch_size,
                offset=offset,
                include=["embeddings", "metadatas", "documents"],
            )
            ids = batch.get("ids") or []
            if not ids:
                break  # stale count() — collection shrank during export; avoid infinite loop
            embeddings = batch.get("embeddings") or []
            metadatas = batch.get("metadatas") or []
            documents = batch.get("documents") or []
            for i, page_id in enumerate(ids):
                items.append({
                    "page_id": page_id,
                    "embedding": embeddings[i] if i < len(embeddings) else [],
                    "metadata": metadatas[i] if i < len(metadatas) else {},
                    "document": documents[i] if i < len(documents) else "",
                })
            offset += len(ids)  # use actual returned count for the last (partial) batch
        return items
    except Exception as e:
        logger.error("export_all failed: %s", e)
        return []


def restore_bulk(items: list[dict[str, Any]]) -> int:
    """Bulk-restore pre-computed embeddings without re-embedding.

    Each item must have: page_id (str), embedding (list[float]),
    metadata (dict), document (str). Returns count of items restored.
    Skips items with missing/empty embeddings.
    """
    if not items:
        return 0
    collection = _get_collection()
    ids, embeddings, metadatas, documents = [], [], [], []
    for item in items:
        emb = item.get("embedding")
        if not emb:
            continue
        ids.append(str(item["page_id"]))
        embeddings.append(emb)
        safe_meta: dict[str, Any] = {
            "title": str(item.get("metadata", {}).get("title", "")),
            "page_type": str(item.get("metadata", {}).get("page_type", "")),
            "category": str(item.get("metadata", {}).get("category", "")),
            "source_count": int(item.get("metadata", {}).get("source_count", 0)),
        }
        metadatas.append(safe_meta)
        documents.append(str(item.get("document", ""))[:_MAX_EMBED_CHARS])
    if not ids:
        return 0
    try:
        collection.upsert(ids=ids, embeddings=embeddings, documents=documents, metadatas=metadatas)
        logger.info("restore_bulk: restored %d embeddings", len(ids))
    except Exception as e:
        logger.error("restore_bulk upsert failed: %s", e)
        raise
    return len(ids)


def delete_page(page_id: str) -> None:
    """Delete a single page's embedding from Chroma by page_id.

    No-ops silently if the page_id is not in the collection.
    """
    collection = _get_collection()
    try:
        collection.delete(ids=[page_id])
        logger.info("Deleted vector for page %s", page_id)
    except Exception as e:
        logger.warning("delete_page failed for %s: %s", page_id, e)


def get_indexed_ids(page_ids: list[str]) -> set[str]:
    """Return the subset of page_ids that are already in Chroma.

    Used by the backfill endpoint to determine which pages need embedding.
    """
    if not page_ids:
        return set()
    collection = _get_collection()
    try:
        result = collection.get(ids=page_ids, include=[])
        return set(result.get("ids", []))
    except Exception as e:
        logger.warning("get_indexed_ids failed: %s", e)
        return set()
