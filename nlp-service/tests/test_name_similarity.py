"""POST /resolve/name-similarity: cosine of two names alone, as Layer 2's
name-only similarity measures it (the shared MiniLM model, raw names).

The app's alias screen (app/src/lib/alias-screen.ts) asks it about stored
aliases whose names share no content words, and sets aside those below 0.9.
"""

from __future__ import annotations

import math

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

DIM = 8


class _Encoder:
    def __init__(self, vectors: dict[str, list[float]]):
        self.vectors = vectors
        self.calls: list[list[str]] = []

    def encode(self, texts, convert_to_numpy=True, normalize_embeddings=False):  # noqa: ARG002
        self.calls.append(list(texts))
        return np.array([self.vectors.get(t, [0.0] * DIM) for t in texts], dtype=np.float32)


def _at(sim: float) -> list[float]:
    """A unit vector whose cosine with axis 0 is `sim`."""
    v = [0.0] * DIM
    v[0] = sim
    v[1] = math.sqrt(max(0.0, 1 - sim * sim))
    return v


@pytest.fixture(scope="module")
def client():
    from routers.name_similarity import router  # noqa: PLC0415
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


@pytest.fixture
def encoder(monkeypatch):
    from routers import resolution  # noqa: PLC0415

    def install(vectors: dict[str, list[float]]) -> _Encoder:
        enc = _Encoder(vectors)
        monkeypatch.setattr(resolution, "_get_embed_model", lambda: enc)
        return enc

    return install


def test_scores_each_pair_by_the_names_alone(client, encoder):
    enc = encoder({"Ethereum": _at(1.0), "ETH": _at(0.62), "English": _at(1.0), "programming language": _at(0.31)})
    res = client.post("/resolve/name-similarity", json={"pairs": [
        {"a": "ETH", "b": "Ethereum"},
        {"a": "English", "b": "programming language"},
        {"a": "Ethereum", "b": "ETH"},
    ]})
    assert res.status_code == 200
    body = res.json()
    assert body["count"] == 3
    assert [(i["a"], i["b"]) for i in body["items"]] == [
        ("ETH", "Ethereum"), ("English", "programming language"), ("Ethereum", "ETH"),
    ]
    assert [round(i["similarity"], 2) for i in body["items"]] == [0.62, 0.31, 0.62]
    # Each name is encoded once, raw, as Layer 2 encodes names.
    assert len(enc.calls) == 1
    assert sorted(enc.calls[0]) == sorted(["ETH", "Ethereum", "English", "programming language"])


def test_a_name_without_a_vector_scores_zero(client, encoder):
    encoder({"A": _at(1.0)})
    res = client.post("/resolve/name-similarity", json={"pairs": [{"a": "A", "b": "unknown"}]})
    assert res.status_code == 200
    assert res.json()["items"][0]["similarity"] == 0.0


def test_no_pairs_needs_no_model(client, monkeypatch):
    from routers import resolution  # noqa: PLC0415

    def fail():
        raise AssertionError("model loaded for an empty request")

    monkeypatch.setattr(resolution, "_get_embed_model", fail)
    res = client.post("/resolve/name-similarity", json={"pairs": []})
    assert res.status_code == 200
    assert res.json() == {"items": [], "count": 0}


def test_rejects_unknown_fields_and_oversized_requests(client, encoder):
    encoder({})
    assert client.post("/resolve/name-similarity", json={"pairs": [], "extra": 1}).status_code == 422
    assert client.post("/resolve/name-similarity", json={"pairs": [{"a": "x", "b": "y", "c": "z"}]}).status_code == 422
    from routers.name_similarity import MAX_NAME_PAIRS  # noqa: PLC0415
    too_many = [{"a": "x", "b": "y"}] * (MAX_NAME_PAIRS + 1)
    assert client.post("/resolve/name-similarity", json={"pairs": too_many}).status_code == 422
