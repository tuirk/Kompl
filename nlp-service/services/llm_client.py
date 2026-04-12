"""Gemini LLM client for Kompl v2 nlp-service (commits 4 + 11).

Responsibilities:
  - Wrap the google-genai SDK for structured output via Pydantic response_schema.
  - Enforce a per-process token-bucket rate limiter (pyrate-limiter, in-memory).
  - Track estimated daily spend; raise CostCeilingError when the daily cap is hit.
  - Truncate inputs to GEMINI_INPUT_TOKEN_CAP chars before sending (latency guard).

Architecture notes (docs/research/2026-04-09-llm-compile.md):
  - google-genai SDK (NOT deprecated google-generativeai). Client reads GEMINI_API_KEY.
  - thinking_budget by task type (researched against Gemini 2.5 Flash docs):
      0    — mechanical text manipulation or binary classification (crossref, triage)
      1024 — selection/ranking or contradiction scan (select_pages, lint_scan)
      2048 — structured creative, one-off (generate_schema)
      -1   — dynamic/unlimited for deep reasoning tasks (extract, disambiguate, draft, synthesize, compile)
  - response_schema accepts Pydantic BaseModel directly; parse via model_validate_json.
  - SINGLE uvicorn worker required: InMemoryBucket is process-local. Running
    --workers 2 would give 2×RPM effective, exceeding tier-1 cap. See research
    artifact section 3 for the SQLiteBucket-on-Windows-Docker gotcha.
  - max_output_tokens=32768 (half of 64K cap) per research artifact section 1
    failure mode: token-repetition loop at max_output_tokens.

This module NEVER opens kompl.db. rule #1 in CLAUDE.md.
"""

from __future__ import annotations

import os
import time
import threading
from typing import Any

from google import genai
from google.genai import types
from openai import OpenAI as _OpenAI
from pydantic import BaseModel
from pyrate_limiter import Duration, InMemoryBucket, Limiter, Rate

# ---------------------------------------------------------------------------
# Configuration from environment
# ---------------------------------------------------------------------------

_GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
_GEMINI_RPM = int(os.environ.get("GEMINI_RPM", "800"))

# Ollama provider (chat toggle). Defaults to the internal Docker DNS name.
_OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://ollama:11434/v1")
_OLLAMA_MODEL = "llama3.2:3b"
# Rough char budget: 1 token ≈ 4 chars for English. 32,000 tokens → 128,000 chars.
_GEMINI_INPUT_TOKEN_CAP = int(os.environ.get("GEMINI_INPUT_TOKEN_CAP", "128000"))
_GEMINI_DAILY_USD_CAP = float(os.environ.get("GEMINI_DAILY_USD_CAP", "5.00"))

# Gemini 2.5 Flash approximate pricing ($/M tokens, as of 2026-04).
# Both caps are env-driven per research artifact section 8 so pricing changes
# don't require code changes.
_INPUT_PRICE_PER_M = float(os.environ.get("GEMINI_INPUT_PRICE_PER_M", "0.075"))
_OUTPUT_PRICE_PER_M = float(os.environ.get("GEMINI_OUTPUT_PRICE_PER_M", "0.300"))

# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class LLMRateLimitedError(Exception):
    """Raised when the in-process rate limiter bucket is full."""


class CostCeilingError(Exception):
    """Raised when estimated daily spend crosses GEMINI_DAILY_USD_CAP."""


class LLMCompileError(Exception):
    """Raised when the LLM call succeeds but the response cannot be parsed."""


class OllamaUnavailableError(Exception):
    """Raised when the Ollama server is unreachable or the model is not yet pulled."""


# ---------------------------------------------------------------------------
# Pydantic output models (contract 5 shapes)
# ---------------------------------------------------------------------------


class Entity(BaseModel):
    # No extra='forbid' — google-genai rejects schemas with additionalProperties=false.
    # These are LLM output models, not API boundary validators.
    name: str
    type: str  # PERSON | ORG | PRODUCT | CONCEPT | EVENT | LOCATION | OTHER


class CompileResponse(BaseModel):
    # No extra='forbid' — same reason as Entity above.
    title: str
    page_type: str    # source-summary | concept | entity | topic
    category: str
    summary: str
    body: str
    entities: list[Entity]


# ---------------------------------------------------------------------------
# Daily spend tracker (resets at process restart — sufficient for commit 4)
# ---------------------------------------------------------------------------

_spend_lock = threading.Lock()
_daily_spend_usd: float = 0.0
_spend_day: int = 0  # day-of-year when the counter was last reset


def _record_spend(input_tokens: int, output_tokens: int) -> None:
    global _daily_spend_usd, _spend_day
    today = time.gmtime().tm_yday
    with _spend_lock:
        if today != _spend_day:
            _daily_spend_usd = 0.0
            _spend_day = today
        cost = (input_tokens / 1_000_000) * _INPUT_PRICE_PER_M \
             + (output_tokens / 1_000_000) * _OUTPUT_PRICE_PER_M
        _daily_spend_usd += cost
        if _daily_spend_usd > _GEMINI_DAILY_USD_CAP:
            raise CostCeilingError(
                f"daily cost ceiling reached: "
                f"${_daily_spend_usd:.4f} > ${_GEMINI_DAILY_USD_CAP:.2f}"
            )


# ---------------------------------------------------------------------------
# Rate limiter — in-process token bucket, async-safe
# ---------------------------------------------------------------------------

_limiter: Limiter | None = None


def _get_limiter() -> Limiter:
    global _limiter
    if _limiter is None:
        _limiter = Limiter(
            InMemoryBucket([Rate(_GEMINI_RPM, Duration.MINUTE)]),
            raise_when_fail=False,
            max_delay=60_000,  # wait up to 60s before giving up
        )
    return _limiter


# ---------------------------------------------------------------------------
# Gemini client (lazy init — validated at startup by main.py lifespan)
# ---------------------------------------------------------------------------

_client: genai.Client | None = None


def get_client() -> genai.Client:
    global _client
    if _client is None:
        if not _GEMINI_API_KEY:
            raise RuntimeError("GEMINI_API_KEY not set")
        _client = genai.Client(api_key=_GEMINI_API_KEY)
    return _client


# ---------------------------------------------------------------------------
# Ollama client (lazy init — only created when chat_provider='ollama')
# ---------------------------------------------------------------------------

_ollama_client: _OpenAI | None = None


def _get_ollama_client() -> _OpenAI:
    global _ollama_client
    if _ollama_client is None:
        _ollama_client = _OpenAI(
            base_url=_OLLAMA_BASE_URL,
            api_key="ollama",  # required by the SDK but ignored by Ollama
        )
    return _ollama_client


# ---------------------------------------------------------------------------
# Compile prompt
# ---------------------------------------------------------------------------

_COMPILE_SYSTEM_PROMPT = """\
You are a knowledge compiler. Given a markdown document, extract structured
information to create a wiki page entry.

Return JSON with these fields (in order):
1. title      — concise, descriptive title for this page
2. page_type  — one of: source-summary, concept, entity, topic
3. category   — one broad category (e.g., "Cryptocurrency", "Machine Learning",
                "Software Engineering")
4. summary    — 2-4 sentence plain-English summary of the document
5. body       — the full compiled markdown body for the wiki page. Use headers,
                bullet points, and inline code where appropriate. Include all
                key information from the source. Do not truncate.
6. entities   — list of named entities from the document. Each has:
                  name: the entity name
                  type: PERSON | ORG | PRODUCT | CONCEPT | EVENT | LOCATION | OTHER

Be precise. Do not hallucinate information not present in the document.
"""


def compile_source(source_id: str, markdown: str) -> CompileResponse:
    """Call Gemini to compile a source's markdown into structured wiki content.

    Truncates markdown to _GEMINI_INPUT_TOKEN_CAP chars before calling the API.
    Acquires the rate limiter bucket before calling — blocks up to 60s if needed.
    Records token usage against the daily spend cap after each call.

    Raises:
        LLMRateLimitedError  — bucket exhausted after 60s wait
        CostCeilingError     — daily $ cap exceeded
        LLMCompileError      — LLM returned but JSON parse failed
        RuntimeError         — GEMINI_API_KEY not set
    """
    # Truncate before calling to guard against latency cliff at 100k+ tokens.
    if len(markdown) > _GEMINI_INPUT_TOKEN_CAP:
        markdown = markdown[:_GEMINI_INPUT_TOKEN_CAP]

    # Rate limit acquire (blocks up to max_delay=60s via asyncio.sleep internally).
    limiter = _get_limiter()
    acquired = limiter.try_acquire("gemini")
    if not acquired:
        raise LLMRateLimitedError("llm_rate_limited: bucket exhausted after max_delay")

    prompt = (
        f"{_COMPILE_SYSTEM_PROMPT}\n\n"
        f"---\n\n"
        f"Source ID: {source_id}\n\n"
        f"{markdown}"
    )

    client = get_client()
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=CompileResponse,
                thinking_config=types.ThinkingConfig(thinking_budget=-1),
                max_output_tokens=32768,
            ),
        )
    except Exception as e:
        raise LLMCompileError(f"llm_call_failed: {e}") from e

    # Record spend (raises CostCeilingError if over cap).
    usage: Any = response.usage_metadata
    if usage is not None:
        input_tok = getattr(usage, "prompt_token_count", 0) or 0
        output_tok = getattr(usage, "candidates_token_count", 0) or 0
        _record_spend(int(input_tok), int(output_tok))

    # Parse response — never use response.parsed (unreliable across SDK versions).
    raw_text = response.text
    if not raw_text:
        raise LLMCompileError("llm_compile_error: empty response text")

    try:
        result = CompileResponse.model_validate_json(raw_text)
    except Exception as e:
        raise LLMCompileError(f"llm_compile_error: JSON parse failed: {e}") from e

    return result


# ---------------------------------------------------------------------------
# Lint scan — contradiction detection (commit 11)
# ---------------------------------------------------------------------------

_LINT_SYSTEM_PROMPT = """\
You are a wiki knowledge auditor. Given a list of wiki page summaries,
identify any factual contradictions between them.

A contradiction is when two pages make claims about the same subject that
cannot both be true. Minor contradictions are subtle differences in framing
or emphasis. Major contradictions are direct factual conflicts.

Return JSON with one field:
  contradictions — list of objects, each with:
    page_a: id of first page (the [id] prefix in the input)
    page_b: id of second page
    claim:  brief description of the contradiction (1-2 sentences)
    severity: 'minor' or 'major'

If no contradictions are found, return {"contradictions": []}.
Do not hallucinate contradictions.
"""


class Contradiction(BaseModel):
    # No extra='forbid' — LLM output model.
    page_a: str
    page_b: str
    claim: str
    severity: str  # 'minor' | 'major'


class LintScanResponse(BaseModel):
    # No extra='forbid' — LLM output model.
    contradictions: list[Contradiction]


def lint_scan(pages: list[str]) -> LintScanResponse:
    """Scan page summaries for contradictions.

    pages: list of "[page_id] title: summary" formatted strings.

    Raises:
        LLMRateLimitedError  — bucket exhausted
        CostCeilingError     — daily $ cap exceeded
        LLMCompileError      — parse failure
    """
    if not pages:
        return LintScanResponse(contradictions=[])

    prompt = f"{_LINT_SYSTEM_PROMPT}\n\n---\n\n" + "\n\n".join(pages)

    limiter = _get_limiter()
    acquired = limiter.try_acquire("gemini")
    if not acquired:
        raise LLMRateLimitedError("llm_rate_limited: bucket exhausted")

    client = get_client()
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                thinking_config=types.ThinkingConfig(thinking_budget=1024),
                max_output_tokens=4096,  # lint responses are short
            ),
        )
    except Exception as e:
        raise LLMCompileError(f"lint_scan_failed: {e}") from e

    usage: Any = response.usage_metadata
    if usage is not None:
        input_tok = getattr(usage, "prompt_token_count", 0) or 0
        output_tok = getattr(usage, "candidates_token_count", 0) or 0
        _record_spend(int(input_tok), int(output_tok))

    raw_text = response.text
    if not raw_text:
        return LintScanResponse(contradictions=[])

    try:
        import json as _json
        data = _json.loads(raw_text)
        contras = [
            Contradiction(
                page_a=c.get("page_a", ""),
                page_b=c.get("page_b", ""),
                claim=c.get("claim", ""),
                severity=c.get("severity", "minor"),
            )
            for c in data.get("contradictions", [])
            if isinstance(c, dict)
        ]
        return LintScanResponse(contradictions=contras)
    except Exception as e:
        raise LLMCompileError(f"lint_scan_parse_failed: {e}") from e


# ---------------------------------------------------------------------------
# Entity stub compiler — lightweight page creation (commit 12/Tier-2 bridge)
# ---------------------------------------------------------------------------

class EntityStubResponse(BaseModel):
    """Minimal wiki stub for a single entity/concept.

    No extra='forbid' — google-genai rejects additionalProperties=false
    in response_schema (same reason as CompileResponse / LintScanResponse).
    """
    summary: str
    body: str


_ENTITY_STUB_SYSTEM_PROMPT = """\
You are a wiki editor writing a stub page for a single named entity or concept.
Return JSON with exactly two fields:
  summary — 1 to 2 factual sentences about this entity. Do NOT hallucinate.
             If you are uncertain, write a minimal placeholder like
             "{{name}} is a notable entity in the domain of {{type}}."
  body    — 1 short paragraph of plain markdown (no headings, no bullet lists).
             Must be factual. Cite nothing you do not know for certain.
"""


def compile_entity_stub(name: str, entity_type: str) -> EntityStubResponse:
    """Write a minimal stub page for an entity/concept extracted during compile.

    Uses max_output_tokens=1024 and thinking_budget=0 (no chain-of-thought
    needed for a 2-sentence stub) to reduce token spend vs compile_source.
    Same rate limiter bucket and daily cost ceiling apply.

    Raises:
        LLMRateLimitedError  — bucket exhausted (caller should fall back to empty stub)
        CostCeilingError     — daily $ cap exceeded
        LLMCompileError      — response parse failed
    """
    limiter = _get_limiter()
    acquired = limiter.try_acquire("gemini")
    if not acquired:
        raise LLMRateLimitedError("llm_rate_limited: bucket exhausted")

    prompt = (
        f"Entity name: {name}\n"
        f"Entity type: {entity_type}\n"
        "Write a brief wiki stub (summary + body) as instructed."
    )

    client = get_client()
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=_ENTITY_STUB_SYSTEM_PROMPT,
                response_mime_type="application/json",
                response_schema=EntityStubResponse,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
                max_output_tokens=1024,
            ),
        )
    except Exception as e:
        raise LLMCompileError(f"entity_stub_llm_failed: {e}") from e

    usage: Any = response.usage_metadata
    if usage is not None:
        input_tok = getattr(usage, "prompt_token_count", 0) or 0
        output_tok = getattr(usage, "candidates_token_count", 0) or 0
        _record_spend(int(input_tok), int(output_tok))

    raw_text = response.text
    if not raw_text:
        raise LLMCompileError("entity_stub_error: empty response text")

    try:
        return EntityStubResponse.model_validate_json(raw_text)
    except Exception as e:
        raise LLMCompileError(f"entity_stub_parse_failed: {e}") from e


# ---------------------------------------------------------------------------
# Source extraction — structured knowledge extraction (Part 2a)
# ---------------------------------------------------------------------------


# LLM output models: no extra='forbid' — google-genai rejects additionalProperties=false
# in response_schema (same reason as CompileResponse / LintScanResponse above).

class ExtractionEntity(BaseModel):
    name: str
    type: str          # PERSON | ORG | PRODUCT | CONCEPT | EVENT | LOCATION | OTHER
    mentions: list[str]
    context: str


class ExtractionConcept(BaseModel):
    name: str
    description: str


class ExtractionClaim(BaseModel):
    claim: str
    confidence: str    # "stated" | "implied" | "speculative"
    entities_involved: list[str]


class ExtractionRelationship(BaseModel):
    from_entity: str   # JSON key: "from_entity" (avoids Python reserved word)
    to: str
    type: str          # uses | competes_with | part_of | created_by | related_to | contradicts
    description: str


class ExtractionContradiction(BaseModel):
    claim: str
    against: str       # what it contradicts (if detectable from source alone)


class LLMExtractionResponse(BaseModel):
    """Structured extraction result from a single source document.

    No extra='forbid' — google-genai rejects additionalProperties=false
    in response_schema (consistent with all other LLM output models here).
    """
    entities: list[ExtractionEntity]
    concepts: list[ExtractionConcept]
    claims: list[ExtractionClaim]
    relationships: list[ExtractionRelationship]
    contradictions: list[ExtractionContradiction]
    summary: str


_EXTRACTION_SYSTEM_PROMPT = """\
You are a knowledge extraction assistant. Given a source document and NLP
extraction outputs, produce a structured analysis for a knowledge wiki.

Your job is precision, not creativity. Only extract information that is
explicitly or strongly implicitly present in the source. Do not hallucinate.

Return JSON with these fields:
1. entities      — named entities with type, mentions, and context
   - type: PERSON | ORG | PRODUCT | CONCEPT | EVENT | LOCATION | OTHER
   - mentions: list of exact text spans from the source
   - context: 1-2 sentence description of this entity as discussed in the source
2. concepts      — key concepts with descriptions
3. claims        — specific factual claims
   - confidence: "stated" (explicit) | "implied" (strongly suggested) | "speculative"
   - entities_involved: list of entity/concept names from your entities/concepts lists
4. relationships — connections between entities/concepts
   - from_entity: name of first entity/concept
   - to: name of second entity/concept
   - type: uses | competes_with | part_of | created_by | related_to | contradicts
5. contradictions — claims that contradict other sources or internal logic
   - claim: what this source claims
   - against: what it contradicts (leave empty string if unknown)
6. summary       — 2-4 sentence summary of the source

Keep lists focused: 5-15 entities, 3-10 concepts, 3-15 claims, 3-10 relationships.
"""


def extract_source(
    source_id: str,
    markdown: str,
    ner_output: dict[str, Any],
    keyphrase_output: dict[str, Any] | None,
    tfidf_output: dict[str, Any] | None,
) -> LLMExtractionResponse:
    """Call Gemini 2.5 Flash to extract structured knowledge from a source.

    Takes pre-computed NLP outputs (NER, keyphrases, TF-IDF) as context to
    guide the extraction — this improves precision vs calling the LLM cold.

    Args:
        source_id:        Source identifier (used for logging only).
        markdown:         Full source markdown (truncated to input cap).
        ner_output:       JSON-serializable dict from /extract/ner.
        keyphrase_output: JSON-serializable dict from keyphrase methods (may be None).
        tfidf_output:     JSON-serializable dict from /extract/tfidf-overlap (may be None).

    Raises:
        LLMRateLimitedError  — bucket exhausted after 60s wait
        CostCeilingError     — daily $ cap exceeded
        LLMCompileError      — LLM returned but JSON parse failed
        RuntimeError         — GEMINI_API_KEY not set
    """
    import json as _json

    if len(markdown) > _GEMINI_INPUT_TOKEN_CAP:
        markdown = markdown[:_GEMINI_INPUT_TOKEN_CAP]

    limiter = _get_limiter()
    acquired = limiter.try_acquire("gemini")
    if not acquired:
        raise LLMRateLimitedError("llm_rate_limited: bucket exhausted after max_delay")

    ner_section = _json.dumps(ner_output, ensure_ascii=False)
    keyphrase_section = _json.dumps(keyphrase_output, ensure_ascii=False) if keyphrase_output else "N/A — no keyphrase output"
    tfidf_section = _json.dumps(tfidf_output, ensure_ascii=False) if tfidf_output else "N/A — first compile, no existing wiki pages"

    prompt = (
        f"{_EXTRACTION_SYSTEM_PROMPT}\n\n"
        f"---\n\n"
        f"Source ID: {source_id}\n\n"
        f"NLP extraction results:\n"
        f"Named entities (spaCy NER):\n{ner_section}\n\n"
        f"Keyphrases:\n{keyphrase_section}\n\n"
        f"TF-IDF overlap with existing wiki:\n{tfidf_section}\n\n"
        f"---\n\n"
        f"Source document:\n\n{markdown}"
    )

    client = get_client()
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=LLMExtractionResponse,
                thinking_config=types.ThinkingConfig(thinking_budget=-1),
                max_output_tokens=8192,
                temperature=0.0,
            ),
        )
    except Exception as e:
        raise LLMCompileError(f"extract_llm_call_failed: {e}") from e

    usage: Any = response.usage_metadata
    if usage is not None:
        input_tok = getattr(usage, "prompt_token_count", 0) or 0
        output_tok = getattr(usage, "candidates_token_count", 0) or 0
        _record_spend(int(input_tok), int(output_tok))

    raw_text = response.text
    if not raw_text:
        raise LLMCompileError("extract_llm_error: empty response text")

    try:
        return LLMExtractionResponse.model_validate_json(raw_text)
    except Exception as e:
        raise LLMCompileError(f"extract_llm_parse_failed: {e}") from e


# ---------------------------------------------------------------------------
# Entity disambiguation — LLM Layer 3 of the cascading resolver (Part 2b)
# ---------------------------------------------------------------------------


class DisambiguationResult(BaseModel):
    """Single pair resolution result.

    No extra='forbid' — google-genai rejects additionalProperties=false
    in response_schema (consistent with all other LLM output models here).
    """
    entity_a: str
    entity_b: str
    decision: str           # "same" | "different" | "ambiguous"
    canonical: str | None = None
    reason: str


class DisambiguationResponse(BaseModel):
    """Batch disambiguation response."""
    results: list[DisambiguationResult]


_DISAMBIGUATION_SYSTEM_PROMPT = """\
You are an entity resolution assistant. For each pair of entities, decide
whether they refer to the same real-world entity or concept.

For each pair return:
  entity_a   — name of the first entity (copy from input)
  entity_b   — name of the second entity (copy from input)
  decision   — "same" (they are the same entity), "different" (distinct),
               or "ambiguous" (cannot determine from context)
  canonical  — if "same", the better canonical name (more complete / commonly used).
               Set to null for "different" or "ambiguous".
  reason     — brief explanation (1 sentence)

Be conservative: only return "same" if you are confident. Prefer "ambiguous"
over a wrong "same" call. Do not hallucinate.
"""


def disambiguate_entities(pairs: list[dict[str, Any]]) -> DisambiguationResponse:
    """Batch LLM entity disambiguation for the 0.7–0.9 embedding similarity band.

    Accepts up to 10 pairs per call (caller is responsible for batching).
    Each pair is a dict with keys entity_a and entity_b, each a dict with
    at least: name (str), type (str), context (str).

    Raises:
        LLMRateLimitedError  — bucket exhausted after 60s wait
        CostCeilingError     — daily $ cap exceeded
        LLMCompileError      — LLM returned but JSON parse failed
        RuntimeError         — GEMINI_API_KEY not set
    """
    import json as _json

    if not pairs:
        return DisambiguationResponse(results=[])

    limiter = _get_limiter()
    acquired = limiter.try_acquire("gemini")
    if not acquired:
        raise LLMRateLimitedError("llm_rate_limited: bucket exhausted after max_delay")

    pairs_json = _json.dumps(pairs, ensure_ascii=False, indent=2)
    prompt = (
        f"{_DISAMBIGUATION_SYSTEM_PROMPT}\n\n"
        f"---\n\n"
        f"Pairs to resolve:\n{pairs_json}"
    )

    client = get_client()
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=DisambiguationResponse,
                thinking_config=types.ThinkingConfig(thinking_budget=-1),
                max_output_tokens=2048,
                temperature=0.0,
            ),
        )
    except Exception as e:
        raise LLMCompileError(f"disambiguate_llm_call_failed: {e}") from e

    usage: Any = response.usage_metadata
    if usage is not None:
        input_tok = getattr(usage, "prompt_token_count", 0) or 0
        output_tok = getattr(usage, "candidates_token_count", 0) or 0
        _record_spend(int(input_tok), int(output_tok))

    raw_text = response.text
    if not raw_text:
        raise LLMCompileError("disambiguate_llm_error: empty response text")

    try:
        return DisambiguationResponse.model_validate_json(raw_text)
    except Exception as e:
        raise LLMCompileError(f"disambiguate_llm_parse_failed: {e}") from e


# ---------------------------------------------------------------------------
# Page drafting — write a single wiki page from source content (Part 2c-i)
# ---------------------------------------------------------------------------

_DRAFT_PAGE_PROMPTS: dict[str, str] = {
    "source-summary": """\
Write a source summary wiki page for the following source document.

The page should include:
- YAML frontmatter: title, page_type: source-summary, sources (list with source_id and title), last_updated
- ## Key Takeaways (3-5 bullet points)
- ## Summary (2-4 paragraphs)
- ## Entities Mentioned (bullet list of key people, companies, tools)
- ## Concepts (bullet list of key ideas)

Write clean markdown. Be concise and factual. Do not add information not in the source.""",

    "entity": """\
Write an entity wiki page synthesizing information from multiple sources.

The page should include:
- YAML frontmatter: title, page_type: entity, category, summary (1-2 sentences), sources (list with source_id and title), last_updated
- A brief description paragraph
- Thematic sections (what this entity does, key facts, relationships to other entities)
- ## Sources (list of contributing source titles)

Synthesize across all sources. If sources provide complementary information, merge coherently.
If sources contradict each other, note the contradiction with citations to both sources.""",

    "concept": """\
Write a concept wiki page synthesizing information from multiple sources.

The page should include:
- YAML frontmatter: title, page_type: concept, category, summary (1-2 sentences), sources (list with source_id and title), last_updated
- A definition/description paragraph
- ## Key Claims (from sources, attributed with source title)
- ## Contradictions section (only if sources disagree — cite both)
- ## Related Concepts

Synthesize across sources. Attribute specific claims to their source.""",

    "comparison": """\
Write a comparison wiki page comparing two entities or concepts.

The page should include:
- YAML frontmatter: title, page_type: comparison, sources (list), last_updated
- A brief intro paragraph explaining what is being compared and why
- A structured comparison (use a table or parallel sections)
- ## Summary: which is better suited for different use cases (if applicable)

Be objective and factual.""",

    "overview": """\
Write an overview wiki page summarizing all pages in a category.

The page should include:
- YAML frontmatter: title, page_type: overview, category, sources (list), last_updated
- A high-level summary paragraph of the category
- Brief descriptions of each entity/concept in the category (with [[wikilink]] references)
- ## Common Themes
- ## Open Questions (gaps in coverage, if any)""",
}


def draft_page(
    page_type: str,
    title: str,
    source_contents: list[dict[str, Any]],
    related_pages: list[dict[str, Any]] | None = None,
    existing_content: str | None = None,
    schema: str | None = None,
) -> str:
    """Draft a wiki page using Gemini 2.5 Flash.

    Returns the raw markdown string for the page (including YAML frontmatter).
    Uses free-form text output (no response_schema) since page content is
    unstructured markdown.

    Args:
        page_type:        'source-summary' | 'entity' | 'concept' | 'comparison' | 'overview'
        title:            Page title
        source_contents:  List of {source_id, title, markdown} dicts
        related_pages:    Optional list of {title, type, summary} for context
        existing_content: Existing page markdown (for updates — None for first compile)
        schema:           wiki schema.md content (None for first compile)

    Raises:
        LLMRateLimitedError  — bucket exhausted
        CostCeilingError     — daily $ cap exceeded
        LLMCompileError      — empty response
    """
    import json as _json

    system_prompt = _DRAFT_PAGE_PROMPTS.get(page_type, _DRAFT_PAGE_PROMPTS["entity"])

    # Build user prompt
    parts: list[str] = [f"Title: {title}", f"Page type: {page_type}", ""]

    if schema:
        parts += ["Wiki schema (follow these conventions):", schema, ""]

    if existing_content:
        parts += ["Existing page content (update this, don't rewrite from scratch):",
                  existing_content, ""]

    if related_pages:
        parts += ["Related pages in the wiki (for cross-reference context):"]
        for rp in related_pages:
            parts.append(f"  - {rp.get('title', '')} ({rp.get('type', '')}): {rp.get('summary', '')}")
        parts.append("")

    parts.append("Source documents:")
    for sc in source_contents:
        md = sc.get("markdown", "")
        if len(md) > _GEMINI_INPUT_TOKEN_CAP // max(len(source_contents), 1):
            md = md[:_GEMINI_INPUT_TOKEN_CAP // max(len(source_contents), 1)]
        parts += [
            f"--- Source: {sc.get('title', sc.get('source_id', ''))} ---",
            md,
            "",
        ]

    prompt = "\n".join(parts)

    if len(prompt) > _GEMINI_INPUT_TOKEN_CAP:
        prompt = prompt[:_GEMINI_INPUT_TOKEN_CAP]

    limiter = _get_limiter()
    acquired = limiter.try_acquire("gemini")
    if not acquired:
        raise LLMRateLimitedError("llm_rate_limited: bucket exhausted")

    client = get_client()
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system_prompt,
                thinking_config=types.ThinkingConfig(thinking_budget=-1),
                max_output_tokens=16384,
                temperature=0.3,
            ),
        )
    except Exception as e:
        raise LLMCompileError(f"draft_page_llm_failed: {e}") from e

    usage: Any = response.usage_metadata
    if usage is not None:
        input_tok = getattr(usage, "prompt_token_count", 0) or 0
        output_tok = getattr(usage, "candidates_token_count", 0) or 0
        _record_spend(int(input_tok), int(output_tok))

    raw_text = response.text
    if not raw_text:
        raise LLMCompileError(f"draft_page_error: empty response for '{title}'")

    return raw_text.strip()


# ---------------------------------------------------------------------------
# Cross-reference — add [[wikilinks]] + flag contradictions (Part 2c-i)
# ---------------------------------------------------------------------------


class CrossrefUpdatedPage(BaseModel):
    # No extra='forbid' — LLM output model.
    plan_id: str
    markdown: str


class CrossrefContradiction(BaseModel):
    # No extra='forbid' — LLM output model.
    page_a: str
    page_b: str
    description: str


class CrossrefResponse(BaseModel):
    # No extra='forbid' — LLM output model.
    updated_pages: list[CrossrefUpdatedPage]
    contradictions_found: list[CrossrefContradiction]


_CROSSREF_SYSTEM_PROMPT = """\
You are a wiki cross-reference editor. You receive a set of wiki pages.

Your job is to:
1. Add [[wikilinks]] between pages that reference each other.
   Use the exact page title as the link target: [[Bitcoin]], [[Ethereum]].
   Only link to titles that exist in the provided page set.
2. Flag contradictions: if two pages make conflicting claims, add a
   "⚠️ Contradiction: see [[Other Page]]" note near the conflicting claim on both pages.
3. Ensure consistent terminology across pages.

Rules:
- Do NOT change factual content or add new information.
- Do NOT remove existing content.
- Do NOT modify YAML frontmatter.
- Do NOT add links to pages that are not in the provided set.
- Return EVERY page in updated_pages, even if unchanged.
"""


def crossref_pages(pages: list[dict[str, Any]]) -> CrossrefResponse:
    """Add [[wikilinks]] between pages and flag contradictions.

    Args:
        pages: List of {plan_id, title, page_type, markdown} dicts.

    Returns CrossrefResponse with updated_pages[] and contradictions_found[].

    Raises:
        LLMRateLimitedError  — bucket exhausted
        CostCeilingError     — daily $ cap exceeded
        LLMCompileError      — parse failure
    """
    import json as _json

    if not pages:
        return CrossrefResponse(updated_pages=[], contradictions_found=[])

    # Build the pages list for the prompt
    page_titles = [p.get("title", "") for p in pages]
    prompt_parts = [
        f"Available page titles: {_json.dumps(page_titles)}",
        "",
        "Pages to cross-reference:",
        "",
    ]
    for p in pages:
        prompt_parts += [
            f"=== plan_id: {p['plan_id']} | title: {p['title']} | type: {p['page_type']} ===",
            p.get("markdown", ""),
            "",
        ]

    prompt = "\n".join(prompt_parts)
    if len(prompt) > _GEMINI_INPUT_TOKEN_CAP:
        prompt = prompt[:_GEMINI_INPUT_TOKEN_CAP]

    limiter = _get_limiter()
    acquired = limiter.try_acquire("gemini")
    if not acquired:
        raise LLMRateLimitedError("llm_rate_limited: bucket exhausted")

    client = get_client()
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=_CROSSREF_SYSTEM_PROMPT,
                response_mime_type="application/json",
                response_schema=CrossrefResponse,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
                max_output_tokens=32768,
                temperature=0.0,
            ),
        )
    except Exception as e:
        raise LLMCompileError(f"crossref_llm_failed: {e}") from e

    usage: Any = response.usage_metadata
    if usage is not None:
        input_tok = getattr(usage, "prompt_token_count", 0) or 0
        output_tok = getattr(usage, "candidates_token_count", 0) or 0
        _record_spend(int(input_tok), int(output_tok))

    raw_text = response.text
    if not raw_text:
        # Return pages unchanged on empty response rather than failing
        return CrossrefResponse(
            updated_pages=[CrossrefUpdatedPage(plan_id=p["plan_id"], markdown=p.get("markdown", "")) for p in pages],
            contradictions_found=[],
        )

    try:
        return CrossrefResponse.model_validate_json(raw_text)
    except Exception as e:
        raise LLMCompileError(f"crossref_parse_failed: {e}") from e


# ---------------------------------------------------------------------------
# Schema generation — bootstrap wiki schema.md (Part 2c-i)
# ---------------------------------------------------------------------------

_SCHEMA_SYSTEM_PROMPT = """\
You are a wiki schema generator. Based on the pages that were just created,
generate a schema document that defines how this wiki should be maintained.

The schema should cover:
1. Page types and when each should be created (source-summary, entity, concept, comparison, overview)
2. Naming conventions for page titles
3. YAML frontmatter format (required fields per page type)
4. Cross-referencing rules (when to add [[wikilinks]])
5. How to handle contradictions between sources
6. Category structure based on the content seen so far
7. When to create a new page vs update an existing one
8. Content quality standards (factual accuracy, attribution, no hallucination)

Write the schema as a concise markdown document. It will be used as standing
instructions for the LLM on all future wiki updates.
"""


def triage_page_update(
    source_claims: str,
    existing_page_summary: str,
    page_title: str,
) -> dict[str, str]:
    """Decide whether a source warrants updating an existing wiki page.

    Args:
        source_claims:        Extracted markdown text from the new source.
        existing_page_summary: Current summary/content of the wiki page.
        page_title:           Title of the wiki page being triaged.

    Returns dict with keys 'decision' ('update'|'contradiction'|'skip') and 'reason'.

    Raises:
        LLMRateLimitedError  — bucket exhausted
        CostCeilingError     — daily $ cap exceeded
        LLMCompileError      — empty response or JSON parse failed
    """
    import json as _json

    limiter = _get_limiter()
    acquired = limiter.try_acquire("gemini")
    if not acquired:
        raise LLMRateLimitedError("llm_rate_limited: bucket exhausted")

    prompt = (
        f'You are a wiki maintenance assistant deciding whether a wiki page needs updating.\n\n'
        f'Wiki page: "{page_title}"\n'
        f'Current page summary:\n{existing_page_summary}\n\n'
        f'New information from ingested source:\n{source_claims}\n\n'
        f'Respond with JSON only:\n'
        f'{{\n'
        f'  "decision": "update" | "contradiction" | "skip",\n'
        f'  "reason": "brief explanation (1-2 sentences)"\n'
        f'}}\n\n'
        f'- "update": source has material new information not in the current page\n'
        f'- "contradiction": source directly contradicts a factual claim in the page\n'
        f'- "skip": source is redundant or only tangentially mentions the topic'
    )

    client = get_client()
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema={
                    "type": "OBJECT",
                    "properties": {
                        "decision": {"type": "STRING"},
                        "reason": {"type": "STRING"},
                    },
                    "required": ["decision", "reason"],
                },
                thinking_config=types.ThinkingConfig(thinking_budget=0),
                max_output_tokens=512,
                temperature=0.0,
            ),
        )
    except Exception as e:
        raise LLMCompileError(f"triage_llm_call_failed: {e}") from e

    usage: Any = response.usage_metadata
    if usage is not None:
        input_tok = getattr(usage, "prompt_token_count", 0) or 0
        output_tok = getattr(usage, "candidates_token_count", 0) or 0
        _record_spend(int(input_tok), int(output_tok))

    raw_text = response.text
    if not raw_text:
        raise LLMCompileError("triage_error: empty response text")

    try:
        result = _json.loads(raw_text)
    except Exception as e:
        raise LLMCompileError(f"triage_json_parse_failed: {e}") from e

    decision = result.get("decision", "skip")
    if decision not in ("update", "contradiction", "skip"):
        decision = "skip"
    return {"decision": decision, "reason": result.get("reason", "")}


def generate_schema(pages_summary: list[dict[str, Any]]) -> str:
    """Generate a wiki schema document from the first compile's page list.

    Args:
        pages_summary: List of {title, page_type, category} dicts.

    Returns raw markdown string for /data/schema.md.

    Raises:
        LLMRateLimitedError  — bucket exhausted
        CostCeilingError     — daily $ cap exceeded
        LLMCompileError      — empty response
    """
    import json as _json

    prompt = (
        "Pages created in this wiki:\n\n"
        + _json.dumps(pages_summary, ensure_ascii=False, indent=2)
    )

    limiter = _get_limiter()
    acquired = limiter.try_acquire("gemini")
    if not acquired:
        raise LLMRateLimitedError("llm_rate_limited: bucket exhausted")

    client = get_client()
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=_SCHEMA_SYSTEM_PROMPT,
                thinking_config=types.ThinkingConfig(thinking_budget=2048),
                max_output_tokens=8192,
                temperature=0.0,
            ),
        )
    except Exception as e:
        raise LLMCompileError(f"generate_schema_llm_failed: {e}") from e

    usage: Any = response.usage_metadata
    if usage is not None:
        input_tok = getattr(usage, "prompt_token_count", 0) or 0
        output_tok = getattr(usage, "candidates_token_count", 0) or 0
        _record_spend(int(input_tok), int(output_tok))

    raw_text = response.text
    if not raw_text:
        raise LLMCompileError("generate_schema_error: empty response")

    return raw_text.strip()


# ---------------------------------------------------------------------------
# Chat agent — index-first page selection (commit 7)
# ---------------------------------------------------------------------------


class SelectPagesResponse(BaseModel):
    # No extra='forbid' — LLM output model.
    page_ids: list[str]


_SELECT_PAGES_SYSTEM_PROMPT = """\
You are a wiki retrieval assistant. Given a list of wiki pages (with titles,
types, and summaries) and a user question, select the page IDs that are most
relevant to answering the question.

Return JSON with one field:
  page_ids — list of page_id strings, up to 10, most relevant first.

Only include pages that genuinely help answer the question. If no pages are
relevant, return an empty list. Do not hallucinate page IDs not in the input.
"""


def select_pages_for_query(
    question: str,
    index: list[dict[str, Any]],
) -> list[str]:
    """Given a wiki index, select the page IDs most relevant to a question.

    Args:
        question: The user's question.
        index:    List of {page_id, title, page_type, summary, source_count} dicts.

    Returns list of page_id strings (up to 10), most relevant first.

    Raises:
        LLMRateLimitedError  — bucket exhausted
        CostCeilingError     — daily $ cap exceeded
        LLMCompileError      — parse failure
    """
    import json as _json

    if not index:
        return []

    limiter = _get_limiter()
    acquired = limiter.try_acquire("gemini")
    if not acquired:
        raise LLMRateLimitedError("llm_rate_limited: bucket exhausted")

    index_text = _json.dumps(index, ensure_ascii=False)
    if len(index_text) > _GEMINI_INPUT_TOKEN_CAP:
        index_text = index_text[:_GEMINI_INPUT_TOKEN_CAP]

    prompt = (
        f"{_SELECT_PAGES_SYSTEM_PROMPT}\n\n"
        f"Wiki index:\n{index_text}\n\n"
        f"Question: {question}"
    )

    client = get_client()
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=SelectPagesResponse,
                thinking_config=types.ThinkingConfig(thinking_budget=1024),
                max_output_tokens=1024,
                temperature=0.0,
            ),
        )
    except Exception as e:
        raise LLMCompileError(f"select_pages_llm_failed: {e}") from e

    usage: Any = response.usage_metadata
    if usage is not None:
        input_tok = getattr(usage, "prompt_token_count", 0) or 0
        output_tok = getattr(usage, "candidates_token_count", 0) or 0
        _record_spend(int(input_tok), int(output_tok))

    raw_text = response.text
    if not raw_text:
        return []

    try:
        result = SelectPagesResponse.model_validate_json(raw_text)
        return result.page_ids
    except Exception as e:
        raise LLMCompileError(f"select_pages_parse_failed: {e}") from e


# ---------------------------------------------------------------------------
# Chat agent — answer synthesis (commit 7)
# ---------------------------------------------------------------------------


class SynthesisCitation(BaseModel):
    # No extra='forbid' — LLM output model.
    page_id: str
    page_title: str


class SynthesizeResponse(BaseModel):
    # No extra='forbid' — LLM output model.
    answer: str
    citations: list[SynthesisCitation]


_SYNTHESIZE_SYSTEM_PROMPT = """\
You are a wiki-grounded knowledge assistant. Answer the user's question using
ONLY the wiki pages provided. Do not use general knowledge — your answer must
be grounded in the provided pages.

Rules:
- Cite pages using [Page Title] inline where you use their content.
- If the answer spans multiple pages, synthesize coherently.
- If no page has sufficient information, say so honestly.
- Do not hallucinate. Do not invent facts not in the pages.

Return JSON with two fields:
  answer     — your full markdown answer (may use headers, bullets, code blocks)
  citations  — list of {page_id, page_title} for every page you cited
               (only pages you actually used in your answer)
"""


def _synthesize_with_ollama(
    question: str,
    pages: list[dict[str, Any]],
    history: list[dict[str, Any]],
) -> SynthesizeResponse:
    """Synthesize a wiki-grounded answer using Ollama llama3.2:3b (CPU, free).

    Uses OpenAI-compatible JSON mode + explicit schema instructions.
    Ollama guarantees valid JSON but not field presence — parsed manually.

    Raises:
        OllamaUnavailableError  — server not running or model still pulling
        LLMCompileError         — response received but JSON missing required fields
    """
    import json as _json

    # Build page context (same assembly as the Gemini path)
    page_sections: list[str] = []
    for p in pages:
        content = p.get("markdown", "")
        page_sections.append(
            f"=== [{p['page_id']}] {p['title']} (type: {p.get('page_type', '')}) ===\n{content}"
        )
    pages_text = "\n\n".join(page_sections)

    history_text = ""
    if history:
        history_lines = [
            f"{h['role'].upper()}: {h['content']}" for h in history[-10:]
        ]
        history_text = "Conversation history:\n" + "\n".join(history_lines) + "\n\n"

    user_content = (
        f"{history_text}"
        f"Wiki pages:\n\n{pages_text}\n\n"
        f"---\n\n"
        f"Question: {question}"
    )

    if len(user_content) > _GEMINI_INPUT_TOKEN_CAP:
        user_content = user_content[:_GEMINI_INPUT_TOKEN_CAP]

    # Extend the system prompt with explicit JSON schema instructions.
    # json_object mode guarantees parseable JSON but NOT field presence.
    system_prompt = (
        _SYNTHESIZE_SYSTEM_PROMPT
        + '\nYou MUST return valid JSON with EXACTLY these two top-level fields:\n'
        + '{"answer": "<markdown string>", "citations": [{"page_id": "<id>", "page_title": "<title>"}, ...]}\n'
        + 'Do not add extra fields. The citations array may be empty if you used no specific pages.'
    )

    client = _get_ollama_client()
    try:
        completion = client.chat.completions.create(
            model=_OLLAMA_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_content},
            ],
            response_format={"type": "json_object"},
            temperature=0.2,
            max_tokens=4096,
        )
    except Exception as e:
        err_str = str(e).lower()
        if any(kw in err_str for kw in ("connection", "refused", "not found", "404", "pull")):
            raise OllamaUnavailableError(f"ollama_unavailable: {e}") from e
        raise LLMCompileError(f"ollama_call_failed: {e}") from e

    raw_text = completion.choices[0].message.content if completion.choices else ""
    if not raw_text:
        raise LLMCompileError("ollama_error: empty response content")

    try:
        data = _json.loads(raw_text)
    except _json.JSONDecodeError as e:
        raise LLMCompileError(f"ollama_parse_failed: invalid JSON: {e}") from e

    if not isinstance(data, dict):
        raise LLMCompileError(f"ollama_parse_failed: expected object, got {type(data).__name__}")

    answer = data.get("answer")
    if not isinstance(answer, str) or not answer.strip():
        raise LLMCompileError(
            f"ollama_parse_failed: 'answer' field missing or empty. Keys present: {list(data.keys())}"
        )

    # Citations are best-effort — skip malformed entries, return empty list if absent.
    raw_citations = data.get("citations", [])
    citations: list[SynthesisCitation] = []
    if isinstance(raw_citations, list):
        for c in raw_citations:
            if isinstance(c, dict):
                pid = c.get("page_id", "")
                ptitle = c.get("page_title", "")
                if isinstance(pid, str) and isinstance(ptitle, str) and pid:
                    citations.append(SynthesisCitation(page_id=pid, page_title=ptitle))

    return SynthesizeResponse(answer=answer.strip(), citations=citations)


def synthesize_answer(
    question: str,
    pages: list[dict[str, Any]],
    history: list[dict[str, Any]],
    provider: str = "gemini",
) -> SynthesizeResponse:
    """Synthesize a wiki-grounded answer to a question.

    Args:
        question: The user's question.
        pages:    List of {page_id, title, page_type, markdown} dicts.
        history:  List of {role, content} dicts (conversation history).
        provider: 'gemini' (default, uses Gemini 2.5 Flash) or 'ollama'
                  (uses local llama3.2:3b via Ollama — free, CPU-only).

    Returns SynthesizeResponse with answer markdown and citations.

    Raises:
        OllamaUnavailableError — Ollama server down or model not yet pulled (provider='ollama')
        LLMRateLimitedError    — bucket exhausted (provider='gemini')
        CostCeilingError       — daily $ cap exceeded (provider='gemini')
        LLMCompileError        — parse failure (both providers)
    """
    if provider == "ollama":
        return _synthesize_with_ollama(question, pages, history)

    import json as _json

    limiter = _get_limiter()
    acquired = limiter.try_acquire("gemini")
    if not acquired:
        raise LLMRateLimitedError("llm_rate_limited: bucket exhausted")

    # Build page context section
    page_sections: list[str] = []
    for p in pages:
        content = p.get("markdown", "")
        page_sections.append(
            f"=== [{p['page_id']}] {p['title']} (type: {p.get('page_type', '')}) ===\n{content}"
        )
    pages_text = "\n\n".join(page_sections)

    # Build conversation history section
    history_text = ""
    if history:
        history_lines = [
            f"{h['role'].upper()}: {h['content']}" for h in history[-10:]
        ]
        history_text = "Conversation history:\n" + "\n".join(history_lines) + "\n\n"

    prompt = (
        f"{history_text}"
        f"Wiki pages:\n\n{pages_text}\n\n"
        f"---\n\n"
        f"Question: {question}"
    )

    if len(prompt) > _GEMINI_INPUT_TOKEN_CAP:
        prompt = prompt[:_GEMINI_INPUT_TOKEN_CAP]

    client = get_client()
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=_SYNTHESIZE_SYSTEM_PROMPT,
                response_mime_type="application/json",
                response_schema=SynthesizeResponse,
                thinking_config=types.ThinkingConfig(thinking_budget=-1),
                max_output_tokens=4096,
                temperature=0.2,
            ),
        )
    except Exception as e:
        raise LLMCompileError(f"synthesize_llm_failed: {e}") from e

    usage: Any = response.usage_metadata
    if usage is not None:
        input_tok = getattr(usage, "prompt_token_count", 0) or 0
        output_tok = getattr(usage, "candidates_token_count", 0) or 0
        _record_spend(int(input_tok), int(output_tok))

    raw_text = response.text
    if not raw_text:
        raise LLMCompileError("synthesize_error: empty response text")

    try:
        return SynthesizeResponse.model_validate_json(raw_text)
    except Exception as e:
        raise LLMCompileError(f"synthesize_parse_failed: {e}") from e
