"""Regression tests for POST /extract/tfidf-rank.

Ranks candidate texts against a single query via sklearn TF-IDF. Used by
the draft step (Flag 3A) to cap cross-session dossier size by relevance.

Heavy deps that extraction.py pulls at import time are stubbed before import,
matching the pattern in conftest.py.
"""

from __future__ import annotations

import sys
import time
import types
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


# Stub modules extraction.py imports at the top level that we do not
# exercise in these tests. sklearn is a real import (the endpoint uses it).
for name in ("keybert", "rake_nltk", "yake"):
    if name not in sys.modules:
        stub = types.ModuleType(name)
        # Common class names the code imports — stub with MagicMock callables.
        for attr in ("KeyBERT", "Rake"):
            setattr(stub, attr, MagicMock())
        sys.modules[name] = stub


@pytest.fixture(scope="module")
def rank_app() -> FastAPI:
    # Import after the stubs above are in place.
    from routers.extraction import router as extraction_router  # noqa: PLC0415
    app = FastAPI()
    app.include_router(extraction_router)
    return app


@pytest.fixture
def rank_client(rank_app) -> TestClient:
    return TestClient(rank_app)


# ─────────────────────────────────────────────────────────────────────────
# 1. Relevance ordering
# ─────────────────────────────────────────────────────────────────────────


def test_relevant_candidate_scores_higher_than_unrelated(rank_client):
    resp = rank_client.post(
        "/extract/tfidf-rank",
        json={
            "query": "GPT-4 pricing benchmarks",
            "candidates": [
                {"id": "src-A", "text": "GPT-4 pricing is $3 per million tokens on the API."},
                {"id": "src-B", "text": "A treatise on medieval harpsichord manufacture and tuning."},
            ],
        },
    )
    assert resp.status_code == 200
    scores = {s["id"]: s["score"] for s in resp.json()["scores"]}
    assert scores["src-A"] > scores["src-B"]
    assert scores["src-A"] > 0.0
    # Unrelated candidate should have no lexical overlap beyond stop words.
    assert scores["src-B"] == pytest.approx(0.0, abs=1e-6)


# ─────────────────────────────────────────────────────────────────────────
# 2. Empty candidates
# ─────────────────────────────────────────────────────────────────────────


def test_empty_candidates_returns_empty_scores(rank_client):
    resp = rank_client.post(
        "/extract/tfidf-rank",
        json={"query": "anything", "candidates": []},
    )
    assert resp.status_code == 200
    assert resp.json() == {"scores": []}


# ─────────────────────────────────────────────────────────────────────────
# 3. Validation: empty query is rejected
# ─────────────────────────────────────────────────────────────────────────


def test_empty_query_is_rejected(rank_client):
    resp = rank_client.post(
        "/extract/tfidf-rank",
        json={
            "query": "",
            "candidates": [{"id": "x", "text": "GPT-4 is an LLM."}],
        },
    )
    assert resp.status_code == 422


# ─────────────────────────────────────────────────────────────────────────
# 4. Performance sanity: 50 candidates return under 1s
# ─────────────────────────────────────────────────────────────────────────


def test_50_candidates_performance(rank_client):
    candidates = [
        {
            "id": f"src-{i:03d}",
            "text": f"GPT-4 and LLM benchmarks discussion number {i} with context.",
        }
        for i in range(50)
    ]
    t0 = time.perf_counter()
    resp = rank_client.post(
        "/extract/tfidf-rank",
        json={"query": "GPT-4 benchmarks", "candidates": candidates},
    )
    elapsed = time.perf_counter() - t0
    assert resp.status_code == 200
    assert len(resp.json()["scores"]) == 50
    assert elapsed < 1.0, f"Ranking 50 candidates took {elapsed:.3f}s, > 1s budget"


# ─────────────────────────────────────────────────────────────────────────
# 5. Empty-text candidates collapse to score 0 without breaking the batch
# ─────────────────────────────────────────────────────────────────────────


def test_empty_text_candidate_scores_zero_without_error(rank_client):
    resp = rank_client.post(
        "/extract/tfidf-rank",
        json={
            "query": "GPT-4",
            "candidates": [
                {"id": "src-A", "text": "GPT-4 is Anthropic's rival model."},
                {"id": "src-B", "text": ""},
                {"id": "src-C", "text": "   "},  # whitespace-only also scores 0
            ],
        },
    )
    assert resp.status_code == 200
    scores = {s["id"]: s["score"] for s in resp.json()["scores"]}
    assert scores["src-A"] > 0.0
    assert scores["src-B"] == pytest.approx(0.0, abs=1e-6)
    assert scores["src-C"] == pytest.approx(0.0, abs=1e-6)
