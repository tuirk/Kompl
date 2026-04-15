"""Regression tests for vector_store.export_all() pagination logic.

Run with:  pytest nlp-service/tests/test_vector_store_export.py -v

No Chroma install required — the collection is fully mocked.
No model loading required — export_all() never calls _embed().
"""

from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock, patch, call

import pytest

# ---------------------------------------------------------------------------
# Minimal stubs so the module can be imported without chromadb / spaCy / etc.
# ---------------------------------------------------------------------------

# Stub out chromadb at import time so _get_collection() lazy-import doesn't
# fail in a bare test environment.
chromadb_stub = types.ModuleType("chromadb")
chromadb_stub.PersistentClient = MagicMock()
sys.modules.setdefault("chromadb", chromadb_stub)

# Stub sentence_transformers (pulled in transitively by resolution router).
st_stub = types.ModuleType("sentence_transformers")
st_stub.SentenceTransformer = MagicMock()
sys.modules.setdefault("sentence_transformers", st_stub)

# The module under test uses a relative import from routers.resolution — stub
# the whole routers package so we never trigger model loading.
routers_stub = types.ModuleType("routers")
resolution_stub = types.ModuleType("routers.resolution")
resolution_stub._get_embed_model = MagicMock()
sys.modules.setdefault("routers", routers_stub)
sys.modules.setdefault("routers.resolution", resolution_stub)

# Now safe to import.
from services import vector_store  # noqa: E402


# ---------------------------------------------------------------------------
# Helper: build a mock collection with a fixed list of documents.
# ---------------------------------------------------------------------------

def _make_collection(all_items: list[dict]) -> MagicMock:
    """
    Return a MagicMock that emulates chromadb Collection.get() with
    limit/offset pagination over `all_items`.

    Each item in all_items: {"id": str, "embedding": list[float],
                              "metadata": dict, "document": str}
    """
    col = MagicMock()
    col.count.return_value = len(all_items)

    def fake_get(limit=None, offset=0, include=None, ids=None):
        # Honour the ids= path used by get_indexed_ids; not under test here.
        if ids is not None:
            matched = [it for it in all_items if it["id"] in ids]
            return {"ids": [it["id"] for it in matched]}

        page = all_items[offset: offset + limit] if limit is not None else all_items[offset:]
        return {
            "ids": [it["id"] for it in page],
            "embeddings": [it["embedding"] for it in page],
            "metadatas": [it["metadata"] for it in page],
            "documents": [it["document"] for it in page],
        }

    col.get.side_effect = fake_get
    return col


def _item(n: int, emb: list[float] | None = None) -> dict:
    """Convenience factory for a single item."""
    return {
        "id": f"page_{n}",
        "embedding": emb if emb is not None else [float(n), 0.0],
        "metadata": {"title": f"Page {n}", "page_type": "article",
                     "category": "test", "source_count": 1},
        "document": f"content of page {n}",
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestExportAllEmpty:
    """export_all() on an empty collection returns []."""

    def test_returns_empty_list(self):
        col = MagicMock()
        col.count.return_value = 0

        with patch.object(vector_store, "_get_collection", return_value=col):
            result = vector_store.export_all()

        assert result == []
        # collection.get() must NOT be called — no need to page nothing.
        col.get.assert_not_called()


class TestExportAllSingleFullBatch:
    """export_all() with exactly 500 items: one batch, loop exits correctly."""

    def test_returns_all_500_items(self):
        items = [_item(i) for i in range(500)]
        col = _make_collection(items)

        with patch.object(vector_store, "_get_collection", return_value=col):
            result = vector_store.export_all()

        assert len(result) == 500
        # Only one call to collection.get() should have been made.
        assert col.get.call_count == 1
        col.get.assert_called_once_with(
            limit=500, offset=0,
            include=["embeddings", "metadatas", "documents"],
        )

    def test_page_ids_match(self):
        items = [_item(i) for i in range(500)]
        col = _make_collection(items)

        with patch.object(vector_store, "_get_collection", return_value=col):
            result = vector_store.export_all()

        exported_ids = {r["page_id"] for r in result}
        expected_ids = {f"page_{i}" for i in range(500)}
        assert exported_ids == expected_ids

    def test_output_shape(self):
        """Every item in the result must have the four canonical keys."""
        items = [_item(0)]
        col = _make_collection(items)

        with patch.object(vector_store, "_get_collection", return_value=col):
            result = vector_store.export_all()

        assert len(result) == 1
        r = result[0]
        assert set(r.keys()) == {"page_id", "embedding", "metadata", "document"}
        assert r["page_id"] == "page_0"
        assert r["embedding"] == [0.0, 0.0]
        assert r["document"] == "content of page 0"


class TestExportAllTwoBatches:
    """export_all() with 501 items: two batches (500 + 1)."""

    def test_returns_all_501_items(self):
        items = [_item(i) for i in range(501)]
        col = _make_collection(items)

        with patch.object(vector_store, "_get_collection", return_value=col):
            result = vector_store.export_all()

        assert len(result) == 501

    def test_two_get_calls(self):
        items = [_item(i) for i in range(501)]
        col = _make_collection(items)

        with patch.object(vector_store, "_get_collection", return_value=col):
            vector_store.export_all()

        assert col.get.call_count == 2
        calls = col.get.call_args_list
        assert calls[0] == call(
            limit=500, offset=0,
            include=["embeddings", "metadatas", "documents"],
        )
        assert calls[1] == call(
            limit=500, offset=500,
            include=["embeddings", "metadatas", "documents"],
        )

    def test_page_ids_complete(self):
        items = [_item(i) for i in range(501)]
        col = _make_collection(items)

        with patch.object(vector_store, "_get_collection", return_value=col):
            result = vector_store.export_all()

        exported_ids = {r["page_id"] for r in result}
        assert exported_ids == {f"page_{i}" for i in range(501)}


class TestExportAllPartialEmbeddings:
    """Graceful handling when Chroma returns fewer embeddings than ids.

    This exercises the `embeddings[i] if i < len(embeddings)` guard.
    The guard is defensive — in practice Chroma always returns parallel
    arrays — but it should not raise even if the arrays are mismatched.
    """

    def test_short_embeddings_uses_fallback(self):
        col = MagicMock()
        col.count.return_value = 3
        # Simulate Chroma returning only 2 embeddings for 3 ids.
        col.get.return_value = {
            "ids": ["p1", "p2", "p3"],
            "embeddings": [[1.0, 0.0], [2.0, 0.0]],   # missing p3's embedding
            "metadatas": [{"title": "T1", "page_type": "", "category": "", "source_count": 0},
                          {"title": "T2", "page_type": "", "category": "", "source_count": 0},
                          {"title": "T3", "page_type": "", "category": "", "source_count": 0}],
            "documents": ["doc1", "doc2", "doc3"],
        }

        with patch.object(vector_store, "_get_collection", return_value=col):
            result = vector_store.export_all()

        assert len(result) == 3
        # p3 should fall back to empty list, not raise IndexError.
        p3 = next(r for r in result if r["page_id"] == "p3")
        assert p3["embedding"] == []

    def test_none_embeddings_field_uses_fallback(self):
        """Chroma returning None for 'embeddings' key is handled."""
        col = MagicMock()
        col.count.return_value = 1
        col.get.return_value = {
            "ids": ["p1"],
            "embeddings": None,      # edge case: None instead of []
            "metadatas": [{"title": "T", "page_type": "", "category": "", "source_count": 0}],
            "documents": ["doc"],
        }

        with patch.object(vector_store, "_get_collection", return_value=col):
            result = vector_store.export_all()

        assert len(result) == 1
        assert result[0]["embedding"] == []


class TestExportAllInfiniteLoopGuard:
    """
    REGRESSION TEST for the infinite-loop bug:

    If collection.get() returns an empty ids list while offset < total
    (which can happen when count() is stale, e.g. items deleted mid-export,
    or during HNSW segment compaction in Chroma 0.4.x), then
    `offset += len(ids)` advances by 0 and the loop never exits.

    The fix requires a `if not ids: break` guard after the get() call.
    This test detects the absence of that guard by running export_all()
    inside a thread with a timeout.
    """

    def test_empty_ids_mid_loop_does_not_hang(self):
        """
        Simulate: count()=3, first get() returns ids=[] (stale count scenario).
        export_all() must return [] or a partial result — it must NOT hang.
        """
        import threading

        col = MagicMock()
        col.count.return_value = 3
        # Every call to get() returns empty ids, simulating a fully-deleted
        # collection whose count() hadn't refreshed yet.
        col.get.return_value = {
            "ids": [],
            "embeddings": [],
            "metadatas": [],
            "documents": [],
        }

        result_holder = []
        exception_holder = []

        def run():
            try:
                with patch.object(vector_store, "_get_collection", return_value=col):
                    result_holder.append(vector_store.export_all())
            except Exception as e:
                exception_holder.append(e)

        t = threading.Thread(target=run, daemon=True)
        t.start()
        t.join(timeout=3.0)  # 3 seconds is more than enough for a guarded loop

        if t.is_alive():
            pytest.fail(
                "export_all() is stuck in an infinite loop when collection.get() "
                "returns empty ids while offset < total. "
                "Fix: add `if not ids: break` after the get() call."
            )

        # If we get here, the loop exited. Verify it returned gracefully.
        assert not exception_holder, f"export_all() raised: {exception_holder[0]}"
        assert result_holder[0] == [], (
            "export_all() should return [] when no ids are returned mid-loop"
        )


class TestRestoreBulkShapeCompatibility:
    """export_all() output shape is accepted verbatim by restore_bulk()."""

    def test_roundtrip_shape(self):
        """
        The dict produced by export_all() must be consumable by restore_bulk()
        without key errors or type errors.
        """
        items = [_item(i) for i in range(3)]
        col_export = _make_collection(items)

        with patch.object(vector_store, "_get_collection", return_value=col_export):
            exported = vector_store.export_all()

        assert len(exported) == 3

        # Now feed exported directly to restore_bulk with a fresh collection mock.
        col_restore = MagicMock()
        col_restore.upsert = MagicMock()

        with patch.object(vector_store, "_get_collection", return_value=col_restore):
            restored_count = vector_store.restore_bulk(exported)

        assert restored_count == 3
        assert col_restore.upsert.call_count == 1
        upsert_kwargs = col_restore.upsert.call_args.kwargs
        assert upsert_kwargs["ids"] == ["page_0", "page_1", "page_2"]
        assert len(upsert_kwargs["embeddings"]) == 3
        assert len(upsert_kwargs["documents"]) == 3
        assert len(upsert_kwargs["metadatas"]) == 3

    def test_restore_skips_items_with_empty_embedding(self):
        """
        Items produced by export_all() with embedding=[] (the fallback path)
        are silently skipped by restore_bulk(), which is the correct behaviour.
        """
        exported = [
            {"page_id": "p1", "embedding": [1.0, 0.0],
             "metadata": {"title": "T", "page_type": "", "category": "", "source_count": 0},
             "document": "doc1"},
            {"page_id": "p2", "embedding": [],          # fallback — no embedding
             "metadata": {},
             "document": "doc2"},
        ]
        col_restore = MagicMock()

        with patch.object(vector_store, "_get_collection", return_value=col_restore):
            restored_count = vector_store.restore_bulk(exported)

        # Only p1 should be upserted.
        assert restored_count == 1
        upsert_kwargs = col_restore.upsert.call_args.kwargs
        assert upsert_kwargs["ids"] == ["p1"]
