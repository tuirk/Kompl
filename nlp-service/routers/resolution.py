"""Entity resolution endpoints — Part 2b.

Three-layer cascading matcher that resolves entity duplicates across sources
in a session:

  POST /resolve/fuzzy         — Layer 1: Levenshtein, Jaro-Winkler, substring,
                                  acronym, exact, existing-alias matching
  POST /resolve/embedding     — Layer 2: sentence-transformers cosine similarity
  POST /resolve/disambiguate  — Layer 3: Gemini LLM for 0.7–0.9 ambiguous band

Each layer receives only the entities that the previous layer left unresolved.
The orchestrator (POST /api/compile/resolve in Next.js) drives the cascade.

Implementation notes:
  - Union-Find groups entities that match on ANY of the fuzzy criteria.
  - Canonical name = longest name in the group (tie-break: alphabetically first).
  - Embedding model is a lazy singleton — loaded once on first /resolve/embedding call.
  - Compatible types for cross-type matching: {ORG, PRODUCT} and {CONCEPT, OTHER}.
    PERSON entities only match other PERSON entities.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

logger = logging.getLogger(__name__)

router = APIRouter(tags=["resolution"])

# ---------------------------------------------------------------------------
# Lazy embedding model singleton
# ---------------------------------------------------------------------------

_embed_model: Any = None


def _get_embed_model() -> Any:
    global _embed_model
    if _embed_model is None:
        from sentence_transformers import SentenceTransformer
        logger.info("Loading SentenceTransformer all-MiniLM-L6-v2 for entity resolution...")
        _embed_model = SentenceTransformer("all-MiniLM-L6-v2")
        logger.info("Embedding model loaded.")
    return _embed_model


# ---------------------------------------------------------------------------
# Shared types
# ---------------------------------------------------------------------------


class EntityInput(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str
    type: str
    source_id: str
    context: str = ""


class ResolvedGroup(BaseModel):
    model_config = ConfigDict(extra='forbid')
    canonical: str
    type: str
    aliases: list[str]
    source_ids: list[str]
    method: str   # "exact"|"levenshtein"|"jaro_winkler"|"substring"|"acronym"|"existing_alias"|"embedding"


# ---------------------------------------------------------------------------
# Union-Find helper
# ---------------------------------------------------------------------------


class _UnionFind:
    def __init__(self, n: int) -> None:
        self.parent = list(range(n))
        self.rank = [0] * n

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, x: int, y: int) -> None:
        rx, ry = self.find(x), self.find(y)
        if rx == ry:
            return
        if self.rank[rx] < self.rank[ry]:
            rx, ry = ry, rx
        self.parent[ry] = rx
        if self.rank[rx] == self.rank[ry]:
            self.rank[rx] += 1


# ---------------------------------------------------------------------------
# Type compatibility check
# ---------------------------------------------------------------------------

_COMPATIBLE_TYPE_GROUPS: list[frozenset[str]] = [
    frozenset({"ORG", "PRODUCT"}),
    frozenset({"CONCEPT", "OTHER"}),
]


def _types_compatible(t1: str, t2: str) -> bool:
    if t1 == t2:
        return True
    for group in _COMPATIBLE_TYPE_GROUPS:
        if t1 in group and t2 in group:
            return True
    return False


# ---------------------------------------------------------------------------
# Fuzzy matching helpers
# ---------------------------------------------------------------------------


def _is_acronym(short: str, long: str) -> bool:
    """Return True if short (uppercase) is the acronym of long."""
    words = long.split()
    if len(words) < 2:
        return False
    initials = "".join(w[0] for w in words if w).upper()
    return short.upper() == initials


def _fuzzy_method(a: str, b: str) -> str | None:
    """Return the best matching method name if a and b should be merged, else None."""
    al, bl = a.lower(), b.lower()

    # Exact
    if al == bl:
        return "exact"

    # Levenshtein ≤ 2 (only if both long enough to avoid false positives)
    if len(a) >= 4 and len(b) >= 4:
        from rapidfuzz.distance import Levenshtein
        if Levenshtein.distance(al, bl) <= 2:
            return "levenshtein"

    # Jaro-Winkler ≥ 0.92
    from rapidfuzz.distance import JaroWinkler
    if JaroWinkler.similarity(al, bl) >= 0.92:
        return "jaro_winkler"

    # Substring (only if length diff is reasonable — avoid "AI" matching "AI research lab")
    if abs(len(a) - len(b)) <= 15:
        if al in bl or bl in al:
            return "substring"

    # Acronym
    if _is_acronym(a, b) or _is_acronym(b, a):
        return "acronym"

    return None


def _canonical_name(names: list[str]) -> str:
    """Pick the canonical name: longest, tie-break alphabetically first."""
    return sorted(names, key=lambda n: (-len(n), n))[0]


# ---------------------------------------------------------------------------
# POST /resolve/fuzzy
# ---------------------------------------------------------------------------


class ExistingAlias(BaseModel):
    model_config = ConfigDict(extra='forbid')
    alias: str
    canonical: str


class FuzzyResolveRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    entities: list[EntityInput]
    existing_aliases: list[ExistingAlias] = []


class FuzzyResolveResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')
    resolved: list[ResolvedGroup]
    unresolved: list[EntityInput]


@router.post("/resolve/fuzzy", response_model=FuzzyResolveResponse)
def resolve_fuzzy(req: FuzzyResolveRequest) -> FuzzyResolveResponse:
    """Layer 1 fuzzy resolution.

    Checks existing aliases first (instant resolution for returning sessions),
    then applies 5 fuzzy criteria via Union-Find grouping.
    """
    entities = req.entities
    if not entities:
        return FuzzyResolveResponse(resolved=[], unresolved=[])

    n = len(entities)
    uf = _UnionFind(n)
    merge_method: dict[tuple[int, int], str] = {}  # (root, child) → method

    # Build existing alias lookup: alias_lower → canonical
    alias_lookup: dict[str, str] = {
        ea.alias.lower(): ea.canonical for ea in req.existing_aliases
    }

    # Track which entities were resolved via existing alias
    alias_canonical: dict[int, str] = {}
    for i, e in enumerate(entities):
        canon = alias_lookup.get(e.name.lower())
        if canon:
            alias_canonical[i] = canon

    # Group entities that share the same existing canonical
    canon_to_indices: dict[str, list[int]] = {}
    for i, canon in alias_canonical.items():
        canon_to_indices.setdefault(canon, []).append(i)
    for canon, indices in canon_to_indices.items():
        for j in range(1, len(indices)):
            uf.union(indices[0], indices[j])
            merge_method[(uf.find(indices[0]), j)] = "existing_alias"

    # Pairwise fuzzy matching (O(n²) — acceptable for session-level entity counts)
    for i in range(n):
        for j in range(i + 1, n):
            if uf.find(i) == uf.find(j):
                continue  # already same group
            if not _types_compatible(entities[i].type, entities[j].type):
                continue
            method = _fuzzy_method(entities[i].name, entities[j].name)
            if method:
                root = uf.find(i)
                uf.union(i, j)
                new_root = uf.find(i)
                merge_method[(new_root, j)] = method

    # Build groups from Union-Find
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(uf.find(i), []).append(i)

    resolved: list[ResolvedGroup] = []
    unresolved: list[EntityInput] = []

    for root, members in groups.items():
        if len(members) == 1:
            # Check if this single entity was matched via existing alias
            idx = members[0]
            if idx in alias_canonical:
                # Still emit as resolved (canonical from alias table)
                resolved.append(ResolvedGroup(
                    canonical=alias_canonical[idx],
                    type=entities[idx].type,
                    aliases=[entities[idx].name],
                    source_ids=[entities[idx].source_id],
                    method="existing_alias",
                ))
            else:
                unresolved.append(entities[idx])
            continue

        names = [entities[i].name for i in members]
        source_ids = list(dict.fromkeys(entities[i].source_id for i in members))  # deduplicated, ordered

        # Determine canonical: prefer existing alias canonical if available, else longest name
        canon_from_alias = next(
            (alias_canonical[i] for i in members if i in alias_canonical), None
        )
        canon = canon_from_alias or _canonical_name(names)

        aliases = [n for n in names if n != canon]

        # Best method = most specific one in the group
        method_priority = ["existing_alias", "exact", "levenshtein", "jaro_winkler", "substring", "acronym"]
        used_methods = set(merge_method.values())
        best_method = next((m for m in method_priority if m in used_methods), "fuzzy")

        resolved.append(ResolvedGroup(
            canonical=canon,
            type=entities[members[0]].type,
            aliases=aliases,
            source_ids=source_ids,
            method=best_method,
        ))

    return FuzzyResolveResponse(resolved=resolved, unresolved=unresolved)


# ---------------------------------------------------------------------------
# POST /resolve/embedding
# ---------------------------------------------------------------------------


class AmbiguousPair(BaseModel):
    model_config = ConfigDict(extra='forbid')
    entity_a: EntityInput
    entity_b: EntityInput
    similarity: float


class EmbeddingResolveRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    entities: list[EntityInput]


class EmbeddingResolveResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')
    resolved: list[ResolvedGroup]
    ambiguous: list[AmbiguousPair]
    unresolved: list[EntityInput]


@router.post("/resolve/embedding", response_model=EmbeddingResolveResponse)
def resolve_embedding(req: EmbeddingResolveRequest) -> EmbeddingResolveResponse:
    """Layer 2 embedding similarity resolution.

    Computes pairwise cosine similarity using sentence-transformers.
    Thresholds: >0.9 → merge (same entity), <0.7 → skip (different),
    0.7–0.9 → ambiguous (pass to Layer 3 LLM).
    """
    import numpy as np
    from sklearn.metrics.pairwise import cosine_similarity as sklearn_cosine

    entities = req.entities
    if not entities:
        return EmbeddingResolveResponse(resolved=[], ambiguous=[], unresolved=[])

    model = _get_embed_model()

    # Embed name + context for each entity
    texts = [f"{e.name}: {e.context}" if e.context else e.name for e in entities]
    embeddings = model.encode(texts, convert_to_numpy=True)

    n = len(entities)
    uf = _UnionFind(n)
    ambiguous_pairs: list[AmbiguousPair] = []
    seen_ambiguous: set[tuple[int, int]] = set()

    # Pairwise similarity (only same/compatible types)
    similarities: Any = sklearn_cosine(embeddings)

    for i in range(n):
        for j in range(i + 1, n):
            if not _types_compatible(entities[i].type, entities[j].type):
                continue
            sim = float(similarities[i][j])
            if sim > 0.9:
                uf.union(i, j)
            elif 0.7 <= sim <= 0.9:
                pair_key = (min(i, j), max(i, j))
                if pair_key not in seen_ambiguous:
                    seen_ambiguous.add(pair_key)
                    ambiguous_pairs.append(AmbiguousPair(
                        entity_a=entities[i],
                        entity_b=entities[j],
                        similarity=round(sim, 4),
                    ))

    # Build resolved groups and unresolved singletons
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(uf.find(i), []).append(i)

    resolved: list[ResolvedGroup] = []
    unresolved_entities: list[EntityInput] = []
    ambiguous_indices: set[int] = set()

    for pair in ambiguous_pairs:
        # Find indices for ambiguous pair members
        for i, e in enumerate(entities):
            if e.name == pair.entity_a.name and e.source_id == pair.entity_a.source_id:
                ambiguous_indices.add(i)
            if e.name == pair.entity_b.name and e.source_id == pair.entity_b.source_id:
                ambiguous_indices.add(i)

    for root, members in groups.items():
        if len(members) == 1:
            idx = members[0]
            if idx not in ambiguous_indices:
                unresolved_entities.append(entities[idx])
            # ambiguous singletons are returned via ambiguous_pairs
            continue

        names = [entities[i].name for i in members]
        source_ids = list(dict.fromkeys(entities[i].source_id for i in members))
        canon = _canonical_name(names)
        aliases = [n for n in names if n != canon]
        resolved.append(ResolvedGroup(
            canonical=canon,
            type=entities[members[0]].type,
            aliases=aliases,
            source_ids=source_ids,
            method="embedding",
        ))

    return EmbeddingResolveResponse(
        resolved=resolved,
        ambiguous=ambiguous_pairs,
        unresolved=unresolved_entities,
    )


# ---------------------------------------------------------------------------
# POST /resolve/disambiguate
# ---------------------------------------------------------------------------


class DisambiguateRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    pairs: list[AmbiguousPair]


class DisambiguateResponseItem(BaseModel):
    model_config = ConfigDict(extra='forbid')
    entity_a: str
    entity_b: str
    decision: str           # "same" | "different" | "ambiguous"
    canonical: str | None = None
    reason: str


class DisambiguateResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')
    results: list[DisambiguateResponseItem]


@router.post("/resolve/disambiguate", response_model=DisambiguateResponse)
def resolve_disambiguate(req: DisambiguateRequest) -> DisambiguateResponse:
    """Layer 3 LLM disambiguation.

    Receives ambiguous pairs (0.7–0.9 cosine similarity band) and calls
    Gemini 2.5 Flash to decide same/different/ambiguous. Batches up to
    10 pairs per LLM call.
    """
    from services.llm_client import (
        CostCeilingError,
        LLMCompileError,
        LLMRateLimitedError,
        disambiguate_entities,
    )

    if not req.pairs:
        return DisambiguateResponse(results=[])

    # Build pair dicts for the LLM call
    pair_dicts = [
        {
            "entity_a": {"name": p.entity_a.name, "type": p.entity_a.type, "context": p.entity_a.context},
            "entity_b": {"name": p.entity_b.name, "type": p.entity_b.type, "context": p.entity_b.context},
        }
        for p in req.pairs
    ]

    # Batch: max 10 pairs per call
    all_results: list[DisambiguateResponseItem] = []
    for batch_start in range(0, len(pair_dicts), 10):
        batch = pair_dicts[batch_start:batch_start + 10]
        try:
            resp = disambiguate_entities(batch)
        except LLMRateLimitedError as e:
            raise HTTPException(status_code=429, detail=str(e)) from e
        except CostCeilingError as e:
            raise HTTPException(status_code=503, detail=str(e)) from e
        except LLMCompileError as e:
            raise HTTPException(status_code=500, detail=str(e)) from e

        for r in resp.results:
            all_results.append(DisambiguateResponseItem(
                entity_a=r.entity_a,
                entity_b=r.entity_b,
                decision=r.decision,
                canonical=r.canonical,
                reason=r.reason,
            ))

    return DisambiguateResponse(results=all_results)
