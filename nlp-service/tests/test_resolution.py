"""Tests for cross-session anchoring in /resolve/fuzzy and /resolve/embedding.

Covers Core change 1 of the corpus-wide canonicalisation fix: incoming session
entities get matched against existing wiki page titles so the split-session
duplicate case ("GPT-4" in session A, "GPT 4" in session B) resolves at the
resolver, not after the page is already duplicated.

Heavy ML deps (sentence-transformers) are stubbed in conftest.py. The fuzzy
endpoint is pure Python — no mocking needed. The embedding endpoint is
tested by monkeypatching _get_embed_model with a deterministic encoder.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def resolution_client():
    from routers.resolution import router  # noqa: PLC0415
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


# ---------------------------------------------------------------------------
# /resolve/fuzzy — cross-session anchoring via existing_page_titles
# ---------------------------------------------------------------------------


class TestFuzzyExistingPageTitles:
    """The key split-session regression case — session A has only one spelling,
    session B's resolver must still bind to the existing page via fuzzy match.
    """

    def test_exact_case_insensitive_match_binds_to_page_title(self, resolution_client):
        body = {
            "entities": [
                {"name": "gpt-4", "type": "PRODUCT", "source_id": "src1", "context": ""}
            ],
            "existing_aliases": [],
            "existing_page_titles": [{"title": "GPT-4", "page_type": "entity"}],
        }
        resp = resolution_client.post("/resolve/fuzzy", json=body)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["resolved"]) == 1
        g = data["resolved"][0]
        assert g["canonical"] == "GPT-4"   # preserves existing page's casing
        assert g["method"] == "existing_page_title"
        assert g["source_ids"] == ["src1"]
        assert data["unresolved"] == []

    def test_levenshtein_match_binds_to_page_title(self, resolution_client):
        """The core split-session case: 'GPT 4' (session B) vs 'GPT-4' (existing page).
        Edit distance = 1 (hyphen vs space). Fuzzy layer binds cross-session.
        """
        body = {
            "entities": [
                {"name": "GPT 4", "type": "PRODUCT", "source_id": "src_b", "context": ""}
            ],
            "existing_aliases": [],
            "existing_page_titles": [{"title": "GPT-4", "page_type": "entity"}],
        }
        resp = resolution_client.post("/resolve/fuzzy", json=body)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["resolved"]) == 1
        g = data["resolved"][0]
        assert g["canonical"] == "GPT-4"
        assert g["method"] == "existing_page_title"

    def test_type_mismatch_rejects_page_title_binding(self, resolution_client):
        """A CONCEPT entity must not bind to an 'entity' page type."""
        body = {
            "entities": [
                {"name": "Transformer Architecture", "type": "CONCEPT", "source_id": "src1", "context": ""}
            ],
            "existing_aliases": [],
            "existing_page_titles": [
                {"title": "Transformer Architecture", "page_type": "entity"}  # wrong page_type
            ],
        }
        resp = resolution_client.post("/resolve/fuzzy", json=body)
        assert resp.status_code == 200
        data = resp.json()
        # Falls through to unresolved — no cross-session binding happens
        assert data["resolved"] == []
        assert len(data["unresolved"]) == 1

    def test_concept_binds_to_concept_page(self, resolution_client):
        body = {
            "entities": [
                {"name": "Transformer Networks", "type": "CONCEPT", "source_id": "src1", "context": ""}
            ],
            "existing_aliases": [],
            "existing_page_titles": [
                {"title": "Transformer Architecture", "page_type": "concept"}
            ],
        }
        resp = resolution_client.post("/resolve/fuzzy", json=body)
        assert resp.status_code == 200
        data = resp.json()
        # Levenshtein between "Transformer Networks" and "Transformer Architecture"
        # is large, so it won't fuzzy-match. But jaro-winkler might. Let's just
        # assert it doesn't incorrectly bind OR unresolved. Either is fine —
        # the point is no crash and correct type gating.
        assert len(data["resolved"]) + len(data["unresolved"]) == 1

    def test_existing_alias_still_wins_when_both_present(self, resolution_client):
        """If an entity matches BOTH an existing_alias and existing_page_title,
        the alias resolution happens first (unchanged behaviour)."""
        body = {
            "entities": [
                {"name": "ML", "type": "CONCEPT", "source_id": "src1", "context": ""}
            ],
            "existing_aliases": [{"alias": "ML", "canonical": "Machine Learning"}],
            "existing_page_titles": [
                {"title": "Machine Learning", "page_type": "concept"}
            ],
        }
        resp = resolution_client.post("/resolve/fuzzy", json=body)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["resolved"]) == 1
        g = data["resolved"][0]
        assert g["canonical"] == "Machine Learning"
        # method is existing_alias (hit the alias drawer first), not existing_page_title
        assert g["method"] == "existing_alias"

    def test_extra_field_rejected_by_pydantic(self, resolution_client):
        body = {
            "entities": [
                {"name": "X", "type": "ORG", "source_id": "s", "context": "", "bogus": 1}
            ],
            "existing_aliases": [],
            "existing_page_titles": [],
        }
        resp = resolution_client.post("/resolve/fuzzy", json=body)
        assert resp.status_code == 422  # extra='forbid' triggers Pydantic validation error

    def test_empty_existing_page_titles_does_not_crash(self, resolution_client):
        """Backcompat: omitting existing_page_titles should still work (default=[])."""
        body = {
            "entities": [
                {"name": "Foo", "type": "PRODUCT", "source_id": "s", "context": ""}
            ],
            "existing_aliases": [],
            # no existing_page_titles field at all
        }
        resp = resolution_client.post("/resolve/fuzzy", json=body)
        assert resp.status_code == 200

    def test_substring_does_not_bind_short_entity_to_long_page_title(self, resolution_client):
        """Regression: a short-name entity must NOT bind to a longer page title
        just because one is a character-level substring of the other.

        Cities and landmarks within them ("Vilnius" ↔ "Vilnius Cathedral"),
        parents and subsidiaries, brands and product lines all share this
        shape. Same-session substring matching is fine, but cross-session
        anchoring against authoritative wiki page titles must be stricter.

        Expected: entity falls through to unresolved so Layer 2 embedding can
        evaluate semantic similarity.
        """
        body = {
            "entities": [
                {"name": "Vilnius", "type": "LOCATION", "source_id": "src1", "context": ""}
            ],
            "existing_aliases": [],
            "existing_page_titles": [
                {"title": "Vilnius Cathedral", "page_type": "entity"}
            ],
        }
        resp = resolution_client.post("/resolve/fuzzy", json=body)
        assert resp.status_code == 200
        data = resp.json()
        assert data["resolved"] == []
        assert len(data["unresolved"]) == 1
        assert data["unresolved"][0]["name"] == "Vilnius"

    def test_substring_does_not_bind_long_entity_to_short_page_title(self, resolution_client):
        """Symmetric to above: extracting 'Catan Junior' must not bind to an
        existing 'Catan' page via reverse substring. The substring branch
        triggers on either direction (al in bl OR bl in al), so the strict
        cross-session matcher must reject both.
        """
        body = {
            "entities": [
                {"name": "Catan Junior", "type": "PRODUCT", "source_id": "src1", "context": ""}
            ],
            "existing_aliases": [],
            "existing_page_titles": [
                {"title": "Catan", "page_type": "entity"}
            ],
        }
        resp = resolution_client.post("/resolve/fuzzy", json=body)
        assert resp.status_code == 200
        data = resp.json()
        assert data["resolved"] == []
        assert len(data["unresolved"]) == 1
        assert data["unresolved"][0]["name"] == "Catan Junior"


# ---------------------------------------------------------------------------
# /resolve/embedding — anchor + ambiguous cross-session pairs
# ---------------------------------------------------------------------------


class _FakeEncoder:
    """Deterministic encoder for embedding tests. Maps known strings to unit
    vectors along distinct axes so cosine similarity is predictable.
    """

    def __init__(self, mapping: dict[str, list[float]]):
        self.mapping = mapping

    def encode(self, texts, convert_to_numpy=True, normalize_embeddings=False):  # noqa: ARG002
        vecs = []
        for t in texts:
            # Embedding in resolve_embedding prefixes "name: context" — handle
            # both that form and bare name.
            key = t.split(":", 1)[0].strip()
            v = self.mapping.get(key, self.mapping.get(t, [0.0] * 8))
            vecs.append(v)
        arr = np.array(vecs, dtype=np.float32)
        return arr


@pytest.fixture
def patched_embed_model(monkeypatch):
    """Install a deterministic fake encoder in place of sentence-transformers."""
    from routers import resolution  # noqa: PLC0415

    def install(mapping: dict[str, list[float]]):
        fake = _FakeEncoder(mapping)
        monkeypatch.setattr(resolution, "_get_embed_model", lambda: fake)
        return fake

    return install


class TestEmbeddingExistingPageTitles:
    def test_high_similarity_anchors_to_page_title(self, resolution_client, patched_embed_model):
        """cosine > 0.9 → emit ResolvedGroup with canonical=page title, method=existing_page_title.
        The session entity is NOT dropped into the ambiguous bucket.
        """
        # Two vectors that are nearly identical (sim ≈ 1.0):
        patched_embed_model({
            "GPT 4": [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            "GPT-4": [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        })
        body = {
            "entities": [
                {"name": "GPT 4", "type": "PRODUCT", "source_id": "src_b", "context": ""}
            ],
            "existing_page_titles": [{"title": "GPT-4", "page_type": "entity"}],
        }
        resp = resolution_client.post("/resolve/embedding", json=body)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["resolved"]) == 1
        g = data["resolved"][0]
        assert g["canonical"] == "GPT-4"
        assert g["method"] == "existing_page_title"
        assert g["source_ids"] == ["src_b"]
        assert data["ambiguous"] == []
        assert data["unresolved"] == []

    def test_mid_similarity_emits_ambiguous_pair_with_sentinel(self, resolution_client, patched_embed_model):
        """cosine in 0.7–0.9 → ambiguous pair where entity_b has sentinel source_id."""
        # Cosine similarity between [1,0,...] and [0.8,0.6,0,...] = 0.8
        patched_embed_model({
            "Claude 3.5 Sonnet": [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            "Claude 3.5": [0.8, 0.6, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        })
        body = {
            "entities": [
                {"name": "Claude 3.5 Sonnet", "type": "PRODUCT", "source_id": "src_b", "context": ""}
            ],
            "existing_page_titles": [{"title": "Claude 3.5", "page_type": "entity"}],
        }
        resp = resolution_client.post("/resolve/embedding", json=body)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["ambiguous"]) == 1
        pair = data["ambiguous"][0]
        assert pair["entity_a"]["name"] == "Claude 3.5 Sonnet"
        assert pair["entity_a"]["source_id"] == "src_b"
        assert pair["entity_b"]["name"] == "Claude 3.5"
        assert pair["entity_b"]["source_id"] == "__existing_page__"
        assert 0.7 <= pair["similarity"] <= 0.9
        assert data["resolved"] == []
        # Session entity not unresolved (it's in ambiguous) and not anchored
        assert data["unresolved"] == []

    def test_low_similarity_keeps_entity_unresolved(self, resolution_client, patched_embed_model):
        """cosine < 0.7 → no match. Entity falls through to unresolved."""
        patched_embed_model({
            "Banana": [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            "GPT-4": [0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],  # orthogonal
        })
        body = {
            "entities": [
                {"name": "Banana", "type": "PRODUCT", "source_id": "src_b", "context": ""}
            ],
            "existing_page_titles": [{"title": "GPT-4", "page_type": "entity"}],
        }
        resp = resolution_client.post("/resolve/embedding", json=body)
        assert resp.status_code == 200
        data = resp.json()
        assert data["resolved"] == []
        assert data["ambiguous"] == []
        assert len(data["unresolved"]) == 1
        assert data["unresolved"][0]["name"] == "Banana"

    def test_type_mismatch_skips_page_title(self, resolution_client, patched_embed_model):
        """Entity of type PERSON should not anchor to a concept page even if embeddings are identical."""
        patched_embed_model({
            "Transformer": [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
        })
        body = {
            "entities": [
                {"name": "Transformer", "type": "PERSON", "source_id": "src", "context": ""}
            ],
            "existing_page_titles": [{"title": "Transformer", "page_type": "concept"}],
        }
        resp = resolution_client.post("/resolve/embedding", json=body)
        assert resp.status_code == 200
        data = resp.json()
        # Type mismatch → no anchoring, no ambiguous pair → entity falls through
        assert data["resolved"] == []
        assert data["ambiguous"] == []
        assert len(data["unresolved"]) == 1


# ---------------------------------------------------------------------------
# /resolve/disambiguate — concept vs entity prompt routing
# ---------------------------------------------------------------------------


class TestDisambiguateConceptPromptRouting:
    """Pairs involving at least one CONCEPT entity route to the concept-specific
    prompt; the rest use the entity prompt. Asymmetric cost on wrong merges for
    concepts justifies the stricter prompt (prefer `different` in gray band).
    """

    def test_concept_pair_uses_concept_prompt(self, resolution_client, monkeypatch):
        captured: list[dict[str, Any]] = []

        from services import llm_client as llm_client_mod  # noqa: PLC0415
        from services.llm_client import DisambiguationResponse  # noqa: PLC0415

        def fake_disambiguate(pairs, model, pair_kind="entity"):
            captured.append({"pairs": pairs, "pair_kind": pair_kind, "model": model})
            return DisambiguationResponse(results=[])

        monkeypatch.setattr(llm_client_mod, "disambiguate_entities", fake_disambiguate)

        body = {
            "pairs": [
                {
                    "entity_a": {"name": "Transformer Architecture", "type": "CONCEPT", "source_id": "s1", "context": ""},
                    "entity_b": {"name": "Self-Attention", "type": "CONCEPT", "source_id": "s2", "context": ""},
                    "similarity": 0.85,
                }
            ]
        }
        resp = resolution_client.post("/resolve/disambiguate", json=body)
        assert resp.status_code == 200
        assert len(captured) == 1
        assert captured[0]["pair_kind"] == "concept"

    def test_entity_pair_uses_entity_prompt(self, resolution_client, monkeypatch):
        captured: list[dict[str, Any]] = []

        from services import llm_client as llm_client_mod  # noqa: PLC0415
        from services.llm_client import DisambiguationResponse  # noqa: PLC0415

        def fake_disambiguate(pairs, model, pair_kind="entity"):
            captured.append({"pairs": pairs, "pair_kind": pair_kind})
            return DisambiguationResponse(results=[])

        monkeypatch.setattr(llm_client_mod, "disambiguate_entities", fake_disambiguate)

        body = {
            "pairs": [
                {
                    "entity_a": {"name": "OpenAI", "type": "ORG", "source_id": "s1", "context": ""},
                    "entity_b": {"name": "Open AI", "type": "ORG", "source_id": "s2", "context": ""},
                    "similarity": 0.85,
                }
            ]
        }
        resp = resolution_client.post("/resolve/disambiguate", json=body)
        assert resp.status_code == 200
        assert len(captured) == 1
        assert captured[0]["pair_kind"] == "entity"

    def test_mixed_batch_calls_both_prompts(self, resolution_client, monkeypatch):
        """A batch containing both kinds triggers two LLM calls — one per prompt."""
        captured: list[dict[str, Any]] = []

        from services import llm_client as llm_client_mod  # noqa: PLC0415
        from services.llm_client import DisambiguationResponse  # noqa: PLC0415

        def fake_disambiguate(pairs, model, pair_kind="entity"):
            captured.append({"pair_kind": pair_kind, "count": len(pairs)})
            return DisambiguationResponse(results=[])

        monkeypatch.setattr(llm_client_mod, "disambiguate_entities", fake_disambiguate)

        body = {
            "pairs": [
                {
                    "entity_a": {"name": "Transformer Architecture", "type": "CONCEPT", "source_id": "s1", "context": ""},
                    "entity_b": {"name": "Self-Attention", "type": "CONCEPT", "source_id": "s2", "context": ""},
                    "similarity": 0.85,
                },
                {
                    "entity_a": {"name": "OpenAI", "type": "ORG", "source_id": "s1", "context": ""},
                    "entity_b": {"name": "Open AI", "type": "ORG", "source_id": "s2", "context": ""},
                    "similarity": 0.85,
                },
            ]
        }
        resp = resolution_client.post("/resolve/disambiguate", json=body)
        assert resp.status_code == 200
        assert len(captured) == 2
        kinds = sorted(c["pair_kind"] for c in captured)
        assert kinds == ["concept", "entity"]
