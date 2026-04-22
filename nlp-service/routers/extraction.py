"""Extraction router for Kompl v2 nlp-service — Part 2a.

Endpoints:
  POST /extract/ner            — spaCy NER + entity density signal
  POST /extract/rake           — RAKE keyphrase extraction
  POST /extract/keybert        — KeyBERT keyphrase extraction
  POST /extract/textrank       — TextRank via pytextrank spaCy component
  POST /extract/yake           — YAKE keyphrase extraction
  POST /extract/tfidf-overlap  — TF-IDF cosine similarity vs wiki page corpus
  POST /extract/tfidf-rank     — TF-IDF rank: score N candidate texts against one query
  POST /extract/route          — Profile router (pure logic, no ML)

NLP models are lazy-initialized on first request and cached as module-level
singletons. spaCy + pytextrank share a single pipeline instance. KeyBERT
loads sentence-transformers (all-MiniLM-L6-v2) on first use.

All request/response models use ConfigDict(extra='forbid') — these are API
boundary validators, not LLM output models.

This router NEVER opens kompl.db. rule #1 in CLAUDE.md.
"""

from __future__ import annotations

import logging

import yake as yake_lib
import spacy
import pytextrank  # noqa: F401 — registers the "textrank" spaCy factory on import
from keybert import KeyBERT
from rake_nltk import Rake
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from services.file_store import read_page

logger = logging.getLogger(__name__)

router = APIRouter(tags=["extraction"])

# ── Lazy model singletons ──────────────────────────────────────────────────────

_nlp: "spacy.language.Language | None" = None
_kw_model: "KeyBERT | None" = None

# Cap input length to avoid memory spikes on very long documents.
_TEXT_CAP = 100_000


def _get_nlp() -> "spacy.language.Language":
    global _nlp
    if _nlp is None:
        logger.info("Loading spaCy model en_core_web_sm + pytextrank...")
        _nlp = spacy.load("en_core_web_sm")
        _nlp.add_pipe("textrank")  # pytextrank component for /extract/textrank
        logger.info("spaCy model loaded.")
    return _nlp


def _get_kw_model() -> "KeyBERT":
    global _kw_model
    if _kw_model is None:
        logger.info("Loading KeyBERT (sentence-transformers/all-MiniLM-L6-v2)...")
        _kw_model = KeyBERT()
        logger.info("KeyBERT loaded.")
    return _kw_model


# ── NER ───────────────────────────────────────────────────────────────────────


class NerEntity(BaseModel):
    model_config = ConfigDict(extra='forbid')

    text: str
    label: str
    start: int
    end: int


class NerRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    text: str
    source_id: str


class NerResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    source_id: str
    entities: list[NerEntity]
    entity_count: int
    entity_density: str  # "high" | "medium" | "low"


@router.post("/extract/ner", response_model=NerResponse)
def extract_ner(req: NerRequest) -> NerResponse:
    nlp = _get_nlp()
    doc = nlp(req.text[:_TEXT_CAP])
    entities = [
        NerEntity(
            text=ent.text,
            label=ent.label_,
            start=ent.start_char,
            end=ent.end_char,
        )
        for ent in doc.ents
    ]
    count = len(entities)
    if count >= 20:
        density = "high"
    elif count >= 5:
        density = "medium"
    else:
        density = "low"
    return NerResponse(
        source_id=req.source_id,
        entities=entities,
        entity_count=count,
        entity_density=density,
    )


# ── Shared keyphrase response shape ──────────────────────────────────────────


class Keyphrase(BaseModel):
    model_config = ConfigDict(extra='forbid')

    phrase: str
    score: float


class KeyphraseResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    keyphrases: list[Keyphrase]


# ── RAKE ──────────────────────────────────────────────────────────────────────


class RakeRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    text: str
    top_n: int = 20


@router.post("/extract/rake", response_model=KeyphraseResponse)
def extract_rake(req: RakeRequest) -> KeyphraseResponse:
    r = Rake()
    r.extract_keywords_from_text(req.text)
    # get_ranked_phrases_with_scores() returns list of (score, phrase) tuples.
    ranked = r.get_ranked_phrases_with_scores()
    top = ranked[: req.top_n]
    return KeyphraseResponse(
        keyphrases=[Keyphrase(phrase=phrase, score=float(score)) for score, phrase in top]
    )


# ── KeyBERT ───────────────────────────────────────────────────────────────────


class KeybertRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    text: str
    top_n: int = 20


@router.post("/extract/keybert", response_model=KeyphraseResponse)
def extract_keybert(req: KeybertRequest) -> KeyphraseResponse:
    model = _get_kw_model()
    # extract_keywords returns list of (phrase, score) tuples.
    keywords = model.extract_keywords(req.text, top_n=req.top_n)
    return KeyphraseResponse(
        keyphrases=[Keyphrase(phrase=phrase, score=float(score)) for phrase, score in keywords]
    )


# ── TextRank (pytextrank via spaCy component) ─────────────────────────────────


class TextrankRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    text: str
    top_n: int = 20


@router.post("/extract/textrank", response_model=KeyphraseResponse)
def extract_textrank(req: TextrankRequest) -> KeyphraseResponse:
    nlp = _get_nlp()
    doc = nlp(req.text[:_TEXT_CAP])
    # doc._.phrases is sorted by rank descending (pytextrank default).
    phrases = [
        Keyphrase(phrase=phrase.text, score=float(phrase.rank))
        for phrase in doc._.phrases[: req.top_n]
    ]
    return KeyphraseResponse(keyphrases=phrases)


# ── YAKE ──────────────────────────────────────────────────────────────────────


class YakeRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    text: str
    top_n: int = 20


@router.post("/extract/yake", response_model=KeyphraseResponse)
def extract_yake(req: YakeRequest) -> KeyphraseResponse:
    # YAKE scores are inverted — lower = more relevant.
    extractor = yake_lib.KeywordExtractor(top=req.top_n)
    keywords = extractor.extract_keywords(req.text)
    # extract_keywords returns list of (keyword, score) tuples.
    return KeyphraseResponse(
        keyphrases=[Keyphrase(phrase=kw, score=float(score)) for kw, score in keywords]
    )


# ── TF-IDF overlap ────────────────────────────────────────────────────────────


class TfidfTopMatch(BaseModel):
    model_config = ConfigDict(extra='forbid')

    page_id: str
    similarity: float


class TfidfOverlapRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    source_text: str
    corpus_page_ids: list[str]
    page_type_filter: list[str] | None = None  # e.g. ['entity', 'concept'] — caller filters before passing; stored for future use


class TfidfOverlapResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    overlap_score: float
    top_matches: list[TfidfTopMatch]


@router.post("/extract/tfidf-overlap", response_model=TfidfOverlapResponse)
def extract_tfidf_overlap(req: TfidfOverlapRequest) -> TfidfOverlapResponse:
    if not req.corpus_page_ids:
        return TfidfOverlapResponse(overlap_score=0.0, top_matches=[])

    corpus_texts: list[str] = []
    valid_ids: list[str] = []
    for page_id in req.corpus_page_ids:
        text = read_page(page_id)
        if text:
            corpus_texts.append(text)
            valid_ids.append(page_id)

    if not corpus_texts:
        return TfidfOverlapResponse(overlap_score=0.0, top_matches=[])

    all_docs = [req.source_text] + corpus_texts
    try:
        vectorizer = TfidfVectorizer(max_features=5000, stop_words="english")
        tfidf_matrix = vectorizer.fit_transform(all_docs)
    except ValueError:
        # Empty vocabulary (all stop words, etc.)
        return TfidfOverlapResponse(overlap_score=0.0, top_matches=[])

    source_vec = tfidf_matrix[0]
    corpus_matrix = tfidf_matrix[1:]
    sims: list[float] = cosine_similarity(source_vec, corpus_matrix)[0].tolist()

    matches = sorted(
        [
            TfidfTopMatch(page_id=pid, similarity=float(s))
            for pid, s in zip(valid_ids, sims)
        ],
        key=lambda m: m.similarity,
        reverse=True,
    )[:10]

    overlap_score = max(sims) if sims else 0.0
    return TfidfOverlapResponse(overlap_score=overlap_score, top_matches=matches)


# ── TF-IDF rank: score N candidate texts against one query ────────────────────
# Used by the draft step's dossier capping (Flag 3A). The caller passes
# the candidate texts inline so this endpoint does not need to read page
# files — it's a pure math layer. Query is typically the plan title (+
# existing page markdown for update actions). Candidates are the alias-
# filtered per-source dossier blocks. Returns score per candidate id,
# ordered as input.


class TfidfRankCandidate(BaseModel):
    model_config = ConfigDict(extra='forbid')

    id: str
    text: str


class TfidfRankRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    query: str = Field(min_length=1)
    candidates: list[TfidfRankCandidate]


class TfidfRankScore(BaseModel):
    model_config = ConfigDict(extra='forbid')

    id: str
    score: float


class TfidfRankResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    scores: list[TfidfRankScore]


@router.post("/extract/tfidf-rank", response_model=TfidfRankResponse)
def extract_tfidf_rank(req: TfidfRankRequest) -> TfidfRankResponse:
    if not req.candidates:
        return TfidfRankResponse(scores=[])

    # Candidates with empty text collapse to score 0 without feeding them
    # into the vectorizer (sklearn would raise on all-empty corpora).
    valid: list[TfidfRankCandidate] = [c for c in req.candidates if c.text.strip()]
    empty_ids = [c.id for c in req.candidates if not c.text.strip()]

    scored: list[TfidfRankScore] = [TfidfRankScore(id=cid, score=0.0) for cid in empty_ids]

    if valid:
        all_docs = [req.query] + [c.text for c in valid]
        try:
            vectorizer = TfidfVectorizer(max_features=5000, stop_words="english")
            tfidf_matrix = vectorizer.fit_transform(all_docs)
        except ValueError:
            # Empty vocabulary after stop-word filtering — treat as no-signal.
            for c in valid:
                scored.append(TfidfRankScore(id=c.id, score=0.0))
        else:
            query_vec = tfidf_matrix[0]
            candidate_matrix = tfidf_matrix[1:]
            sims = cosine_similarity(query_vec, candidate_matrix)[0].tolist()
            for c, s in zip(valid, sims):
                scored.append(TfidfRankScore(id=c.id, score=float(s)))

    # Preserve the request's input order so the TS caller can do stable
    # tiebreakers (score DESC, source_id ASC) without worrying about
    # server-side reordering.
    score_by_id = {s.id: s for s in scored}
    ordered = [score_by_id[c.id] for c in req.candidates if c.id in score_by_id]
    return TfidfRankResponse(scores=ordered)


# ── Extraction profile router (pure logic) ────────────────────────────────────


class RouteRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    source_id: str
    content_length: str   # "short" | "medium" | "long"
    content_type: str     # "article" | "note" | "tweet" | etc. (informational only)
    entity_density: str   # "high" | "medium" | "low"
    wiki_exists: bool


class RouteResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    profile: str
    methods: list[str]
    skip: list[str]


_ALL_METHODS = {"rake", "keybert", "textrank", "yake", "tfidf-overlap"}


@router.post("/extract/route", response_model=RouteResponse)
def extract_route(req: RouteRequest) -> RouteResponse:
    """Select extraction methods based on content signals (PRD 4.2 profiles).

    Short  (<500 words)              → RAKE only
    Medium + entity-heavy            → RAKE (+ tfidf-overlap if wiki exists)
    Medium + concept-heavy           → KeyBERT + TextRank (+ tfidf-overlap)
    Long   (5k+ words)               → KeyBERT + TextRank (+ tfidf-overlap)
    tfidf-overlap only when wiki_exists=True and content is not short.
    """
    methods: set[str]

    if req.content_length == "short":
        profile = "short"
        methods = {"rake", "yake"}
    elif req.content_length == "long":
        profile = "long"
        methods = {"keybert", "textrank", "yake"}
    elif req.entity_density == "high":
        profile = "medium-entity-heavy"
        methods = {"rake", "yake"}
    else:
        profile = "medium-concept-heavy"
        methods = {"keybert", "textrank", "yake"}

    if req.wiki_exists and req.content_length != "short":
        methods.add("tfidf-overlap")

    skip = sorted(_ALL_METHODS - methods)
    return RouteResponse(profile=profile, methods=sorted(methods), skip=skip)
