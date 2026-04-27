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
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

GeminiModel = Literal[
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
]

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
    method: str   # "exact"|"levenshtein"|"jaro_winkler"|"substring"|"acronym"|"existing_alias"|"embedding"|"existing_page_title"


class ExistingPageTitle(BaseModel):
    """Anchor for cross-session matching: an entity/concept page that already
    exists in the wiki. Layer 1 fuzzy and Layer 2 embedding compare incoming
    session entities against these titles, so a singleton "GPT 4" in session
    B resolves to the existing "GPT-4" page without needing a prior in-session
    merge to populate the aliases table.
    """
    model_config = ConfigDict(extra='forbid')
    title: str
    page_type: str  # 'entity' | 'concept'


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


# Entity-type → page-type compatibility for cross-session matching.
# Entity pages cover proper-noun entities (PERSON/ORG/PRODUCT/LOCATION/EVENT)
# plus OTHER as catchall. Concept pages cover CONCEPT plus OTHER as catchall.
# OTHER appears in both so the catchall can resolve either way.
_ENTITY_PAGE_TYPES = frozenset({"PERSON", "ORG", "PRODUCT", "LOCATION", "EVENT", "OTHER"})
_CONCEPT_PAGE_TYPES = frozenset({"CONCEPT", "OTHER"})


def _entity_matches_page_type(entity_type: str, page_type: str) -> bool:
    if page_type == "entity":
        return entity_type in _ENTITY_PAGE_TYPES
    if page_type == "concept":
        return entity_type in _CONCEPT_PAGE_TYPES
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
    """Return the best matching method name if a and b should be merged, else None.

    Used for SAME-SESSION pairwise grouping where the inputs are sibling
    extractions from the same source pool — substring/acronym signals are
    soft-priors there ("Karpathy" + "A. Karpathy" in one article pool are
    almost certainly the same person).
    """
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


def _cross_session_method(a: str, b: str) -> str | None:
    """Stricter variant of _fuzzy_method for cross-session anchoring against
    existing wiki page titles.

    Drops the substring branch. Substring matching is a fine soft-prior for
    same-session pairs but over-merges when one side is an authoritative,
    permanent wiki page title — e.g. extracting "Vilnius" from a new source
    must NOT bind to an existing "Vilnius Cathedral" page just because one
    is a character-level substring of the other. The same shape hits cities
    vs landmarks (London ↔ London Eye), parents vs subsidiaries, brands vs
    product lines.

    Layer 2 embedding similarity handles the legitimate cross-session cases
    (e.g. "Andrej Karpathy" ↔ existing "Karpathy" page) semantically,
    sending borderline pairs to Layer 3 LLM disambiguation.
    """
    al, bl = a.lower(), b.lower()

    if al == bl:
        return "exact"

    if len(a) >= 4 and len(b) >= 4:
        from rapidfuzz.distance import Levenshtein
        if Levenshtein.distance(al, bl) <= 2:
            return "levenshtein"

    from rapidfuzz.distance import JaroWinkler
    if JaroWinkler.similarity(al, bl) >= 0.92:
        return "jaro_winkler"

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
    existing_page_titles: list[ExistingPageTitle] = []


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

    # Track which entities were resolved via existing alias or existing page title.
    # Both bind an entity to an already-known canonical without further fuzzy work.
    alias_canonical: dict[int, str] = {}
    alias_method: dict[int, str] = {}  # "existing_alias" | "existing_page_title"
    for i, e in enumerate(entities):
        canon = alias_lookup.get(e.name.lower())
        if canon:
            alias_canonical[i] = canon
            alias_method[i] = "existing_alias"

    # Cross-session anchor: match unbound entities against existing wiki page titles.
    # Exact case-insensitive match first; fuzzy second. Page-type gates entity-type
    # compatibility (entity page ↔ non-concept types; concept page ↔ CONCEPT/OTHER).
    page_title_lookup: dict[str, ExistingPageTitle] = {
        pt.title.lower(): pt for pt in req.existing_page_titles
    }
    for i, e in enumerate(entities):
        if i in alias_canonical:
            continue
        # Exact match
        pt_exact = page_title_lookup.get(e.name.lower())
        if pt_exact and _entity_matches_page_type(e.type, pt_exact.page_type):
            alias_canonical[i] = pt_exact.title
            alias_method[i] = "existing_page_title"
            continue
        # Fuzzy match against any page title — uses the strict cross-session
        # matcher (no substring) to avoid binding short-name entities to
        # longer-name pages they happen to be a character-level prefix of
        # (e.g. "Vilnius" ↔ existing "Vilnius Cathedral"). Layer 2 embedding
        # handles those semantically.
        for pt in req.existing_page_titles:
            if not _entity_matches_page_type(e.type, pt.page_type):
                continue
            if _cross_session_method(e.name, pt.title):
                alias_canonical[i] = pt.title
                alias_method[i] = "existing_page_title"
                break

    # Group entities that share the same existing canonical
    canon_to_indices: dict[str, list[int]] = {}
    for i, canon in alias_canonical.items():
        canon_to_indices.setdefault(canon, []).append(i)
    for canon, indices in canon_to_indices.items():
        for j in range(1, len(indices)):
            uf.union(indices[0], indices[j])
            merge_method[(uf.find(indices[0]), j)] = alias_method.get(indices[0], "existing_alias")

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
            # Check if this single entity was matched via existing alias or page title
            idx = members[0]
            if idx in alias_canonical:
                # Still emit as resolved (canonical from alias table or existing page)
                resolved.append(ResolvedGroup(
                    canonical=alias_canonical[idx],
                    type=entities[idx].type,
                    aliases=[entities[idx].name],
                    source_ids=[entities[idx].source_id],
                    method=alias_method.get(idx, "existing_alias"),
                ))
            else:
                unresolved.append(entities[idx])
            continue

        names = [entities[i].name for i in members]
        source_ids = list(dict.fromkeys(entities[i].source_id for i in members))  # deduplicated, ordered

        # Determine canonical: prefer existing alias/page-title canonical if available, else longest name
        canon_from_alias = next(
            (alias_canonical[i] for i in members if i in alias_canonical), None
        )
        canon = canon_from_alias or _canonical_name(names)

        aliases = [n for n in names if n != canon]

        # Best method = most specific one in the group. Page-title binding
        # takes precedence over same-session fuzzy signals because it's
        # authoritative (the target already exists in the wiki).
        method_priority = ["existing_page_title", "existing_alias", "exact", "levenshtein", "jaro_winkler", "substring", "acronym"]
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
    existing_page_titles: list[ExistingPageTitle] = []


class EmbeddingResolveResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')
    resolved: list[ResolvedGroup]
    ambiguous: list[AmbiguousPair]
    unresolved: list[EntityInput]


# Sentinel source_id for synthetic EntityInput representing an existing wiki page
# title in an AmbiguousPair. The Next.js consumer recognises this value and
# handles it differently from real session sources when Layer 3 returns a decision.
EXISTING_PAGE_SENTINEL = "__existing_page__"


def _page_type_to_entity_type(page_type: str) -> str:
    """Map pages.page_type to a representative entity type for synthetic pairs."""
    if page_type == "concept":
        return "CONCEPT"
    return "OTHER"


@router.post("/resolve/embedding", response_model=EmbeddingResolveResponse)
def resolve_embedding(req: EmbeddingResolveRequest) -> EmbeddingResolveResponse:
    """Layer 2 embedding similarity resolution.

    Computes pairwise cosine similarity using sentence-transformers.
    Thresholds: >0.9 → merge (same entity), <0.7 → skip (different),
    0.7–0.9 → ambiguous (pass to Layer 3 LLM).

    Cross-session extension: if existing_page_titles is non-empty, each
    session entity is also compared against those titles. >0.9 anchors the
    entity to the page title (emitted as a ResolvedGroup with method
    'existing_page_title'). 0.7–0.9 emits an AmbiguousPair whose entity_b is
    a synthetic EntityInput carrying the sentinel source_id, so Layer 3 LLM
    can triage whether the session entity is the same topic as the existing
    wiki page.
    """
    from sklearn.metrics.pairwise import cosine_similarity as sklearn_cosine

    entities = req.entities
    if not entities:
        return EmbeddingResolveResponse(resolved=[], ambiguous=[], unresolved=[])

    model = _get_embed_model()

    # Embed name + context for each session entity
    texts = [f"{e.name}: {e.context}" if e.context else e.name for e in entities]
    embeddings = model.encode(texts, convert_to_numpy=True)

    n = len(entities)
    uf = _UnionFind(n)
    ambiguous_pairs: list[AmbiguousPair] = []
    seen_ambiguous: set[tuple[int, int]] = set()

    # Cross-session anchor resolution — compare each session entity to existing
    # wiki page titles. Must run BEFORE session-internal UF so that anchored
    # entities don't get pulled into session merges with a different canonical.
    anchored: dict[int, tuple[str, float]] = {}  # entity_index → (page_title, similarity)
    if req.existing_page_titles:
        pt_titles = [pt.title for pt in req.existing_page_titles]
        pt_embeddings = model.encode(pt_titles, convert_to_numpy=True)
        # Shape: (n_entities, n_page_titles)
        pt_similarities: Any = sklearn_cosine(embeddings, pt_embeddings)

        for i in range(n):
            best_sim = -1.0
            best_pt_idx = -1
            for j, pt in enumerate(req.existing_page_titles):
                if not _entity_matches_page_type(entities[i].type, pt.page_type):
                    continue
                sim = float(pt_similarities[i][j])
                if sim > best_sim:
                    best_sim = sim
                    best_pt_idx = j

            if best_pt_idx < 0:
                continue
            best_pt = req.existing_page_titles[best_pt_idx]

            if best_sim > 0.9:
                # Anchor: emit as resolved group directly, skip session-internal UF.
                anchored[i] = (best_pt.title, best_sim)
            elif 0.7 <= best_sim <= 0.9:
                # Ambiguous cross-session pair — Layer 3 decides.
                synthetic = EntityInput(
                    name=best_pt.title,
                    type=_page_type_to_entity_type(best_pt.page_type),
                    source_id=EXISTING_PAGE_SENTINEL,
                    context="",
                )
                ambiguous_pairs.append(AmbiguousPair(
                    entity_a=entities[i],
                    entity_b=synthetic,
                    similarity=round(best_sim, 4),
                ))

    # Session-internal pairwise similarity (only same/compatible types).
    # Anchored entities are excluded — they already have a canonical from a wiki page.
    similarities: Any = sklearn_cosine(embeddings)

    for i in range(n):
        if i in anchored:
            continue
        for j in range(i + 1, n):
            if j in anchored:
                continue
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
        if i in anchored:
            continue  # handled separately below
        groups.setdefault(uf.find(i), []).append(i)

    resolved: list[ResolvedGroup] = []
    unresolved_entities: list[EntityInput] = []
    ambiguous_indices: set[int] = set()

    for pair in ambiguous_pairs:
        # Find indices for ambiguous pair members (real session entities only —
        # synthetic EXISTING_PAGE_SENTINEL entities aren't in `entities`).
        for i, e in enumerate(entities):
            if pair.entity_a.source_id != EXISTING_PAGE_SENTINEL and \
               e.name == pair.entity_a.name and e.source_id == pair.entity_a.source_id:
                ambiguous_indices.add(i)
            if pair.entity_b.source_id != EXISTING_PAGE_SENTINEL and \
               e.name == pair.entity_b.name and e.source_id == pair.entity_b.source_id:
                ambiguous_indices.add(i)

    # Emit ResolvedGroup for each anchored entity (canonical = existing page title)
    for i, (page_title, _sim) in anchored.items():
        resolved.append(ResolvedGroup(
            canonical=page_title,
            type=entities[i].type,
            aliases=[entities[i].name] if entities[i].name != page_title else [],
            source_ids=[entities[i].source_id],
            method="existing_page_title",
        ))

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
    compile_model: GeminiModel = "gemini-2.5-flash"


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

    # Partition pairs by kind: concept pairs (either side CONCEPT) get the
    # stricter concept-disambiguation prompt; the rest use the entity prompt.
    # Concepts have fuzzier boundaries — share vocabulary across distinct
    # ideas — so the concept prompt errs toward "different" in the gray band.
    concept_pairs: list[dict[str, Any]] = []
    entity_pairs: list[dict[str, Any]] = []
    for p in req.pairs:
        pair_dict = {
            "entity_a": {"name": p.entity_a.name, "type": p.entity_a.type, "context": p.entity_a.context},
            "entity_b": {"name": p.entity_b.name, "type": p.entity_b.type, "context": p.entity_b.context},
        }
        if p.entity_a.type == "CONCEPT" or p.entity_b.type == "CONCEPT":
            concept_pairs.append(pair_dict)
        else:
            entity_pairs.append(pair_dict)

    all_results: list[DisambiguateResponseItem] = []

    def _call_in_batches(pairs: list[dict[str, Any]], pair_kind: str) -> None:
        for batch_start in range(0, len(pairs), 10):
            batch = pairs[batch_start:batch_start + 10]
            try:
                resp = disambiguate_entities(batch, model=req.compile_model, pair_kind=pair_kind)
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

    if entity_pairs:
        _call_in_batches(entity_pairs, "entity")
    if concept_pairs:
        _call_in_batches(concept_pairs, "concept")

    return DisambiguateResponse(results=all_results)
