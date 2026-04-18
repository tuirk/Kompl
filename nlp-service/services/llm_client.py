"""Gemini LLM client for Kompl v2 nlp-service (commits 4 + 11).

Responsibilities:
  - Wrap the google-genai SDK for structured output via Pydantic response_schema.
  - Enforce a per-process token-bucket rate limiter (pyrate-limiter, in-memory).
  - Track estimated daily spend in /data/llm-cap.json (survives restarts, resets at midnight UTC);
    raise CostCeilingError when the daily cap is hit.
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

import json
import os
import re
import time
from datetime import date
from pathlib import Path
from typing import Any

from google import genai
from google.genai import types
from pydantic import BaseModel
from pyrate_limiter import Duration, InMemoryBucket, Limiter, Rate

# ---------------------------------------------------------------------------
# Configuration from environment
# ---------------------------------------------------------------------------

_GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
_GEMINI_RPM = int(os.environ.get("GEMINI_RPM", "800"))
# Rough char budget: 1 token ≈ 4 chars for English. 32,000 tokens → 128,000 chars.
_GEMINI_INPUT_TOKEN_CAP = int(os.environ.get("GEMINI_INPUT_TOKEN_CAP", "128000"))
# Extraction output is a structured JSON list of entities/concepts/claims — an
# over-long input produces a JSON list that exceeds max_output_tokens (32K) and
# truncates mid-string. Cap extraction inputs tighter. ~50K chars ≈ 12.5K tokens.
_GEMINI_EXTRACT_INPUT_CAP = int(os.environ.get("GEMINI_EXTRACT_INPUT_CAP", "50000"))
# Fallback when /data/llm-config.json is missing (first boot, dev env, test).
# Runtime cap comes from _read_daily_cap_usd() below; Next.js writes the file
# whenever the setting is changed in the Settings UI.
_DAILY_CAP_FALLBACK = float(os.environ.get("GEMINI_DAILY_USD_CAP", "5.00"))

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


# ---------------------------------------------------------------------------
# Pydantic output models (contract 5 shapes)
# ---------------------------------------------------------------------------


class Entity(BaseModel):
    # No extra='forbid' — google-genai rejects schemas with additionalProperties=false.
    # These are LLM output models, not API boundary validators.
    name: str
    type: str  # PERSON | ORG | PRODUCT | CONCEPT | EVENT | LOCATION | OTHER


# ---------------------------------------------------------------------------
# Daily spend tracker — file-based, survives restarts, resets at midnight UTC
# ---------------------------------------------------------------------------

_CAP_FILE = Path(os.environ.get("DATA_ROOT", "/data")) / "llm-cap.json"
_CONFIG_FILE = Path(os.environ.get("DATA_ROOT", "/data")) / "llm-config.json"

# Cache the daily cap for 30 s to avoid a filesystem read on every LLM call.
# 30 s is short enough that a Settings UI change takes effect quickly without
# requiring a service restart.
_cap_cache: dict[str, Any] = {"value": None, "read_at": 0.0}


def _read_daily_cap_usd() -> float:
    """Read the user-configurable daily Gemini $ cap from /data/llm-config.json.

    Next.js writes this file whenever setDailyCapUsd() is called in db.ts
    (backed by the 'daily_cap_usd' settings row). We cache the value for 30 s
    to keep hot-path LLM calls cheap. If the file is absent or malformed we
    fall back to GEMINI_DAILY_USD_CAP from the env (preserves pre-settings
    behaviour on fresh installs and in tests).
    """
    now = time.time()
    if _cap_cache["value"] is not None and now - _cap_cache["read_at"] < 30:
        return _cap_cache["value"]  # type: ignore[return-value]
    try:
        data = json.loads(_CONFIG_FILE.read_text())
        v = float(data["daily_cap_usd"])
        cap = v if v >= 0 else _DAILY_CAP_FALLBACK
    except (FileNotFoundError, json.JSONDecodeError, KeyError, TypeError, ValueError):
        cap = _DAILY_CAP_FALLBACK
    _cap_cache["value"] = cap
    _cap_cache["read_at"] = now
    return cap


def _read_cap() -> dict:
    """Read today's spend from disk. Reset automatically when the date changes."""
    try:
        data = json.loads(_CAP_FILE.read_text())
        today = str(date.today())
        if data.get("date") != today:
            return {"date": today, "total_usd": 0.0, "call_count": 0}
        return data
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return {"date": str(date.today()), "total_usd": 0.0, "call_count": 0}


def _write_cap(data: dict) -> None:
    """Persist current spend to disk. Non-fatal on I/O failure."""
    try:
        _CAP_FILE.write_text(json.dumps(data))
    except OSError:
        pass  # cap still enforced in-memory for this call


def _check_and_record_cost(input_tokens: int, output_tokens: int) -> None:
    """Check daily cap then record cost. Raises CostCeilingError if exceeded.

    Called after every successful Gemini API call. If GEMINI_DAILY_USD_CAP=0
    the check is skipped (unlimited mode).
    """
    cost_usd = (input_tokens / 1_000_000) * _INPUT_PRICE_PER_M \
             + (output_tokens / 1_000_000) * _OUTPUT_PRICE_PER_M
    cap_data = _read_cap()
    daily_cap = _read_daily_cap_usd()
    if daily_cap > 0 and cap_data["total_usd"] + cost_usd > daily_cap:
        raise CostCeilingError(
            f"Daily Gemini spend limit (${daily_cap:.2f}) reached. "
            f"Today's spend: ${cap_data['total_usd']:.4f}. "
            f"Resets at midnight UTC."
        )
    cap_data["total_usd"] = round(cap_data["total_usd"] + cost_usd, 6)
    cap_data["call_count"] = cap_data.get("call_count", 0) + 1
    _write_cap(cap_data)


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
        _check_and_record_cost(int(input_tok), int(output_tok))

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

    if len(markdown) > _GEMINI_EXTRACT_INPUT_CAP:
        truncated = markdown[:_GEMINI_EXTRACT_INPUT_CAP]
        last_para = truncated.rfind("\n\n")
        markdown = truncated[:last_para] if last_para > 0 else truncated

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
                thinking_config=types.ThinkingConfig(thinking_budget=512),
                max_output_tokens=32768,
                temperature=0.0,
            ),
        )
    except Exception as e:
        raise LLMCompileError(f"extract_llm_call_failed: {e}") from e

    usage: Any = response.usage_metadata
    if usage is not None:
        input_tok = getattr(usage, "prompt_token_count", 0) or 0
        output_tok = getattr(usage, "candidates_token_count", 0) or 0
        _check_and_record_cost(int(input_tok), int(output_tok))

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
                thinking_config=types.ThinkingConfig(thinking_budget=512),
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
        _check_and_record_cost(int(input_tok), int(output_tok))

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
- YAML frontmatter: title, page_type: source-summary, category, summary (1-2 sentences describing what this source is about), sources (list with source_id and title), last_updated
- ## Content (reproduce the source content faithfully and in full — do NOT summarize, paraphrase, or shorten it; copy the text as written, preserving the author's voice, formatting, headings, and structure; for GitHub repos this means the full README)
- ## Key Facts (3-5 bullet points of the most important facts for quick reference)
- ## Entities Mentioned (bullet list of key people, companies, tools)
- ## Concepts (bullet list of key ideas)

The ## Content section is the most important part — it must contain the actual source text, not a rewrite of it. Do not add information not in the source.
Use [[wikilinks]] for any entities, people, tools, or concepts that have their own wiki pages.
When selecting the category field, you MUST use one of the exact category strings provided in CATEGORY ASSIGNMENT (in the user prompt). Only invent a new category if the list is empty or none fit.""",

    "entity": """\
Write an entity wiki page synthesizing information from multiple sources.

The page should include:
- YAML frontmatter: title, page_type: entity, category, summary (1-2 sentences), sources (list with source_id and title), last_updated
- A brief description paragraph
- Thematic sections (what this entity does, key facts, relationships to other entities)
- ## Sources (list of contributing source titles)

Synthesize across all sources. If sources provide complementary information, merge coherently.
If sources contradict each other, note the contradiction with citations to both sources.
Use [[wikilinks]] when referencing related entities or concepts that have wiki pages.
When selecting the category field, you MUST use one of the exact category strings provided in CATEGORY ASSIGNMENT (in the user prompt). Only invent a new category if the list is empty or none fit.""",

    "concept": """\
Write a concept wiki page synthesizing information from multiple sources.

The page should include:
- YAML frontmatter: title, page_type: concept, category, summary (1-2 sentences), sources (list with source_id and title), last_updated
- A definition/description paragraph
- ## Key Claims (from sources, attributed with source title)
- ## Contradictions section (only if sources disagree — cite both)
- ## Related Concepts (use [[wikilinks]] for concepts that have wiki pages)

Synthesize across sources. Attribute specific claims to their source.
Use [[wikilinks]] when referencing related concepts or entities that have wiki pages.
When selecting the category field, you MUST use one of the exact category strings provided in CATEGORY ASSIGNMENT (in the user prompt). Only invent a new category if the list is empty or none fit.""",

    "comparison": """\
Write a comparison wiki page comparing two entities or concepts.

The page should include:
- YAML frontmatter: title, page_type: comparison, category, summary (1-2 sentences describing what is being compared), sources (list), last_updated
- A brief intro paragraph explaining what is being compared and why
- A structured comparison (use a table or parallel sections)
- ## Summary: which is better suited for different use cases (if applicable)

Be objective and factual.
Use [[wikilinks]] when naming the entities being compared and any related concepts that have wiki pages.
When selecting the category field, you MUST use one of the exact category strings provided in CATEGORY ASSIGNMENT (in the user prompt). Only invent a new category if the list is empty or none fit.""",

    "overview": """\
Write an overview wiki page summarizing all pages in a category.

The page should include:
- YAML frontmatter: title, page_type: overview, category, summary (1-2 sentences describing this category), sources (list), last_updated
- A high-level summary paragraph of the category
- Brief descriptions of each entity/concept in the category (with [[wikilinks]] from the provided list)
- ## Common Themes
- ## Open Questions (gaps in coverage, if any)
When selecting the category field, you MUST use one of the exact category strings provided in CATEGORY ASSIGNMENT (in the user prompt). Only invent a new category if the list is empty or none fit.""",
}


def draft_page(
    page_type: str,
    title: str,
    source_contents: list[dict[str, Any]],
    related_pages: list[dict[str, Any]] | None = None,
    existing_content: str | None = None,
    schema: str | None = None,
    existing_page_titles: list[str] | None = None,
    extraction_dossier: str = "",
    existing_categories: list[str] | None = None,
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

    if existing_page_titles:
        titles_str = ", ".join(existing_page_titles)
        parts.append(
            f"Existing wiki pages (for [[wikilinks]]): {titles_str}\n\n"
            "When your text mentions any of these topics, wrap the FIRST occurrence "
            "in [[double brackets]] to create a wikilink. Do NOT link subsequent "
            "occurrences of the same topic. Only link topics that appear in the list "
            "above — do NOT invent links to pages not listed."
        )
        parts.append("")

    if extraction_dossier.strip() and page_type in ("entity", "concept", "comparison"):
        parts += [
            f'## Pre-extracted knowledge about "{title}"',
            "",
            "The following structured data was extracted from the source documents by NLP "
            "analysis. Use this as your primary factual reference. The source documents "
            "below provide additional context and detail.",
            "",
            extraction_dossier,
            "",
            "IMPORTANT: Prefer the pre-extracted data above for key facts, types, "
            "relationships, and claims. If the source documents contain additional "
            "information not in the dossier, include it. If the source documents "
            "contradict the dossier, present both with a contradiction note.",
            "",
        ]

    parts.append("Source documents:")
    for sc in source_contents:
        md = sc.get("markdown", "")
        parts += [
            f"--- Source: {sc.get('title', sc.get('source_id', ''))} ---",
            md,
            "",
        ]

    # Build category suffix separately so the truncation below never removes it.
    # It must survive at the very end of the final prompt for Gemini recency attention.
    # Always emit CATEGORY ASSIGNMENT — even when the list is empty — so the LLM
    # always has explicit instruction to write the category field.  When cats is
    # empty (first session) the LLM must invent one; when cats is non-empty it
    # must reuse an existing one or invent only when none fits.
    cats = existing_categories or []
    if cats:
        cats_str = ", ".join(f'"{c}"' for c in cats)
        cat_suffix = (
            "\nCATEGORY ASSIGNMENT:\n"
            f"Existing wiki categories: {cats_str}\n\n"
            "You MUST use one of these exact strings for the \"category\" frontmatter field. "
            "Only invent a new category if none of the existing ones fit. "
            "Do NOT paraphrase or rephrase an existing category."
        )
    else:
        cat_suffix = (
            "\nCATEGORY ASSIGNMENT:\n"
            "No existing categories yet. You MUST invent a suitable broad category for the "
            "\"category\" frontmatter field (e.g. \"Technology\", \"AI & Machine Learning\", "
            "\"Organizations\", \"Concepts\", \"Gaming\"). "
            "The category field is REQUIRED — do not leave it blank or omit it."
        )

    prompt = "\n".join(parts)

    if len(prompt) > _GEMINI_INPUT_TOKEN_CAP:
        prompt = prompt[:_GEMINI_INPUT_TOKEN_CAP]

    prompt += cat_suffix

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
                thinking_config=types.ThinkingConfig(thinking_budget=1024),
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
        _check_and_record_cost(int(input_tok), int(output_tok))

    raw_text = response.text
    if not raw_text:
        raise LLMCompileError(f"draft_page_error: empty response for '{title}'")

    raw = raw_text.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:yaml|markdown)?\n?", "", raw)
        raw = re.sub(r"\n?```$", "", raw)
    return raw.strip()


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


class TriageResponse(BaseModel):
    # No extra='forbid' — LLM output model.
    decision: str  # "update" | "contradiction" | "skip"
    reason: str


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
        _check_and_record_cost(int(input_tok), int(output_tok))

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
                response_schema=TriageResponse,
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
        _check_and_record_cost(int(input_tok), int(output_tok))

    raw_text = response.text
    if not raw_text:
        raise LLMCompileError("triage_error: empty response text")

    try:
        triage = TriageResponse.model_validate_json(raw_text)
    except Exception as e:
        raise LLMCompileError(f"triage_json_parse_failed: {e}") from e

    decision = triage.decision if triage.decision in ("update", "contradiction", "skip") else "skip"
    return {"decision": decision, "reason": triage.reason}


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
        _check_and_record_cost(int(input_tok), int(output_tok))

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
        _check_and_record_cost(int(input_tok), int(output_tok))

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

Citation format (strict):
- Wrap every page reference in SQUARE BRACKETS with the EXACT page title.
- Use the title verbatim as it appears in the "=== [id] Title ===" header.
- Do NOT append section names, colons, periods, or any extra text inside the
  brackets. The content inside [...] must equal one of the page titles exactly.

CORRECT:
  Essential cookies improve security [Cookie Usage]. Analytics cookies track
  performance [Cookie Usage].

WRONG (do not do this):
  Essential cookies [Cookie Usage: Essential Cookies] improve security.
  Cookie Usage.Performance Analytics Cookies track usage.
  Essential cookies (Cookie Usage) improve security.

Other rules:
- If the answer spans multiple pages, synthesize coherently.
- If no page has sufficient information, say so honestly and leave citations empty.
- Do not hallucinate. Do not invent facts not in the pages.

Return JSON with two fields:
  answer     — your full markdown answer (may use headers, bullets, code blocks)
  citations  — list of {page_id, page_title} for every page you cited
               (only pages you actually used in your answer)
"""


def synthesize_answer(
    question: str,
    pages: list[dict[str, Any]],
    history: list[dict[str, Any]],
) -> SynthesizeResponse:
    """Synthesize a wiki-grounded answer to a question using Gemini 2.5 Flash.

    Args:
        question: The user's question.
        pages:    List of {page_id, title, page_type, markdown} dicts.
        history:  List of {role, content} dicts (conversation history).

    Returns SynthesizeResponse with answer markdown and citations.

    Raises:
        LLMRateLimitedError — bucket exhausted
        CostCeilingError    — daily $ cap exceeded
        LLMCompileError     — parse failure
    """
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
                thinking_config=types.ThinkingConfig(thinking_budget=512),
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
        _check_and_record_cost(int(input_tok), int(output_tok))

    raw_text = response.text
    if not raw_text:
        raise LLMCompileError("synthesize_error: empty response text")

    try:
        return SynthesizeResponse.model_validate_json(raw_text)
    except Exception as e:
        raise LLMCompileError(f"synthesize_parse_failed: {e}") from e


# ---------------------------------------------------------------------------
# Weekly Digest — summary generation
# ---------------------------------------------------------------------------


def generate_digest(data: Any) -> str:
    """Generate a brief weekly digest summary via Gemini 2.5 Flash.

    Args:
        data: Object with fields matching DigestRequest in pipeline.py
              (sources_ingested, pages_created, pages_updated, new_page_titles,
               updated_page_titles, drafts_created, drafts_approved).

    Returns plain-text summary string under ~150 words.

    Raises:
        LLMRateLimitedError  — bucket exhausted
        CostCeilingError     — daily $ cap exceeded
        LLMCompileError      — empty or failed response
    """
    limiter = _get_limiter()
    acquired = limiter.try_acquire("gemini")
    if not acquired:
        raise LLMRateLimitedError("llm_rate_limited: bucket exhausted")

    new_titles = ", ".join(data.new_page_titles[:10]) if data.new_page_titles else "none"
    updated_titles = ", ".join(data.updated_page_titles[:10]) if data.updated_page_titles else "none"

    prompt = f"""Write a brief weekly digest for a personal knowledge wiki. Be concise, warm, and highlight what's interesting.

This week:
- {data.sources_ingested} new source{"s" if data.sources_ingested != 1 else ""} ingested
- {data.pages_created} new page{"s" if data.pages_created != 1 else ""} created: {new_titles}
- {data.pages_updated} page{"s" if data.pages_updated != 1 else ""} updated: {updated_titles}
- {data.drafts_created} draft{"s" if data.drafts_created != 1 else ""} created, {data.drafts_approved} approved

Summarize what grew this week and what's notable. If nothing happened, say so briefly.
Suggest 1-2 areas that could use more sources based on the page titles.
Keep it under 150 words. No markdown formatting — plain text with line breaks."""

    client = get_client()
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                thinking_config=types.ThinkingConfig(thinking_budget=1024),
                max_output_tokens=2048,
                temperature=0.3,
            ),
        )
    except Exception as e:
        raise LLMCompileError(f"digest_llm_failed: {e}") from e

    usage: Any = response.usage_metadata
    if usage is not None:
        input_tok = getattr(usage, "prompt_token_count", 0) or 0
        output_tok = getattr(usage, "candidates_token_count", 0) or 0
        _check_and_record_cost(int(input_tok), int(output_tok))

    raw_text = response.text
    if not raw_text:
        raise LLMCompileError("digest_error: empty response text")

    return raw_text.strip()
