"""Pytest fixtures and module stubs for nlp-service tests.

Heavy ML dependencies (chromadb, sentence-transformers, spacy, pytextrank)
are stubbed at import time — same pattern as test_vector_store_export.py.
This lets the tests run without loading any models or GPU resources.
"""

from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

# ---------------------------------------------------------------------------
# Stub heavy dependencies BEFORE any service module is imported
# ---------------------------------------------------------------------------

chromadb_stub = types.ModuleType("chromadb")
chromadb_stub.PersistentClient = MagicMock()
sys.modules.setdefault("chromadb", chromadb_stub)

st_stub = types.ModuleType("sentence_transformers")
st_stub.SentenceTransformer = MagicMock()
sys.modules.setdefault("sentence_transformers", st_stub)

spacy_stub = types.ModuleType("spacy")
spacy_stub.load = MagicMock(return_value=MagicMock())
sys.modules.setdefault("spacy", spacy_stub)

pytextrank_stub = types.ModuleType("pytextrank")
sys.modules.setdefault("pytextrank", pytextrank_stub)

routers_stub = types.ModuleType("routers")
resolution_stub = types.ModuleType("routers.resolution")
resolution_stub._get_embed_model = MagicMock()
sys.modules.setdefault("routers", routers_stub)
sys.modules.setdefault("routers.resolution", resolution_stub)

# ---------------------------------------------------------------------------
# FastAPI app + TestClient
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def app():
    from main import app as fastapi_app  # noqa: PLC0415
    return fastapi_app


@pytest.fixture
def client(app):
    return TestClient(app)


# ---------------------------------------------------------------------------
# Gemini SDK mock fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_gemini(monkeypatch):
    """Patch get_client() to return a MagicMock Gemini client."""
    mock_client = MagicMock()
    mock_response = MagicMock()
    mock_response.text = "---\ntitle: Test\npage_type: source-summary\n---\n## Content\nBody."
    mock_response.usage_metadata.prompt_token_count = 100
    mock_response.usage_metadata.candidates_token_count = 50
    mock_client.models.generate_content.return_value = mock_response

    from services import llm_client  # noqa: PLC0415
    monkeypatch.setattr(llm_client, "get_client", lambda: mock_client)
    return mock_client


@pytest.fixture
def mock_limiter(monkeypatch):
    """Patch _get_limiter() so try_acquire always succeeds."""
    mock_lim = MagicMock()
    mock_lim.try_acquire.return_value = True

    from services import llm_client  # noqa: PLC0415
    monkeypatch.setattr(llm_client, "_get_limiter", lambda: mock_lim)
    return mock_lim


@pytest.fixture
def mock_cost(monkeypatch):
    """Patch _check_and_record_cost to avoid disk I/O."""
    from services import llm_client  # noqa: PLC0415
    mock_fn = MagicMock()
    monkeypatch.setattr(llm_client, "_check_and_record_cost", mock_fn)
    return mock_fn
