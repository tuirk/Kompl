"""Startup warm-up of the embedding model and vector store.

Run with:  pytest nlp-service/tests/test_embedding_warm_up.py -v

chromadb and sentence_transformers are stubbed by conftest.py; no model is
loaded and nothing touches /data/vectors.
"""

from __future__ import annotations

import threading
import time
from unittest.mock import MagicMock

from routers import resolution
from services import vector_store


def _run_concurrently(fn, n: int = 8) -> None:
    start = threading.Barrier(n)
    errors: list[BaseException] = []

    def worker() -> None:
        try:
            start.wait(timeout=5)
            fn()
        except BaseException as e:  # surfaced to the test below
            errors.append(e)

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=5)
    assert not any(t.is_alive() for t in threads), "a worker is stuck"
    assert not errors, errors


def _slow(result):
    def make(*_args, **_kwargs):
        time.sleep(0.05)
        return result
    return make


def test_warm_up_opens_collection_and_embeds(monkeypatch):
    get_collection = MagicMock()
    embed = MagicMock(return_value=[0.0])
    monkeypatch.setattr(vector_store, "_get_collection", get_collection)
    monkeypatch.setattr(vector_store, "_embed", embed)

    vector_store.warm_up()

    get_collection.assert_called_once_with()
    embed.assert_called_once()


def test_warm_up_never_raises(monkeypatch, caplog):
    monkeypatch.setattr(vector_store, "_get_collection", MagicMock())
    monkeypatch.setattr(vector_store, "_embed", MagicMock(side_effect=OSError("model files missing")))

    with caplog.at_level("WARNING"):
        vector_store.warm_up()

    assert "model files missing" in caplog.text


def test_warm_up_still_loads_the_model_when_the_store_fails(monkeypatch):
    embed = MagicMock(return_value=[0.0])
    monkeypatch.setattr(vector_store, "_get_collection", MagicMock(side_effect=OSError("bad /data/vectors")))
    monkeypatch.setattr(vector_store, "_embed", embed)

    vector_store.warm_up()

    embed.assert_called_once()


def test_collection_opens_once_under_concurrent_first_calls(monkeypatch):
    import chromadb

    client = MagicMock()
    client.get_or_create_collection.return_value = MagicMock(name="collection")
    persistent_client = MagicMock(side_effect=_slow(client))
    monkeypatch.setattr(chromadb, "PersistentClient", persistent_client)
    monkeypatch.setattr(vector_store, "_client", None)
    monkeypatch.setattr(vector_store, "_collection", None)

    _run_concurrently(vector_store._get_collection)

    assert persistent_client.call_count == 1
    assert vector_store._collection is client.get_or_create_collection.return_value


def test_embed_model_loads_once_under_concurrent_first_calls(monkeypatch):
    import sentence_transformers

    model = MagicMock(name="model")
    loader = MagicMock(side_effect=_slow(model))
    monkeypatch.setattr(sentence_transformers, "SentenceTransformer", loader)
    monkeypatch.setattr(resolution, "_embed_model", None)

    _run_concurrently(resolution._get_embed_model)

    assert loader.call_count == 1
    assert resolution._get_embed_model() is model


def test_loaded_model_is_reused_without_the_lock(monkeypatch):
    model = MagicMock(name="model")
    monkeypatch.setattr(resolution, "_embed_model", model)
    lock = MagicMock()
    monkeypatch.setattr(resolution, "_embed_model_lock", lock)

    assert resolution._get_embed_model() is model
    lock.__enter__.assert_not_called()
