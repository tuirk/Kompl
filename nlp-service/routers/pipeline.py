"""Pipeline router for Kompl v2 nlp-service (commits 4 + 11 + Part 2a).

Endpoints:
  POST /pipeline/compile-simple  (commit 4)
    Compile raw markdown → structured wiki page via Gemini.

  POST /pipeline/lint-scan  (commit 11)
    Lightweight LLM call: scan page summaries for contradictions.
    Called by /api/wiki/lint-pass (Next.js) during the lint operation.
    Best-effort — rate limit / cost ceiling errors return empty results
    rather than HTTP errors, so the lint pass never fails because of LLM budget.

  POST /pipeline/compile-entity-stub  (commit 12/Tier-2 bridge)
    Lightweight LLM call: write a minimal stub page for a single entity/concept.
    Called by Phase 3 of /api/compile/commit for each entity extracted during compile.
    Uses max_output_tokens=1024 and thinking_budget=0 (no chain-of-thought needed).
    Replaced at commit 10 when the full multi-layer NLP pipeline lands.

  POST /pipeline/extract-llm  (Part 2a)
    Gemini 2.5 Flash structured extraction: entities, concepts, claims,
    relationships, contradictions, summary. Called by /api/compile/extract
    (Next.js) after NLP pre-processing (NER + keyphrase profile) is complete.
    thinking_budget=-1 (full thinking), temperature=0 (deterministic).

This router NEVER opens kompl.db. rule #1 in CLAUDE.md.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

from services.llm_client import (
    CompileResponse,
    Contradiction,
    CostCeilingError,
    CrossrefResponse,
    EntityStubResponse,
    LintScanResponse,
    LLMCompileError,
    LLMExtractionResponse,
    LLMRateLimitedError,
    compile_entity_stub,
    compile_source,
    crossref_pages,
    draft_page,
    extract_source,
    generate_schema,
    lint_scan,
)

router = APIRouter(tags=["pipeline"])


class CompileSimpleRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    source_id: str
    markdown: str


@router.post("/pipeline/compile-simple", response_model=CompileResponse)
def pipeline_compile_simple(req: CompileSimpleRequest) -> CompileResponse:
    """Compile a source's raw markdown into structured wiki content via Gemini.

    HTTP 429 when rate limit bucket is full.
    HTTP 503 when daily cost ceiling is exceeded.
    HTTP 500 when the LLM call fails or the JSON response cannot be parsed.
    """
    try:
        return compile_source(req.source_id, req.markdown)
    except LLMRateLimitedError as e:
        raise HTTPException(status_code=429, detail="llm_rate_limited") from e
    except CostCeilingError as e:
        raise HTTPException(status_code=503, detail="daily_cost_ceiling") from e
    except LLMCompileError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


class EntityStubRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    name: str
    entity_type: str


@router.post("/pipeline/compile-entity-stub", response_model=EntityStubResponse)
def pipeline_compile_entity_stub(req: EntityStubRequest) -> EntityStubResponse:
    """Write a minimal stub page for a single entity/concept extracted during compile.

    Cheaper than compile-simple: max_output_tokens=1024, thinking_budget=0.
    Called by Phase 3 of /api/compile/commit for each entity in compileResult.entities.

    HTTP 429 when rate limit bucket is full (caller falls back to empty stub).
    HTTP 503 when daily cost ceiling is exceeded.
    HTTP 500 when the LLM call fails or the JSON response cannot be parsed.
    """
    try:
        return compile_entity_stub(req.name, req.entity_type)
    except LLMRateLimitedError as e:
        raise HTTPException(status_code=429, detail="llm_rate_limited") from e
    except CostCeilingError as e:
        raise HTTPException(status_code=503, detail="daily_cost_ceiling") from e
    except LLMCompileError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


class LintScanRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    pages: list[str]  # list of "[page_id] title: summary" strings


class ExtractLLMRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    source_id: str
    markdown: str
    ner_output: dict   # type: ignore[type-arg]  # JSON from /extract/ner
    keyphrase_output: dict | None = None   # type: ignore[type-arg]
    tfidf_output: dict | None = None       # type: ignore[type-arg]


@router.post("/pipeline/extract-llm", response_model=LLMExtractionResponse)
def pipeline_extract_llm(req: ExtractLLMRequest) -> LLMExtractionResponse:
    """Structured knowledge extraction via Gemini 2.5 Flash (Part 2a).

    Called by /api/compile/extract (Next.js) after NLP pre-processing.
    Accepts pre-computed NER and keyphrase outputs as context.

    HTTP 429 when rate limit bucket is full.
    HTTP 503 when daily cost ceiling is exceeded.
    HTTP 500 when the LLM call fails or JSON parse fails.
    """
    try:
        return extract_source(
            req.source_id,
            req.markdown,
            req.ner_output,
            req.keyphrase_output,
            req.tfidf_output,
        )
    except LLMRateLimitedError as e:
        raise HTTPException(status_code=429, detail="llm_rate_limited") from e
    except CostCeilingError as e:
        raise HTTPException(status_code=503, detail="daily_cost_ceiling") from e
    except LLMCompileError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.post("/pipeline/lint-scan", response_model=LintScanResponse)
def pipeline_lint_scan(req: LintScanRequest) -> LintScanResponse:
    """Scan page summaries for contradictions via Gemini.

    Best-effort: rate limit and cost ceiling errors return an empty
    contradictions list rather than raising HTTP errors. The caller
    (lint-pass) wraps this in a try/catch anyway.
    """
    if not req.pages:
        return LintScanResponse(contradictions=[])
    try:
        return lint_scan(req.pages)
    except (LLMRateLimitedError, CostCeilingError):
        # Lint is low-priority — skip rather than fail
        return LintScanResponse(contradictions=[])
    except LLMCompileError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


# ---------------------------------------------------------------------------
# Part 2c-i — draft-page, crossref, generate-schema
# ---------------------------------------------------------------------------


class SourceContent(BaseModel):
    model_config = ConfigDict(extra='forbid')

    source_id: str
    title: str
    markdown: str


class RelatedPage(BaseModel):
    model_config = ConfigDict(extra='forbid')

    title: str
    type: str
    summary: str


class DraftPageRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    page_type: str
    title: str
    source_contents: list[SourceContent]
    related_pages: list[RelatedPage] = []
    existing_content: str | None = None
    schema: str | None = None


class DraftPageResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    markdown: str


@router.post("/pipeline/draft-page", response_model=DraftPageResponse)
def pipeline_draft_page(req: DraftPageRequest) -> DraftPageResponse:
    """Draft a single wiki page from source content via Gemini.

    Returns raw markdown including YAML frontmatter. Temperature=0.3 for
    natural writing; thinking enabled for quality synthesis.
    """
    try:
        markdown = draft_page(
            page_type=req.page_type,
            title=req.title,
            source_contents=[sc.model_dump() for sc in req.source_contents],
            related_pages=[rp.model_dump() for rp in req.related_pages] if req.related_pages else None,
            existing_content=req.existing_content,
            schema=req.schema,
        )
        return DraftPageResponse(markdown=markdown)
    except LLMRateLimitedError as e:
        raise HTTPException(status_code=429, detail="llm_rate_limited") from e
    except CostCeilingError as e:
        raise HTTPException(status_code=503, detail="daily_cost_ceiling") from e
    except LLMCompileError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


class CrossrefPageInput(BaseModel):
    model_config = ConfigDict(extra='forbid')

    plan_id: str
    title: str
    page_type: str
    markdown: str


class CrossrefRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    pages: list[CrossrefPageInput]


@router.post("/pipeline/crossref", response_model=CrossrefResponse)
def pipeline_crossref(req: CrossrefRequest) -> CrossrefResponse:
    """Add [[wikilinks]] between pages and flag contradictions.

    Returns updated markdown for every page (changed or not) plus any
    contradictions found. Temperature=0 (no creativity — just linking).
    """
    if not req.pages:
        return CrossrefResponse(updated_pages=[], contradictions_found=[])
    try:
        return crossref_pages([p.model_dump() for p in req.pages])
    except LLMRateLimitedError as e:
        raise HTTPException(status_code=429, detail="llm_rate_limited") from e
    except CostCeilingError as e:
        raise HTTPException(status_code=503, detail="daily_cost_ceiling") from e
    except LLMCompileError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


class PageSummaryInput(BaseModel):
    model_config = ConfigDict(extra='forbid')

    title: str
    page_type: str
    category: str | None = None


class GenerateSchemaRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    pages: list[PageSummaryInput]


class GenerateSchemaResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    markdown: str


@router.post("/pipeline/generate-schema", response_model=GenerateSchemaResponse)
def pipeline_generate_schema(req: GenerateSchemaRequest) -> GenerateSchemaResponse:
    """Generate wiki schema.md from the first compile's page list.

    Only called when /data/schema.md does not yet exist. Temperature=0 for
    a deterministic, authoritative schema document.
    """
    try:
        markdown = generate_schema([p.model_dump() for p in req.pages])
        return GenerateSchemaResponse(markdown=markdown)
    except LLMRateLimitedError as e:
        raise HTTPException(status_code=429, detail="llm_rate_limited") from e
    except CostCeilingError as e:
        raise HTTPException(status_code=503, detail="daily_cost_ceiling") from e
    except LLMCompileError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
