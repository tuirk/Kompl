"""Gemini LLM client for Kompl v2 nlp-service (commit 4).

Responsibilities:
  - Wrap the google-genai SDK for structured output via Pydantic response_schema.
  - Enforce a per-process token-bucket rate limiter (pyrate-limiter, in-memory).
  - Track estimated daily spend; raise CostCeilingError when the daily cap is hit.
  - Truncate inputs to GEMINI_INPUT_TOKEN_CAP chars before sending (latency guard).

Architecture notes (docs/research/2026-04-09-llm-compile.md):
  - google-genai SDK (NOT deprecated google-generativeai). Client reads GEMINI_API_KEY.
  - thinking_budget=-1 → model default (thinking enabled, budget auto). "Perfection
    over speed" rule applies — do NOT set thinking_budget=0 to save latency.
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
from pydantic import BaseModel, ConfigDict
from pyrate_limiter import Duration, InMemoryBucket, Limiter, Rate

# ---------------------------------------------------------------------------
# Configuration from environment
# ---------------------------------------------------------------------------

_GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
_GEMINI_RPM = int(os.environ.get("GEMINI_RPM", "800"))
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


# ---------------------------------------------------------------------------
# Pydantic output models (contract 5 shapes)
# ---------------------------------------------------------------------------


class Entity(BaseModel):
    model_config = ConfigDict(extra='forbid')

    name: str
    type: str  # PERSON | ORG | PRODUCT | CONCEPT | EVENT | LOCATION | OTHER


class CompileResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

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
