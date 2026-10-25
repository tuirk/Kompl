"""POST /resolve/name-similarity — how alike two names are, names alone.

The app's alias screen (app/src/lib/alias-screen.ts) sets aside stored
aliases whose names share no content words unless the names themselves
mean nearly the same ("English" -> "programming language" was stored from
two contexts that were alike). It needs the same name-only similarity
Layer 2 uses (routers/resolution.py: the shared all-MiniLM-L6-v2 model
over the raw names), so it asks here. Stateless; no LLM, no database.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from routers import resolution

router = APIRouter(tags=["resolution"])

# Pairs per request. The app sends them in chunks of this size or fewer.
MAX_NAME_PAIRS = 1000


class NamePair(BaseModel):
    model_config = ConfigDict(extra='forbid')
    a: str
    b: str


class NameSimilarityRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    pairs: list[NamePair] = Field(max_length=MAX_NAME_PAIRS)


class NameSimilarityItem(BaseModel):
    model_config = ConfigDict(extra='forbid')
    a: str
    b: str
    similarity: float


class NameSimilarityResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')
    items: list[NameSimilarityItem]
    count: int


@router.post("/resolve/name-similarity", response_model=NameSimilarityResponse)
def name_similarity(req: NameSimilarityRequest) -> NameSimilarityResponse:
    """Cosine similarity of each pair's names, in request order. A name
    the model gives no vector scores 0."""
    if not req.pairs:
        return NameSimilarityResponse(items=[], count=0)

    names = list(dict.fromkeys(n for p in req.pairs for n in (p.a, p.b)))
    model: Any = resolution._get_embed_model()
    vectors = np.asarray(model.encode(names, convert_to_numpy=True), dtype=np.float64)
    norms = np.linalg.norm(vectors, axis=1)
    row = {n: k for k, n in enumerate(names)}

    items: list[NameSimilarityItem] = []
    for p in req.pairs:
        i, j = row[p.a], row[p.b]
        denom = norms[i] * norms[j]
        sim = float(np.dot(vectors[i], vectors[j]) / denom) if denom > 0 else 0.0
        items.append(NameSimilarityItem(a=p.a, b=p.b, similarity=round(sim, 4)))
    return NameSimilarityResponse(items=items, count=len(items))
