"""Gemini LLM client for Kompl v2 nlp-service (commits 4 + 11).

Responsibilities:
  - Wrap the google-genai SDK for structured output via Pydantic response_schema.
  - Enforce a per-process token-bucket rate limiter (pyrate-limiter, in-memory).
  - Track estimated daily spend in /data/llm-cap.json (survives restarts, resets at midnight UTC);
    raise CostCeilingError before sending a call once the daily cap is reached.
  - Truncate inputs to GEMINI_INPUT_TOKEN_CAP chars before sending (latency guard).

Architecture notes (docs/research/2026-04-09-llm-compile.md):
  - google-genai SDK (NOT deprecated google-generativeai). Client reads GEMINI_API_KEY.
  - thinking_budget by task type (researched against Gemini 2.5 Flash docs):
      0    — mechanical text manipulation or binary classification (crossref, triage)
      1024 — contradiction scan (lint_scan)
      2048 — structured creative, one-off (generate_schema)
      -1   — dynamic/unlimited for deep reasoning tasks (extract, disambiguate, draft, compile)
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
import logging
import os
import re
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Literal

from pydantic import BaseModel, ConfigDict, field_validator
from pydantic.json_schema import SkipJsonSchema

from . import draft_budget, quote_check
from .providers import LLMRequest, get_provider

# ---------------------------------------------------------------------------
# Configuration from environment
# ---------------------------------------------------------------------------

# Rough char budget: 1 token ≈ 4 chars for English. 32,000 tokens → 128,000 chars.
# The prompt budget of draft_page (services/draft_budget.py decides which
# source documents fit) and the hard cut of crossref_pages.
_GEMINI_INPUT_TOKEN_CAP = int(os.environ.get("GEMINI_INPUT_TOKEN_CAP", "128000"))
# Extraction output is a structured JSON list of entities/concepts/claims — an
# over-long input produces a JSON list that exceeds max_output_tokens (32K) and
# truncates mid-string. Cap extraction inputs tighter. ~50K chars ≈ 12.5K tokens.
_GEMINI_EXTRACT_INPUT_CAP = int(os.environ.get("GEMINI_EXTRACT_INPUT_CAP", "50000"))
# DeepSeek extracted clean from a 95K-char source in the spike where Gemini
# truncates mid-string at 50K. Higher cap gives DeepSeek operators richer
# extraction on long sources without changing Gemini's tighter limit.
_DEEPSEEK_INPUT_CHAR_CAP = int(os.environ.get("DEEPSEEK_INPUT_CHAR_CAP", "200000"))


def _extract_input_cap_for(model: str) -> int:
    """Char cap on the source-document input passed to ``extract_source``.

    Gemini hits MAX_TOKENS in structured output around 50K input chars
    (the 2.5 Flash repetition-loop bug); DeepSeek empirically handles 95K
    clean. Each provider gets the cap matching its real-world capacity.
    """
    if model.startswith("deepseek-"):
        return _DEEPSEEK_INPUT_CHAR_CAP
    return _GEMINI_EXTRACT_INPUT_CAP
# Fallback when /data/llm-config.json is missing (first boot, dev env, test).
# Runtime cap comes from _read_daily_cap_usd() below; Next.js writes the file
# whenever the setting is changed in the Settings UI.
_DAILY_CAP_FALLBACK = float(os.environ.get("GEMINI_DAILY_USD_CAP", "5.00"))


# Default for call sites that haven't been updated to pass `model` — matches
# the historical hardcode so existing behaviour is preserved as a safety net.
_DEFAULT_MODEL = "gemini-2.5-flash"

# Appended to every schema-bound system prompt. DeepSeek's json_object response
# mode silently degrades to free-form text unless the literal word "json" is
# present in the prompt; Gemini ignores the additional natural-language hint.
_JSON_TRAILER = (
    "\n\nReturn the response as a single json object matching the schema "
    "described above. Do not include any text outside the json."
)


# ---------------------------------------------------------------------------
# Response-shape contract helper
# ---------------------------------------------------------------------------
#
# Builds a 4-layer JSON-shape contract block from a Pydantic response model:
#   1. Schema  — literal shape with field names, types, Literal enum lists,
#                nullability marked
#   2. Example — one filled-in canonical instance with placeholder values
#   3. Rules   — explicit "keys MUST match, top-level wrapper MUST be object"
#   4. Verify  — closing self-verification instruction
#
# Convergent industry pattern (BAML schema-aligned parsing, OpenAI structured
# outputs guide, Promptfoo evaluate-json) — measurably reduces drift on
# DeepSeek's json_object mode where response_model is server-side ignored.
#
# Output is appended AFTER _JSON_TRAILER, never replacing it: DeepSeek requires
# the literal "json" keyword in the prompt to enable json_object mode.


def _resolve_ref(ref: str, defs: dict) -> dict:
    """Resolve a JSON-Schema $ref like '#/$defs/Foo' to its definition."""
    name = ref.split("/")[-1]
    return defs.get(name, {})


def _render_schema_shape(node: dict, defs: dict, indent: int = 0) -> str:
    """Render a JSON Schema node as a literal type-placeholder shape."""
    if "$ref" in node:
        return _render_schema_shape(_resolve_ref(node["$ref"], defs), defs, indent)

    # Pydantic surfaces Optional[X] as anyOf with a `null` member.
    if "anyOf" in node:
        members = node["anyOf"]
        is_nullable = any(m.get("type") == "null" for m in members)
        non_null = [m for m in members if m.get("type") != "null"]
        if non_null and is_nullable:
            inner = _render_schema_shape(non_null[0], defs, indent)
            return f"{inner.rstrip()} or null"
        return _render_schema_shape(
            non_null[0] if non_null else members[0], defs, indent
        )

    t = node.get("type")
    pad = "  " * indent

    if t == "object":
        props = node.get("properties", {})
        if not props:
            return "{}"
        lines = ["{"]
        for key, child in props.items():
            child_rendered = _render_schema_shape(child, defs, indent + 1)
            lines.append(f"{pad}  \"{key}\": {child_rendered},")
        if lines[-1].endswith(","):
            lines[-1] = lines[-1][:-1]
        lines.append(f"{pad}}}")
        return "\n".join(lines)

    if t == "array":
        items = node.get("items", {})
        item_rendered = _render_schema_shape(items, defs, indent + 1)
        return f"[\n{pad}  {item_rendered}\n{pad}]"

    if "enum" in node:
        opts = " | ".join(repr(v) for v in node["enum"])
        return f"<one of: {opts}>"
    if t == "string":
        return "<string>"
    if t == "integer":
        return "<integer>"
    if t == "number":
        return "<number>"
    if t == "boolean":
        return "<true | false>"
    if t == "null":
        return "null"
    return "<value>"


def _render_schema_example(node: dict, defs: dict, depth: int = 0):
    """Render a canonical example value — concrete placeholders, not types."""
    if "$ref" in node:
        return _render_schema_example(_resolve_ref(node["$ref"], defs), defs, depth)
    if "anyOf" in node:
        non_null = [m for m in node["anyOf"] if m.get("type") != "null"]
        return _render_schema_example(
            non_null[0] if non_null else node["anyOf"][0], defs, depth
        )

    t = node.get("type")
    if t == "object":
        props = node.get("properties", {})
        return {key: _render_schema_example(child, defs, depth + 1) for key, child in props.items()}
    if t == "array":
        # One example item — keep prompts compact.
        return [_render_schema_example(node.get("items", {}), defs, depth + 1)]
    if "enum" in node:
        return node["enum"][0]
    if t == "string":
        return "example string"
    if t == "integer":
        return 1
    if t == "number":
        return 1.0
    if t == "boolean":
        return True
    if t == "null":
        return None
    return None


def _format_response_contract(model_class) -> str:
    """Render the 4-layer JSON-shape contract block for a Pydantic model.

    Layers (schema, example, rules, self-verify) are derived mechanically
    from model.model_json_schema(); no hand-rolled examples per call site.
    """
    import json as _json

    schema = model_class.model_json_schema()
    defs = schema.get("$defs", {})
    rendered_shape = _render_schema_shape(schema, defs, indent=0)
    rendered_example = _json.dumps(
        _render_schema_example(schema, defs, depth=0), indent=2
    )

    return (
        "\n\n"
        "Return JSON shaped exactly like this. Keys MUST match exactly.\n"
        "Top-level wrapper MUST be a JSON object, not a list.\n"
        "Do not add, rename, or remove fields.\n\n"
        "Schema:\n"
        f"{rendered_shape}\n\n"
        "Example (use this shape with your real values, not these placeholders):\n"
        f"{rendered_example}\n\n"
        "Before returning, verify your output matches the shape above."
    )


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class LLMRateLimitedError(Exception):
    """Raised when the in-process rate limiter bucket is full."""


class CostCeilingError(Exception):
    """Raised before a call is sent once today's recorded spend has reached the daily cap."""


class LLMCompileError(Exception):
    """Raised when the LLM call succeeds but the response cannot be parsed."""


# Every call site hands these on unwrapped (``except _LIMIT_ERRORS: raise``)
# rather than as LLMCompileError: the routers answer 429 llm_rate_limited and
# 503 daily_cost_ceiling for them, which is what the app checks.
_LIMIT_ERRORS = (LLMRateLimitedError, CostCeilingError)


def _parse_failure_tail(
    step: str,
    expected_wrapper: str,
    raw_text: str | None,
) -> str:
    """Build the structured tail consumed by /api/compile/progress/events.

    Output shape:
      parse_failed: step=<step>: expected_wrapper=<key>, got_type=<dict|list|other>,
      got_keys=[...], raw_excerpt='<first 200 chars>'

    Phase C (progress UI expand-to-reveal) reads this tail to show users
    the exact wrapper drift inline. Without it, the same information
    lives only in docker logs.
    """
    import json as _json

    got_type = "unknown"
    got_keys: list[str] = []
    if raw_text:
        try:
            parsed = _json.loads(raw_text)
            if isinstance(parsed, dict):
                got_type = "dict"
                got_keys = list(parsed.keys())[:10]
            elif isinstance(parsed, list):
                got_type = "list"
            elif parsed is None:
                got_type = "null"
            else:
                got_type = type(parsed).__name__
        except Exception:
            got_type = "non-json"
    excerpt = (raw_text or "")[:200].replace("\n", " ")
    return (
        f"parse_failed: step={step}: "
        f"expected_wrapper={expected_wrapper}, "
        f"got_type={got_type}, "
        f"got_keys={got_keys!r}, "
        f"raw_excerpt={excerpt!r}"
    )


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

logger = logging.getLogger(__name__)

_CAP_FILE = Path(os.environ.get("DATA_ROOT", "/data")) / "llm-cap.json"
_CONFIG_FILE = Path(os.environ.get("DATA_ROOT", "/data")) / "llm-config.json"

# Serializes the spend file's read→increment→write in _check_and_record_cost
# and the admission check in _reserve_spend. The service runs a single uvicorn
# worker by design (Dockerfile --workers 1; single-writer SQLite), so every
# request thread shares this interpreter and a threading.Lock fully closes the
# TOCTOU race — no cross-process flock needed. Concurrent extract/disambiguate
# threads used to read the same baseline and lose each other's spend increments.
_cap_lock = threading.Lock()
# Woken whenever a call in flight settles, so calls waiting at the cap re-check.
_spend_settled = threading.Condition(_cap_lock)

# Calls sent but not yet recorded, with the sum of their worst-case cost
# (see _estimate_call_usd). Guarded by _cap_lock.
_in_flight: dict[str, Any] = {"calls": 0, "usd": 0.0}
# How often a waiting call re-reads the spend and cap files (midnight reset,
# a cap raised in Settings), and the longest it waits for calls in flight:
# 600 s is the longest provider HTTP timeout (DeepSeek), so a call that never
# settles cannot hold the others back forever.
_SPEND_WAIT_POLL_S = 5.0
_SPEND_WAIT_MAX_S = 600.0

# Cache the daily cap for 30 s to avoid a filesystem read on every LLM call.
# 30 s is short enough that a Settings UI change takes effect quickly without
# requiring a service restart.
_cap_cache: dict[str, Any] = {"value": None, "read_at": 0.0}

# Per-call-site thinking_budget values. Hardcoded design-intent: each task
# was tuned (against Gemini 2.5 Flash docs at the time) to balance reasoning
# quality against cost. The Phase 8 retirement removed the user-tunable UI
# surface (settings table row + Settings page section + JSON-mirror read);
# values stay encoded here as the canonical reference. KeyError on an unknown
# call_site so a typo surfaces immediately rather than silently using 0.
_DEFAULT_THINKING_BUDGETS: dict[str, int] = {
    "extract_source": 512,
    "draft_page": 1024,
    "disambiguate_entities": 512,
    "lint_scan": 1024,
    "generate_schema": 2048,
    "crossref_pages": 0,
    "triage_page_update": 0,
    "consolidate_labels": 512,
    "judge_claim_pairs": 512,
}


def _read_thinking_budget(call_site: str) -> int:
    """Return the hardcoded thinking_budget for `call_site`."""
    if call_site not in _DEFAULT_THINKING_BUDGETS:
        raise KeyError(f"unknown thinking_budget call_site: {call_site}")
    return _DEFAULT_THINKING_BUDGETS[call_site]


def _read_daily_cap_usd() -> float:
    """Read the user-configurable daily LLM $ cap from /data/llm-config.json.

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


def _utc_today() -> str:
    """Day key for the spend file. UTC, matching the user-facing 'resets at
    midnight UTC' message — date.today() was container-local and skewed the
    reset boundary."""
    return str(datetime.now(timezone.utc).date())


def _read_cap() -> dict:
    """Read today's spend from disk. Reset automatically when the date changes."""
    try:
        data = json.loads(_CAP_FILE.read_text())
        today = _utc_today()
        if data.get("date") != today:
            return {"date": today, "total_usd": 0.0, "call_count": 0}
        return data
    except (FileNotFoundError, json.JSONDecodeError, KeyError):
        return {"date": _utc_today(), "total_usd": 0.0, "call_count": 0}


def _write_cap(data: dict) -> None:
    """Persist current spend to disk. Non-fatal on I/O failure.

    Atomic tmp + os.replace so a crash mid-write can't leave a truncated
    JSON file (which _read_cap would treat as 'no spend today' — silently
    resetting the cap).
    """
    try:
        fd, tmp_path = tempfile.mkstemp(dir=str(_CAP_FILE.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w") as f:
                f.write(json.dumps(data))
            os.replace(tmp_path, _CAP_FILE)
        except BaseException:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
    except OSError as e:
        # This call's cost is missing from the file, which is all the
        # pre-send cap check reads; later writes add only their own cost.
        logger.warning("llm-cap.json write failed (%s) — spend not persisted", e)


def _check_and_record_cost(
    model: str,
    prompt_tokens: int,
    cached_tokens: int,
    output_tokens: int,
    thought_tokens: int,
) -> None:
    """Record a returned call's cost in today's spend; never refuses it.

    Per-call cost is computed by the model's provider via
    ``provider.cost_usd(model, usage_dict)``; pricing tables live in the
    providers, the on-disk persistence here.

    The token-count signature is preserved for backward compatibility with
    the existing test fixture ``mock_cost``; the body translates to a usage
    dict for the provider.

    Called from inside the provider's ``complete()`` after every successful
    API call, while the call still holds its _spend_reservation. The cap is
    enforced before sending (_reserve_spend): a call that crosses it here was
    already billed, so its cost is recorded and its result kept, and the next
    call is refused instead.
    """
    provider = get_provider(model)
    usage = {
        "prompt_token_count":         prompt_tokens,
        "cached_content_token_count": cached_tokens,
        "candidates_token_count":     output_tokens,
        "thoughts_token_count":       thought_tokens,
    }
    cost_usd = provider.cost_usd(model, usage)

    with _cap_lock:
        cap_data = _read_cap()
        cap_data["total_usd"] = round(cap_data["total_usd"] + cost_usd, 6)
        cap_data["call_count"] = cap_data.get("call_count", 0) + 1
        _write_cap(cap_data)


def _estimate_call_usd(req: LLMRequest) -> float:
    """Worst-case cost of one call, known before it is sent.

    The prompt at ~4 chars per token plus the full max_output_tokens at the
    output rate: thinking counts against that limit on every supported
    provider (Gemini max_output_tokens, DeepSeek max_tokens).
    """
    prompt_chars = sum(len(m.get("content", "")) for m in req.messages)
    return get_provider(req.model).cost_usd(req.model, {
        "prompt_token_count":         prompt_chars // 4 + 1,
        "cached_content_token_count": 0,
        "candidates_token_count":     req.max_output_tokens,
        "thoughts_token_count":       0,
    })


def _reserve_spend(req: LLMRequest) -> float:
    """Admit one call under the daily cap, before it is sent; return its hold.

    Refuses with CostCeilingError once today's recorded spend has reached the
    cap. Otherwise the call goes out while recorded spend plus the worst case
    of calls already in flight is under the cap, and holds its own worst case
    until it is recorded. Parallel calls near the cap therefore wait for calls
    in flight to settle instead of all going out at once, and spend passes the
    cap by at most about one call. A cap of 0 is unlimited: nothing waits or
    is refused. After _SPEND_WAIT_MAX_S a waiting call goes out anyway.
    """
    estimate = _estimate_call_usd(req)
    deadline = time.monotonic() + _SPEND_WAIT_MAX_S
    with _spend_settled:
        while True:
            daily_cap = _read_daily_cap_usd()
            spent = _read_cap()["total_usd"]
            if daily_cap > 0 and spent >= daily_cap:
                raise CostCeilingError(
                    f"Daily LLM spend limit (${daily_cap:.2f}) reached. "
                    f"Today's spend: ${spent:.4f}. "
                    f"Resets at midnight UTC."
                )
            if (
                daily_cap <= 0
                or spent + _in_flight["usd"] < daily_cap
                or time.monotonic() >= deadline
            ):
                _in_flight["calls"] += 1
                _in_flight["usd"] += estimate
                return estimate
            _spend_settled.wait(_SPEND_WAIT_POLL_S)


def _release_spend(estimate: float) -> None:
    """Drop a settled call's hold and wake the calls waiting at the cap."""
    with _spend_settled:
        _in_flight["calls"] -= 1
        # Back to exactly zero when idle so float drift never accumulates.
        _in_flight["usd"] = _in_flight["usd"] - estimate if _in_flight["calls"] else 0.0
        _spend_settled.notify_all()


@contextmanager
def _spend_reservation(req: LLMRequest) -> Iterator[None]:
    """Hold a place under the daily cap from before the send until the call
    is recorded (or fails). Every provider's complete() sends inside one."""
    estimate = _reserve_spend(req)
    try:
        yield
    finally:
        _release_spend(estimate)


def _salvage_extraction(raw_text: str) -> "LLMExtractionResponse | None":
    """Best-effort recovery of truncated JSON from a Gemini repetition loop.

    When Gemini emits 32 k tokens of "AI", "AI", "AI",... and truncates mid-
    string, the prefix is still valid extraction work we paid for. json-repair
    closes unterminated arrays/strings and drops the malformed tail. Schema-
    guided mode fills missing required fields with sensible defaults.

    Returns the parsed model on success, None on irrecoverable garbage. Never
    raises — the caller decides whether to retry or surface the original error.
    """
    try:
        from json_repair import repair_json
    except ImportError:
        return None
    try:
        repaired = repair_json(raw_text, return_objects=True)
        if not isinstance(repaired, dict):
            return None
        return LLMExtractionResponse.model_validate(repaired)
    except Exception:
        return None


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
""" + _JSON_TRAILER


class Contradiction(BaseModel):
    # No extra='forbid' — LLM output model.
    page_a: str
    page_b: str
    claim: str
    severity: str  # 'minor' | 'major'


class LintScanResponse(BaseModel):
    # No extra='forbid' — LLM output model.
    contradictions: list[Contradiction]


def lint_scan(pages: list[str], model: str = _DEFAULT_MODEL) -> LintScanResponse:
    """Scan page summaries for contradictions.

    pages: list of "[page_id] title: summary" formatted strings.
    model: Gemini model (compile_model from Next.js settings; defaults to Flash).

    Raises:
        LLMRateLimitedError  — bucket exhausted
        CostCeilingError     — daily $ cap exceeded
        LLMCompileError      — parse failure
    """
    if not pages:
        return LintScanResponse(contradictions=[])

    user_payload = "\n\n".join(pages)

    provider = get_provider(model)
    try:
        result = provider.complete(LLMRequest(
            model=model,
            messages=[
                {"role": "system", "content": _LINT_SYSTEM_PROMPT},
                {"role": "user",   "content": user_payload},
            ],
            response_model=None,
            thinking_budget=_read_thinking_budget('lint_scan'),
            max_output_tokens=4096,  # lint responses are short
            step="lint",
            extra={"force_json_mime": True},
        ))
    except _LIMIT_ERRORS:
        raise
    except Exception as e:
        raise LLMCompileError(f"lint_scan_failed: {e}") from e

    raw_text = result.text
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
        raise LLMCompileError(
            f"lint_scan_parse_failed: {e}; "
            + _parse_failure_tail(
                step="lint", expected_wrapper="contradictions", raw_text=raw_text,
            )
        ) from e


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


def _quote_or_none(value: Any) -> str | None:
    """A quote as the LLM gave it; empty, missing or not a string reads as
    None, so one bad quote never fails the whole extraction (DeepSeek's
    json_object mode enforces no schema)."""
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _require_quote_key(schema: dict[str, Any]) -> None:
    """List `quote` as required in the schema the LLM sees, so Gemini always
    writes it (it may skip optional fields); null stays allowed, and
    parsing still accepts a missing key."""
    required = schema.setdefault("required", [])
    if "quote" not in required:
        required.append("quote")


class _Quoted(BaseModel):
    """Items carrying `quote`, the source sentence they rest on (plan 3.2,
    D4), and `quote_verified`, set after parsing by services/quote_check.py
    (True: found in the source, and `quote` is then the source's own text;
    False: not found, kept but never shown as quoted; None: no quote).
    `quote_verified` is left out of the schema the LLM sees. Extractions
    made before quotes have neither key. The fields are declared last in
    each model, so the LLM writes the item before its quote."""
    model_config = ConfigDict(json_schema_extra=_require_quote_key)

    @field_validator("quote", mode="before", check_fields=False)
    @classmethod
    def _soft_quote(cls, value: Any) -> str | None:
        return _quote_or_none(value)


class ExtractionClaim(_Quoted):
    claim: str
    confidence: str    # "stated" | "implied" | "speculative"
    entities_involved: list[str]
    quote: str | None = None
    quote_verified: SkipJsonSchema[bool | None] = None


class ExtractionRelationship(_Quoted):
    from_entity: str   # JSON key: "from_entity" (avoids Python reserved word)
    to: str
    # uses | competes_with | part_of | created_by | related_to | contradicts.
    # A free string: an off-list value must not fail the whole extraction;
    # the app normalises the spelling (app/src/lib/relation-rows.ts).
    type: str
    description: str
    quote: str | None = None
    quote_verified: SkipJsonSchema[bool | None] = None
    # Both ends are names from this extraction's entity or concept lists
    # (by skeleton); set after parsing, outside the LLM's schema. Counted
    # only: nothing is dropped until a measured run decides.
    ends_listed: SkipJsonSchema[bool | None] = None


class ExtractionContradiction(BaseModel):
    claim: str
    against: str       # what it contradicts (if detectable from source alone)


class LLMExtractionResponse(BaseModel):
    """Structured extraction result from a single source document.

    No extra='forbid' — google-genai rejects additionalProperties=false
    in response_schema (consistent with all other LLM output models here).
    """
    title: str          # document title — empty string if not derivable
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
1. title         — the document's actual title as it appears in the source
   - For papers: the paper's title from the title page (NOT the filename, NOT
     a publisher boilerplate like "The X Center for Y Research", NOT an
     arXiv/DOI identifier).
   - For articles, books, posts: their stated title.
   - Skip headers, running heads, page numbers, author lists, and any
     reversed/garbled text from arXiv side stamps.
   - If the document genuinely has no clear title, return an empty string ""
     and the caller will fall back to the filename.
2. entities      — named entities with name, type, mentions, and context
   - name: canonical name of the entity (a string — do NOT use the entity name as a dict key)
   - type: PERSON | ORG | PRODUCT | CONCEPT | EVENT | LOCATION | OTHER
   - mentions: list of exact text spans from the source
   - context: 1-2 sentence description of this entity as discussed in the source
3. concepts      — key concepts with name and description
   - name: short canonical name of the concept
   - description: 1-2 sentence description of the concept
4. claims        — specific factual claims
   - claim: the claim text itself (a string — full sentence)
   - confidence: "stated" (explicit) | "implied" (strongly suggested) | "speculative"
   - entities_involved: list of entity/concept names from your entities/concepts lists
   - quote: the one sentence of the source that states or most directly
     supports the claim, copied exactly as written: same words, same order,
     no paraphrase, no ellipsis. For a very long sentence copy the
     continuous part that carries the claim. null only if no sentence does.
5. relationships — connections between the entities and concepts you listed
   - from_entity, to: names copied exactly from your entities or concepts
     lists; do not introduce other names
   - type: one of these, read as "from_entity <type> to":
       uses           from uses, runs on or is built with to
                      (from_entity "ChatGPT", to "GPT-4")
       part_of        from is a part, member or component of to, the whole
                      (from_entity "Chrome DevTools", to "Google Chrome")
       created_by     from was created, founded, written or built by to, the maker
                      (from_entity "Linux", to "Linus Torvalds")
       competes_with  from and to are rival alternatives; order does not matter
                      (from_entity "Firefox", to "Google Chrome")
       contradicts    from and to make claims that cannot both be true; order
                      does not matter (from_entity "Steady-state theory",
                      to "Big Bang theory")
       related_to     only when none of the types above fits
     When the source says it the other way round ("Linus Torvalds created
     Linux"), swap the names to fit the type; never invent an inverse type.
   - description: 1-sentence explanation, in your words, of how they relate
   - quote: the source sentence that states this relationship, copied
     exactly as written; null if no single sentence states it
6. contradictions — claims that contradict other sources or internal logic
   - claim: what this source claims
   - against: what it contradicts (leave empty string if unknown)
7. summary       — 2-4 sentence summary of the source

Keep lists focused: 5-15 entities, 3-10 concepts, 3-15 claims, 3-10 relationships.
Each entity appears once. Stop as soon as the source is covered — do NOT
repeat names or pad the output.
""" + _JSON_TRAILER


def _checked(
    result: LLMExtractionResponse, source_id: str, markdown: str
) -> LLMExtractionResponse:
    """The extraction after the soft quote check and the relation-end count
    (services/quote_check.py), both in place, with one log line. Never
    raises: a failed check leaves quote_verified unset and is logged, as a
    quote is never a reason to lose an extraction."""
    try:
        report = quote_check.check_extraction(
            result.claims,
            result.relationships,
            [e.name for e in result.entities] + [c.name for c in result.concepts],
            markdown,
        )
    except Exception as e:  # noqa: BLE001 - logged; the extraction stands
        print(f"[extract] {source_id}: quote check failed: {e!r}", file=sys.stderr, flush=True)
        return result
    unlisted = report.unlisted_ends
    print(
        f"[extract] {source_id}: verified quotes: claims "
        f"{report.claims_verified}/{report.claims_quoted} (of {report.claims}), "
        f"relationships {report.relations_verified}/{report.relations_quoted} "
        f"(of {report.relations}); relation ends not in the entity/concept "
        f"lists: {len(unlisted)}" + (f" {list(unlisted[:10])}" if unlisted else ""),
        file=sys.stderr,
        flush=True,
    )
    return result


def extract_source(
    source_id: str,
    markdown: str,
    ner_output: dict[str, Any],
    keyphrase_output: dict[str, Any] | None,
    tfidf_output: dict[str, Any] | None,
    model: str = _DEFAULT_MODEL,
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

    source_text = markdown  # the quote check reads the whole source
    input_cap = _extract_input_cap_for(model)
    if len(markdown) > input_cap:
        truncated = markdown[:input_cap]
        last_para = truncated.rfind("\n\n")
        markdown = truncated[:last_para] if last_para > 0 else truncated

    ner_section = _json.dumps(ner_output, ensure_ascii=False)
    keyphrase_section = _json.dumps(keyphrase_output, ensure_ascii=False) if keyphrase_output else "N/A — no keyphrase output"
    tfidf_section = _json.dumps(tfidf_output, ensure_ascii=False) if tfidf_output else "N/A — first compile, no existing wiki pages"

    user_payload = (
        f"Source ID: {source_id}\n\n"
        f"NLP extraction results:\n"
        f"Named entities (spaCy NER):\n{ner_section}\n\n"
        f"Keyphrases:\n{keyphrase_section}\n\n"
        f"TF-IDF overlap with existing wiki:\n{tfidf_section}\n\n"
        f"---\n\n"
        f"Source document:\n\n{markdown}"
    )

    provider = get_provider(model)
    try:
        result = provider.complete(LLMRequest(
            model=model,
            messages=[
                {"role": "system", "content": _EXTRACTION_SYSTEM_PROMPT},
                {"role": "user",   "content": user_payload},
            ],
            response_model=LLMExtractionResponse,
            thinking_budget=_read_thinking_budget('extract_source'),
            max_output_tokens=32768,
            temperature=0.0,
            step="extract",
        ))
    except _LIMIT_ERRORS:
        raise
    except Exception as e:
        raise LLMCompileError(f"extract_llm_call_failed: {e}") from e

    raw_text = result.text
    if not raw_text:
        raise LLMCompileError("extract_llm_error: empty response text")

    if result.parsed is not None:
        return _checked(result.parsed, source_id, source_text)  # type: ignore[arg-type]

    # Recovery path for the Gemini 2.5 Flash structured-output repetition
    # loop (upstream bug, see repo issue). Three attempts in order of cost:
    #
    # (1) Salvage the truncated prefix via json-repair — zero extra Gemini
    #     cost, recovers the majority of repetition-loop responses because
    #     the valid entities came before the stuck "AI","AI","AI",... tail.
    # (2) If finish_reason=MAX_TOKENS AND salvage failed, retry once with
    #     halved input — different prompt path usually escapes the loop.
    # (3) On all-fail, chain both errors so we can see what each attempt hit.
    first_err = result.parse_error
    salvaged = _salvage_extraction(raw_text)
    if salvaged is not None:
        print(
            f"[extract] salvaged truncated response via json-repair "
            f"(entities={len(salvaged.entities)}, concepts={len(salvaged.concepts)})",
            file=sys.stderr,
            flush=True,
        )
        return _checked(salvaged, source_id, source_text)

    if result.finish_reason != "MAX_TOKENS":
        # Not a truncation — parse error is something else (schema drift,
        # malformed response). No point retrying with halved input.
        raise LLMCompileError(
            f"extract_llm_parse_failed: {first_err}; "
            + _parse_failure_tail(
                step="extract", expected_wrapper="entities", raw_text=raw_text,
            )
        ) from first_err

    if not model.startswith("gemini-"):
        # The halved-input fallback is a Gemini-bug-specific mitigation for
        # the 2.5 Flash structured-output repetition loop. DeepSeek (and any
        # other provider) doesn't share the pathology; surface the original
        # parse error rather than doubling cost on an unvalidated retry path.
        raise LLMCompileError(
            f"extract_llm_parse_failed: {first_err}; "
            + _parse_failure_tail(
                step="extract", expected_wrapper="entities", raw_text=raw_text,
            )
        ) from first_err

    print(
        f"[extract] MAX_TOKENS truncation + salvage failed — "
        f"retrying with halved input",
        file=sys.stderr,
        flush=True,
    )

    half_markdown = markdown[: len(markdown) // 2]
    last_para = half_markdown.rfind("\n\n")
    if last_para > 0:
        half_markdown = half_markdown[:last_para]

    fallback_user_payload = (
        f"Source ID: {source_id}\n\n"
        f"NLP extraction results:\n"
        f"Named entities (spaCy NER):\n{ner_section}\n\n"
        f"Keyphrases:\n{keyphrase_section}\n\n"
        f"TF-IDF overlap with existing wiki:\n{tfidf_section}\n\n"
        f"---\n\n"
        f"Source document:\n\n{half_markdown}"
    )

    try:
        fallback_result = provider.complete(LLMRequest(
            model=model,
            messages=[
                {"role": "system", "content": _EXTRACTION_SYSTEM_PROMPT},
                {"role": "user",   "content": fallback_user_payload},
            ],
            response_model=LLMExtractionResponse,
            thinking_budget=_read_thinking_budget('extract_source'),
            max_output_tokens=32768,
            temperature=0.0,
            step="extract-fallback",
        ))
    except _LIMIT_ERRORS:
        raise
    except Exception as fallback_call_err:
        raise LLMCompileError(
            f"extract_llm_parse_failed_after_fallback: "
            f"first={first_err}; fallback_call={fallback_call_err}"
        ) from first_err

    fallback_raw = fallback_result.text
    if not fallback_raw:
        raise LLMCompileError(
            f"extract_llm_parse_failed_after_fallback: "
            f"first={first_err}; fallback=empty; "
            + _parse_failure_tail(
                step="extract-fallback", expected_wrapper="entities", raw_text=fallback_raw,
            )
        ) from first_err

    if fallback_result.parsed is not None:
        return _checked(fallback_result.parsed, source_id, source_text)  # type: ignore[arg-type]

    fallback_parse_err = fallback_result.parse_error
    salvaged_fallback = _salvage_extraction(fallback_raw)
    if salvaged_fallback is not None:
        print(
            f"[extract] salvaged fallback response via json-repair",
            file=sys.stderr,
            flush=True,
        )
        return _checked(salvaged_fallback, source_id, source_text)
    raise LLMCompileError(
        f"extract_llm_parse_failed_after_fallback: "
        f"first={first_err}; second={fallback_parse_err}; "
        + _parse_failure_tail(
            step="extract-fallback", expected_wrapper="entities", raw_text=fallback_raw,
        )
    ) from first_err


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


# Shared by both disambiguation prompts: how to read a pair's same_source.
_DISAMBIGUATION_SAME_SOURCE = """\
Each pair also carries same_source: true when one source names both. Treat
it as a hint, not a rule: a source that names two things side by side is
usually telling them apart, but a source can also introduce one thing by its
full name and its abbreviation.
"""


# Shared by both disambiguation prompts, only for a batch whose pairs have a
# side that is a page the wiki already holds (routers/resolution.py
# DisambiguateSide). Batches without one get the prompts as they were: the
# block in every batch turned an asset and its platform into "same".
_DISAMBIGUATION_WIKI_PAGE = """\
In these pairs one side carries known_names: that side is a page the wiki
already holds. Its context is the page's own summary, not a sentence from
one source, and known_names lists the other names the wiki already files
under that page (the list may be empty). Judge the names first:
  - the other side is that page when its name is one of the known names or
    a spelling of one (case, spacing, hyphens, British or American
    spelling), or another name for the very same thing the summary defines;
  - when the other side's context calls the page's topic broader, narrower
    or related, that is one source's wording: weigh it against the page's
    own summary rather than taking it as the answer;
  - the rules for "different" still hold whatever either side's wording: a
    different thing that only relates to what the page defines stays
    different. That covers a type, form, part or sub-topic of it; an asset,
    token, coin or ticker and the platform or network it belongs to; a
    product and its maker; a part and its whole.
"""


def _entity_disambiguation_prompt(pages: bool) -> str:
    return """\
You are an entity resolution assistant. For each pair of entities, decide
whether they refer to the same real-world entity or concept.

""" + _DISAMBIGUATION_SAME_SOURCE + ("\n" + _DISAMBIGUATION_WIKI_PAGE if pages else "") + """
For each pair return:
  entity_a   — name of the first entity (copy from input)
  entity_b   — name of the second entity (copy from input)
  decision   — "same" (they are the same entity), "different" (distinct),
               or "ambiguous" (cannot determine from context)
  canonical  — if "same", one of the two names exactly as given: the more
               complete / commonly used one. Set to null for "different"
               or "ambiguous".
  reason     — brief explanation (1 sentence)

Return "different" when the two are related but not one thing:
  - a part and its whole ("Old Town" / the city it is in)
  - a place and something located in it ("London Eye" / "London")
  - a parent organisation and its subsidiary, division or foundation
    ("Alphabet" / "Google", "Mozilla" / "Mozilla Foundation")
  - a product and its maker ("iPhone" / "Apple")
  - a founder or leader and the organisation ("Sam Altman" / "OpenAI")
  - siblings that differ by one modifier ("North Dakota" / "South Dakota",
    "Oslo City Hall" / "Oslo City Museum")
  - versions or editions of one thing ("Python 2" / "Python 3",
    "GPT-4" / "GPT-4o")
  - two people who share a surname or a first name

Be conservative: only return "same" if you are confident. Prefer "ambiguous"
over a wrong "same" call. Do not hallucinate.
""" + _JSON_TRAILER


def _concept_disambiguation_prompt(pages: bool) -> str:
    known_name = """\
      * one of a page's known_names or a spelling of one, or another name
        for the very same thing the page's summary defines
""" if pages else ""
    return """\
You are a concept resolution assistant. For each pair of concepts, decide
whether they refer to the same concept or merely related concepts.

Concepts are abstract ideas, techniques, or fields (e.g. "Transformer
Architecture", "Chain of Thought Prompting", "Machine Learning"). They share
vocabulary even when they are different concepts — "Transformer Architecture"
and "Self-Attention" both talk about transformers, but attention is one
mechanism inside the architecture, not the architecture itself.

""" + _DISAMBIGUATION_SAME_SOURCE + ("\n" + _DISAMBIGUATION_WIKI_PAGE if pages else "") + """
For each pair return:
  entity_a   — name of the first concept (copy from input)
  entity_b   — name of the second concept (copy from input)
  decision   — "same" (truly the same concept, not merely related),
               "different" (distinct concepts, even if related),
               or "ambiguous" (cannot determine from context)
  canonical  — if "same", one of the two names exactly as given: the
               clearer one (prefer the more complete / canonical form).
               Set to null for "different" or "ambiguous".
  reason     — brief explanation (1 sentence)

STRICTNESS RULES for this task:
  - Return "same" ONLY for:
      * paraphrases (e.g. "Chain of Thought Prompting" ≡ "CoT reasoning")
      * acronym/expansion pairs (e.g. "NLP" ≡ "Natural Language Processing")
      * historical rename of exactly the same concept
""" + known_name + """\
  - Return "different" whenever one concept is a sub-topic, mechanism, component,
    application, or technique of the other — even when they appear together often.
  - When in doubt, prefer "different" over "same". Wrong merges are costly to
    undo and permanently lose the ability to have a page about the narrower
    concept. Duplicate pages self-heal as more sources arrive.
""" + _JSON_TRAILER


_DISAMBIGUATION_SYSTEM_PROMPT = _entity_disambiguation_prompt(pages=False)
_DISAMBIGUATION_CONCEPT_SYSTEM_PROMPT = _concept_disambiguation_prompt(pages=False)
_DISAMBIGUATION_PAGE_SYSTEM_PROMPT = _entity_disambiguation_prompt(pages=True)
_DISAMBIGUATION_CONCEPT_PAGE_SYSTEM_PROMPT = _concept_disambiguation_prompt(pages=True)


# Sized for the 10-pair batch of routers/resolution.py. Each decision is
# {entity_a, entity_b, decision, canonical, reason} where `reason` carries
# free-text justification (e.g., "Bagging is a specific ensemble method...");
# 10 × ~250 tokens + thinking overhead easily exceeds 2048. Session 97f58805
# hit truncation: raw_excerpt cut off mid-string at line 50 col 166 of the
# JSON. 8192 matches generate_schema (structured-creative reasoning tier).
# GET /llm/pricing reports it for the wiki repair estimate.
_DISAMBIGUATE_MAX_OUTPUT_TOKENS = 8192


def disambiguate_entities(
    pairs: list[dict[str, Any]],
    model: str = _DEFAULT_MODEL,
    pair_kind: str = "entity",
) -> DisambiguationResponse:
    """Batch LLM entity disambiguation for the 0.7–0.9 embedding similarity band.

    Accepts up to 10 pairs per call (caller is responsible for batching).
    Each pair is a dict with keys entity_a and entity_b, each a dict with
    at least: name (str), type (str), context (str), and on a side that is
    a wiki page known_names (list[str]); and same_source (bool), which both
    prompts read as a hint. A batch with a known_names side gets the prompt
    with the page rules (_DISAMBIGUATION_WIKI_PAGE); the caller keeps such
    pairs in batches of their own.

    Raises:
        LLMRateLimitedError  — bucket exhausted after 60s wait
        CostCeilingError     — daily $ cap exceeded
        LLMCompileError      — LLM returned but JSON parse failed
        RuntimeError         — GEMINI_API_KEY not set
    """
    import json as _json

    if not pairs:
        return DisambiguationResponse(results=[])

    pairs_json = _json.dumps(pairs, ensure_ascii=False, indent=2)
    # The page rules go only to a batch with a side bound to a page.
    pages = any("known_names" in p[side] for p in pairs for side in ("entity_a", "entity_b"))
    if pair_kind == "concept":
        system_prompt = _DISAMBIGUATION_CONCEPT_PAGE_SYSTEM_PROMPT if pages else _DISAMBIGUATION_CONCEPT_SYSTEM_PROMPT
    else:
        system_prompt = _DISAMBIGUATION_PAGE_SYSTEM_PROMPT if pages else _DISAMBIGUATION_SYSTEM_PROMPT
    user_payload = f"Pairs to resolve:\n{pairs_json}"

    provider = get_provider(model)
    try:
        result = provider.complete(LLMRequest(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_payload},
            ],
            response_model=DisambiguationResponse,
            thinking_budget=_read_thinking_budget('disambiguate_entities'),
            max_output_tokens=_DISAMBIGUATE_MAX_OUTPUT_TOKENS,
            temperature=0.0,
            step="disambiguate",
        ))
    except _LIMIT_ERRORS:
        raise
    except Exception as e:
        raise LLMCompileError(f"disambiguate_llm_call_failed: {e}") from e

    raw_text = result.text
    if not raw_text:
        raise LLMCompileError("disambiguate_llm_error: empty response text")

    if result.parsed is not None:
        return result.parsed  # type: ignore[return-value]
    raise LLMCompileError(
        f"disambiguate_llm_parse_failed: {result.parse_error}; "
        + _parse_failure_tail(
            step="disambiguate", expected_wrapper="results", raw_text=raw_text,
        )
    ) from result.parse_error


# ---------------------------------------------------------------------------
# Page drafting — write a single wiki page from source content (Part 2c-i)
# ---------------------------------------------------------------------------

_FRONTMATTER_RULES = """\
OUTPUT FORMAT RULES (strict):
- Begin the response with YAML frontmatter delimited by a line containing exactly `---`, then the YAML keys, then a closing line containing exactly `---`, then a blank line, then the body.
- The frontmatter has exactly four keys: title, page_type, category, summary. Add no other keys (no sources, dates, status or aliases); the wiki records those itself.
- Do NOT wrap the body in a fenced code block (no ``` markers around the body). Output raw markdown.
- Do NOT add a `## Sources` section — the wiki renders provenance separately in a footer.

Example frontmatter shape:
---
title: <page title>
page_type: <type>
category: <category>
summary: <1-2 sentences>
---
"""

# Appended to every page type that synthesizes several sources. Models fill
# thin sources with general knowledge and turn "different milestones" into
# disputes unless told otherwise.
_GROUNDING_RULES = """\
SOURCES ONLY:
- State only what the material in this prompt says: the source documents, the pre-extracted data and, for an overview, the listed wiki pages. Add nothing from your own knowledge.
- Do not join facts into a claim no source makes: no new origins, causes, effects, rankings, "firsts" or comparisons.
- Keep each source's strength of wording: "primarily a store of value" must not become "digital gold".
- One exception: the opening paragraph may define a general term in one plain sentence without a citation. That sentence names no person, organization, product, date, number or ranking.
- Thin sources make a short page. Do not pad it.

DISAGREEMENTS (this format applies whatever the wiki schema says):
- Two claims disagree only if both cannot be true. Different milestones (designed vs first released, proposed vs founded), dates of different events, or one source giving more detail are not disagreements: state each fact with its own citation.
- Give each real disagreement its own section with one of these two headings, never another (not "Contradictions" or "Conflicting claims"):
  - "### Disputed: <topic>" when sources disagree about the same fact. State each side with its citation: "One source gives 2013 [S1]; another gives 2015 [S2]."
  - "### Changed: <topic>" when a later source shows that an earlier claim no longer holds (a figure, status or rule that changed over time). Give the older claim with its source's date, then the newer one with its source's date: "The limit was 10 as of 2020 [S1]; it is 20 as of 2023 [S2]."
- Tell the two apart by the dates in SOURCE DATES: Changed only when the later-dated source shows the change; otherwise Disputed. Without dates, use Disputed.
- Never add either section to say there is nothing to report."""

# One-line forms of the two headings, restated where the prompt reminds the
# model of them (the final check, update drafts).
_DISAGREEMENT_HEADINGS = '"### Disputed: <topic>" or "### Changed: <topic>"'

# Film run (2026-10-25): under "use one of these exact strings; invent only
# if none fit", the first source's "Design & Accessibility" fitted every
# design source. A label is reused only for the field it names, and a new
# label names one field.
_CATEGORY_RULE = (
    "When selecting the category field, follow CATEGORY ASSIGNMENT (in the user prompt): use an existing "
    "category, written exactly as listed, only when it names this page's main subject field. "
    'A new category names one field in 1-3 words; never join two fields with "&", "and" or "/".'
)

_DRAFT_PAGE_PROMPTS: dict[str, str] = {
    "source-summary": f"""\
Write a source summary wiki page for the following source document.

{_FRONTMATTER_RULES}
The page body should begin directly with the reproduced source content (no `## Content` heading — the renderer labels this section externally), followed by the sub-sections below:
- Reproduce the source content faithfully and in full — do NOT summarize, paraphrase, or shorten it; copy the text as written, preserving the author's voice, formatting, headings, and structure; for GitHub repos this means the full README.
- ## Key Facts (3-5 bullet points of the most important facts for quick reference)
- ## Entities Mentioned (bullet list of key people, companies, tools)
- ## Concepts (bullet list of key ideas)

The reproduced source content is the most important part — it must contain the actual source text, not a rewrite of it. Do not add information not in the source.
Use [[wikilinks]] for any entities, people, tools, or concepts that have their own wiki pages.
Frontmatter keys: title, page_type: source-summary, category, summary (1-2 sentences describing what this source is about).
{_CATEGORY_RULE}""",

    "entity": f"""\
Write an entity wiki page synthesizing information from multiple sources.

{_FRONTMATTER_RULES}
The page body should include:
- A brief description paragraph
- Thematic sections (what this entity does, key facts, relationships to other entities)

Synthesize across all sources. If sources provide complementary information, merge coherently.
Use [[wikilinks]] when referencing related entities or concepts that have wiki pages.
Frontmatter keys: title, page_type: entity, category, summary (1-2 sentences).
{_CATEGORY_RULE}

{_GROUNDING_RULES}""",

    "concept": f"""\
Write a concept wiki page synthesizing information from multiple sources.

{_FRONTMATTER_RULES}
The page body should include:
- A definition/description paragraph
- ## Key Claims (from sources, each with its citation)
- Disagreements between sources, only if two sources make claims that cannot both be true, in the DISAGREEMENTS format below; otherwise leave them out
- ## Related Concepts (at most 5 pages from the wikilink list that the sources directly connect to this topic; leave it out if there are none)

Synthesize across sources. Attribute specific claims to their source.
Use [[wikilinks]] when referencing related concepts or entities that have wiki pages.
Frontmatter keys: title, page_type: concept, category, summary (1-2 sentences).
{_CATEGORY_RULE}

{_GROUNDING_RULES}""",

    "comparison": f"""\
Write a comparison wiki page comparing two entities or concepts.

{_FRONTMATTER_RULES}
The page body should include:
- A brief intro paragraph explaining what is being compared and why
- A structured comparison (use a table or parallel sections)
- ## Summary: what the sources say each is suited for (only if they say so)

Be objective and factual.
Use [[wikilinks]] when naming the entities being compared and any related concepts that have wiki pages.
Frontmatter keys: title, page_type: comparison, category, summary (1-2 sentences describing what is being compared).
{_CATEGORY_RULE}

{_GROUNDING_RULES}""",

    "overview": f"""\
Write an overview wiki page summarizing all pages in a category.

{_FRONTMATTER_RULES}
The page body should include:
- A high-level summary paragraph of the category
- Brief descriptions of each entity/concept in the category (with [[wikilinks]] from the provided list)
- ## Common Themes
- ## Open Questions (gaps in coverage, if any)

Frontmatter keys: title, page_type: overview, category, summary (1-2 sentences describing this category).
{_CATEGORY_RULE}

{_GROUNDING_RULES}""",
}


_CITED_PAGE_TYPES = ("entity", "concept", "comparison", "overview")

# Output ceiling for one draft_page call. DeepSeek counts reasoning tokens
# against it too: at 16384, 7 of 79 drafts on the held-out corpus ran out
# (2026-10-25), one empty (a 4-source page lost) and others cut mid-link.
# GET /llm/pricing reports it (with the prompt cap above) so the app's
# page-update estimate works from the same limits.
_DRAFT_PAGE_MAX_OUTPUT_TOKENS = 32768
# A draft that runs out of room is asked once more, then fails: a cut-off
# page is never returned (owner decision 2026-10-25).
_DRAFT_PAGE_ATTEMPTS = 2
# Finish reasons meaning the output ceiling was hit: Gemini, DeepSeek.
_OUTPUT_CAP_FINISH = frozenset({"MAX_TOKENS", "LENGTH"})

_CITATION_RULES = """\
CITATIONS:
- Each source below (and each block of pre-extracted data) has a label such as [S1].
- Put the label of the source that supports a claim right after the claim, e.g. "Bitcoin launched in 2009 [S1]." Cite several sources as [S1][S2].
- A label is a footnote marker, never a word in the sentence. Wrong: "[S2] states that…", "according to [S1]", "while [S3] claims…". Right: "One source gives 2013 [S1]; another gives 2015 [S2]."
- Use only the labels given in this prompt. Do not cite in the YAML frontmatter.
- Never write source ids, UUIDs, or phrases like "From source" or "Pre-extracted data" in the page.
- Keep the citation labels that already appear in the existing page content when you keep their claims."""


def _final_check(cited: bool) -> str:
    """Short checklist appended after the source documents."""
    lines = ["", "FINAL CHECK before answering:"]
    if cited:
        lines += [
            "- Every fact comes from the material above; facts from a source document carry its label. "
            "Nothing is added from memory.",
            "- Labels follow claims and are never words in a sentence.",
        ]
    lines.append("- Each wiki page is linked at most once; source documents are never linked.")
    if cited:
        lines.append(
            f"- A disagreement only where two sources truly conflict, headed {_DISAGREEMENT_HEADINGS}; "
            "at most 5 Related Concepts."
        )
    lines.append("- Frontmatter keys: title, page_type, category, summary.")
    return "\n".join(lines) + "\n"


@dataclass(frozen=True)
class DraftPageResult:
    markdown: str
    # Sources whose text or pre-extracted data went into the prompt, in the
    # caller's order. The commit credits only these (audit B4).
    used_source_ids: list[str]
    # Sources that did not go in whole (draft_budget.SourceCut).
    cuts: list[draft_budget.SourceCut]


def _source_header(sc: dict[str, Any], cite: bool) -> str:
    """The line that opens one source document in the draft prompt."""
    name = sc.get("title", sc.get("source_id", ""))
    full = sc.get("shortened_from")
    if full:
        name = f"{name} (shortened: first {len(sc.get('markdown', '')):,} of {full:,} characters)"
    label = sc.get("citation_label")
    return f"--- Source [{label}]: {name} ---" if cite and label else f"--- Source: {name} ---"


def _source_dates_line(sources: list[dict[str, Any]], earlier: list[dict[str, Any]]) -> str | None:
    """Each labelled source's date, for telling a Changed claim from a
    Disputed one (plan 3.1, D5). The app sends the publication date when it
    knows it, else the date the source was saved (date_kind "saved").
    None when no source has a date (older apps send none)."""
    entries: list[str] = []
    seen: set[str] = set()
    for sc in [*sources, *earlier]:
        label, date = sc.get("citation_label"), sc.get("date")
        if not label or not date or label in seen:
            continue
        seen.add(label)
        entries.append(f"[{label}] {date}{' (saved)' if sc.get('date_kind') == 'saved' else ''}")
    if not entries:
        return None
    return (
        'SOURCE DATES (when each source was published; "saved" marks the day it was added to the wiki, '
        "given when the publication date is unknown): " + "; ".join(entries)
    )


def _earlier_sources_note(earlier: list[dict[str, Any]]) -> list[str]:
    listed = "; ".join(f"[{es['citation_label']}] {es['title']}" for es in earlier)
    return [
        "Earlier sources cited in the existing page content (not included below; "
        f"keep their labels where you keep their claims): {listed}",
        "",
    ]


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
    model: str = _DEFAULT_MODEL,
    earlier_sources: list[dict[str, Any]] | None = None,
) -> DraftPageResult:
    """Draft a wiki page.

    Returns the raw markdown for the page (including YAML frontmatter), the
    sources the prompt used and the ones the prompt budget cut. Uses
    free-form text output (no response_schema) since page content is
    unstructured markdown.

    Args:
        page_type:        'source-summary' | 'entity' | 'concept' | 'comparison' | 'overview'
        title:            Page title
        source_contents:  List of {source_id, title, markdown, citation_label?, is_new?}
                          dicts; is_new marks this session's sources, which go
                          first and whole (services/draft_budget.py)
        related_pages:    Optional list of {title, type, summary} for context;
                          an overview drafted without source documents
                          describes these pages
        existing_content: Existing page markdown (for updates — None for first compile)
        schema:           wiki schema.md content (None for first compile)
        earlier_sources:  {citation_label, title} of sources the existing content
                          cites that are not in source_contents

    Raises:
        LLMRateLimitedError  — bucket exhausted
        CostCeilingError     — daily $ cap exceeded
        LLMCompileError      — empty response
    """
    system_prompt = _DRAFT_PAGE_PROMPTS.get(page_type, _DRAFT_PAGE_PROMPTS["entity"])

    # Build user prompt
    parts: list[str] = [f"Title: {title}", f"Page type: {page_type}", ""]

    synthesized = page_type in _CITED_PAGE_TYPES
    if schema:
        # schema.md is written once per wiki and may predate these rules (it
        # can demand "Contradictions" sections or extra frontmatter fields).
        parts += [
            "Wiki schema (house conventions; where it conflicts with the system instructions on "
            "frontmatter keys, links, citations, disagreement sections or related lists, follow the "
            "system instructions):",
            schema,
            "",
        ]

    if existing_content:
        parts += ["Existing page content (update this, don't rewrite from scratch):",
                  existing_content, ""]
        conflict = (
            "if a new source conflicts with an existing claim, keep both, cite each and record the "
            "disagreement in the DISAGREEMENTS format. Rewrite an existing section about sources that "
            "disagree under any other heading (such as Contradictions) into that format, keeping its "
            "citations."
            if synthesized
            else "if a new source conflicts with an existing claim, keep both and cite each."
        )
        parts += [
            "UPDATING: The existing claims come from earlier sources, some not shown here. Keep them "
            f"and their labels even though you cannot check them. Add what the new sources say; {conflict} "
            "Do not attach a new label to an existing claim unless that source states it.",
            "",
        ]

    if related_pages:
        if page_type == "overview" and not source_contents:
            # An overview is drafted from the pages it lists, not from every
            # source behind them (plan 2.1).
            parts += ["Pages in this category (the material for this overview; describe each from its summary):"]
        elif page_type == "overview":
            parts += ["Related pages in the wiki (for cross-reference context):"]
        else:
            parts += ["Related pages in the wiki (for linking only; their summaries are not sources):"]
        for rp in related_pages:
            parts.append(f"  - {rp.get('title', '')} ({rp.get('type', '')}): {rp.get('summary', '')}")
        parts.append("")

    if existing_page_titles:
        titles_str = ", ".join(existing_page_titles)
        parts.append(
            f"Existing wiki pages (for [[wikilinks]]): {titles_str}\n\n"
            "LINKS: Link a page from this list where the body first mentions it, as [[Title]] or "
            "[[Title|your wording]]. Link each page once per page. Link only titles in this list, "
            "and only where the sentence is about that page's topic. Never link the title of a "
            "source document."
        )
        parts.append("")

    dossier_sent = bool(extraction_dossier.strip()) and page_type in ("entity", "concept", "comparison")
    if dossier_sent:
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
            "information not in the dossier, include it. The data was extracted "
            "automatically from those documents; where they differ, follow the document. "
            "That is an extraction slip, not a contradiction between sources.",
            "",
        ]

    # Citation labels: when the caller labels its sources (the app does for
    # every draft), multi-source pages cite claims with those labels. The app
    # turns them into stored source references after the draft returns, so
    # the page never contains raw ids.
    earlier = list(earlier_sources or [])
    cite = page_type in _CITED_PAGE_TYPES and (
        any(sc.get("citation_label") for sc in source_contents) or bool(earlier)
    )
    if cite:
        parts += [_CITATION_RULES, ""]
        dates = _source_dates_line(source_contents, earlier)
        if dates:
            parts += [dates, ""]

    # Source documents share what the budget leaves after the parts above,
    # which are never cut (services/draft_budget.py). An older source the
    # existing page cites may be left out; it is then named with the earlier
    # sources, so room for that is set aside first.
    def _earlier_note(left_out: list[dict[str, Any]]) -> list[str]:
        named = earlier + [
            {"citation_label": sc["citation_label"], "title": sc.get("title", sc.get("source_id", ""))}
            for sc in left_out
        ]
        return _earlier_sources_note(named) if cite and named else []

    cited_older = [
        sc for sc in source_contents
        if not sc.get("is_new") and sc.get("citation_label")
        and f"[{sc['citation_label']}]" in (existing_content or "")
    ]
    fixed_chars = len("\n".join(parts + _earlier_note(cited_older) + ["Source documents:", ""]))
    if fixed_chars > _GEMINI_INPUT_TOKEN_CAP:
        logger.warning(
            "draft_page '%s': the prompt without sources is %d chars, over the %d budget",
            title, fixed_chars, _GEMINI_INPUT_TOKEN_CAP,
        )
    fitted = draft_budget.fit_sources(
        source_contents,
        max(_GEMINI_INPUT_TOKEN_CAP - fixed_chars, draft_budget.MIN_SOURCE_ROOM_CHARS),
        lambda sc: len(_source_header(sc, cite)),
        f"{title}\n{existing_content or ''}",
    )
    sent_ids = {sc.get("source_id") for sc in fitted.sources}
    parts += _earlier_note([sc for sc in cited_older if sc.get("source_id") not in sent_ids])

    if fitted.sources:
        parts.append("Source documents:")
        for sc in fitted.sources:
            parts += [_source_header(sc, cite), sc.get("markdown", ""), ""]

    # Used: what went into the prompt, as text or as pre-extracted data
    # (the dossier names each source's block "From [S1] ...").
    used = set(sent_ids)
    if dossier_sent:
        used |= {
            sc.get("source_id") for sc in source_contents
            if sc.get("citation_label") and f"From [{sc['citation_label']}]" in extraction_dossier
        }
    used_source_ids = list(dict.fromkeys(
        sc["source_id"] for sc in source_contents if sc.get("source_id") in used
    ))

    # Build category suffix separately: it goes after the final check.
    # It must survive at the very end of the final prompt for Gemini recency attention.
    # Always emit CATEGORY ASSIGNMENT — even when the list is empty — so the LLM
    # always has explicit instruction to write the category field.  When cats is
    # empty (first session) the LLM names the page's main field; when cats is
    # non-empty it reuses a label only when that label names the page's main
    # field, else it creates one for that field (see _CATEGORY_RULE).
    one_field = (
        '(e.g. "Graphic Design", "Web Accessibility", "Cryptocurrency"); never join two fields with '
        '"&", "and" or "/". The category field is REQUIRED — do not leave it blank or omit it.'
    )
    cats = existing_categories or []
    if cats:
        cats_str = ", ".join(f'"{c}"' for c in cats)
        cat_suffix = (
            "\nCATEGORY ASSIGNMENT:\n"
            f"Existing wiki categories: {cats_str}\n\n"
            "Use an existing category only when it names this page's MAIN subject field, and then write it "
            "exactly as listed for the \"category\" frontmatter field: do not paraphrase or rephrase it. "
            "Sharing a word or a side topic with the page is not enough. If the main subject belongs to a "
            "different field than every existing category, create a new category for that field. "
            "A new category names one field in 1-3 words " + one_field
        )
    else:
        cat_suffix = (
            "\nCATEGORY ASSIGNMENT:\n"
            "No existing categories yet. Create the \"category\" frontmatter field: this page's main "
            "subject field in 1-3 words, one field only " + one_field
        )

    prompt = "\n".join(parts)

    # Restated after the sources (which can be long) so the rules sit close
    # to the answer; the category instruction stays last.
    prompt += _final_check(cite)
    prompt += cat_suffix

    provider = get_provider(model)
    for attempt in range(1, _DRAFT_PAGE_ATTEMPTS + 1):
        try:
            result = provider.complete(LLMRequest(
                model=model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt},
                ],
                response_model=None,
                thinking_budget=_read_thinking_budget('draft_page'),
                max_output_tokens=_DRAFT_PAGE_MAX_OUTPUT_TOKENS,
                temperature=0.3,
                step="draft_page",
                extra={"retry": False},
            ))
        except _LIMIT_ERRORS:
            raise
        except Exception as e:
            raise LLMCompileError(f"draft_page_llm_failed: {e}") from e
        if str(result.finish_reason).upper() not in _OUTPUT_CAP_FINISH:
            break
        print(f"[draft] '{title}' ran out of output room (attempt {attempt})", file=sys.stderr, flush=True)
    else:
        raise LLMCompileError(
            f"draft_page_truncated: '{title}' ran out of output room "
            f"({_DRAFT_PAGE_MAX_OUTPUT_TOKENS} tokens) {_DRAFT_PAGE_ATTEMPTS} times"
        )

    raw_text = result.text
    if not raw_text:
        raise LLMCompileError(f"draft_page_error: empty response for '{title}'")

    raw = raw_text.strip()
    # Outer fence: the whole response is wrapped in a single code fence.
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:yaml|markdown)?\n?", "", raw)
        raw = re.sub(r"\n?```$", "", raw)
    # Body-only fence: frontmatter is clean, but the body is wrapped. Unwrap it.
    raw = re.sub(
        r"(^---\n[\s\S]*?\n---\n\s*)```(?:\w+)?\n([\s\S]*?)\n```\s*$",
        r"\1\2",
        raw,
    )
    return DraftPageResult(markdown=raw.strip(), used_source_ids=used_source_ids, cuts=fitted.cuts)


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


TRIAGE_DECISIONS = ("update", "contradiction", "skip")


class TriageResponse(BaseModel):
    # No extra='forbid' — LLM output model.
    decision: str  # one of TRIAGE_DECISIONS; triage_page_update checks it
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
""" + _JSON_TRAILER


def crossref_pages(pages: list[dict[str, Any]], model: str = _DEFAULT_MODEL) -> CrossrefResponse:
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

    provider = get_provider(model)
    try:
        result = provider.complete(LLMRequest(
            model=model,
            messages=[
                {"role": "system", "content": _CROSSREF_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            response_model=CrossrefResponse,
            thinking_budget=_read_thinking_budget('crossref_pages'),
            max_output_tokens=32768,
            temperature=0.0,
            step="crossref",
        ))
    except _LIMIT_ERRORS:
        raise
    except Exception as e:
        raise LLMCompileError(f"crossref_llm_failed: {e}") from e

    raw_text = result.text
    if not raw_text:
        # Return pages unchanged on empty response rather than failing
        return CrossrefResponse(
            updated_pages=[CrossrefUpdatedPage(plan_id=p["plan_id"], markdown=p.get("markdown", "")) for p in pages],
            contradictions_found=[],
        )

    if result.parsed is not None:
        return result.parsed  # type: ignore[return-value]
    raise LLMCompileError(
        f"crossref_parse_failed: {result.parse_error}; "
        + _parse_failure_tail(
            step="crossref", expected_wrapper="updated_pages", raw_text=raw_text,
        )
    ) from result.parse_error


# ---------------------------------------------------------------------------
# Schema generation — bootstrap wiki schema.md (Part 2c-i)
# ---------------------------------------------------------------------------

_SCHEMA_SYSTEM_PROMPT = """\
You are a wiki schema generator. Based on the pages that were just created,
generate a schema document that defines how this wiki should be maintained.

The schema should cover:
1. Page types and when each should be created (source-summary, entity, concept, comparison, overview)
2. Naming conventions for page titles
3. YAML frontmatter: exactly title, page_type, category and summary (Kompl tracks sources, dates and status itself; define no other fields)
4. Cross-referencing rules (link an existing page at its first mention, once per page; never link source documents)
5. How to handle contradictions between sources (only claims that cannot both be true; different milestones are not contradictions). Kompl records each one under a "### Disputed: <topic>" heading, or "### Changed: <topic>" when a later source shows the claim changed over time; keep those two headings
6. Category structure based on the content seen so far
7. When to create a new page vs update an existing one
8. Content quality standards (factual accuracy, attribution, no hallucination)

Write the schema as a concise markdown document. It will be used as standing
instructions for the LLM on all future wiki updates.
"""


TriageEvidence = Literal["claims", "source_text"]


def triage_page_update(
    source_claims: str,
    existing_page_summary: str,
    page_title: str,
    model: str = _DEFAULT_MODEL,
    *,
    page_section: str = "",
    evidence: TriageEvidence = "source_text",
) -> dict[str, str]:
    """Decide whether a source warrants updating an existing wiki page.

    Args:
        source_claims:        With evidence='claims', the claims the source's
                              extraction makes about the page's subject, each
                              with the source's own sentence when one was kept
                              (app lib/triage-evidence.ts). With
                              evidence='source_text', the source's text.
        existing_page_summary: Current summary of the wiki page.
        page_title:           Title of the wiki page being triaged.
        page_section:         The page's section(s) most related to the
                              claims; empty for none.

    Returns dict with keys 'decision' ('update'|'contradiction'|'skip') and 'reason'.

    Raises:
        LLMRateLimitedError  — bucket exhausted
        CostCeilingError     — daily $ cap exceeded
        LLMCompileError      — empty response, JSON parse failed, or a decision
                               other than the three (case and spacing ignored)
    """
    section = (
        f"The page's section most related to these claims:\n{page_section}\n\n"
        if page_section.strip() else ''
    )
    new_information = (
        "What the new source claims about this page's subject (each claim is "
        "followed by the source's own sentence when one was kept):\n"
        if evidence == "claims"
        else 'New information from ingested source:\n'
    )
    prompt = (
        f'You are a wiki maintenance assistant deciding whether a wiki page needs updating.\n\n'
        f'Wiki page: "{page_title}"\n'
        f'Current page summary:\n{existing_page_summary}\n\n'
        f'{section}'
        f'{new_information}{source_claims}\n\n'
        f'Respond with JSON only:\n'
        f'{{\n'
        f'  "decision": "update" | "contradiction" | "skip",\n'
        f'  "reason": "brief explanation (1-2 sentences)"\n'
        f'}}\n\n'
        f'- "update": source has material new information not in the current page\n'
        f'- "contradiction": source directly contradicts a factual claim in the page; '
        f"the reason quotes the page's claim and the source's claim\n"
        f'- "skip": source is redundant or only tangentially mentions the topic'
    )

    provider = get_provider(model)
    try:
        result = provider.complete(LLMRequest(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            response_model=TriageResponse,
            thinking_budget=_read_thinking_budget('triage_page_update'),
            max_output_tokens=512,
            temperature=0.0,
            step="triage",
        ))
    except _LIMIT_ERRORS:
        raise
    except Exception as e:
        raise LLMCompileError(f"triage_llm_call_failed: {e}") from e

    raw_text = result.text
    if not raw_text:
        raise LLMCompileError("triage_error: empty response text")

    if result.parsed is None:
        raise LLMCompileError(
            f"triage_json_parse_failed: {result.parse_error}; "
            + _parse_failure_tail(
                step="triage", expected_wrapper="decision", raw_text=raw_text,
            )
        ) from result.parse_error
    triage = result.parsed

    # Any other answer is no verdict. Read as 'skip', it would record the
    # source on the page with nothing having decided that; as an error the
    # app keeps the pair for a later re-check.
    decision = triage.decision.strip().lower()
    if decision not in TRIAGE_DECISIONS:
        raise LLMCompileError(f"triage_unknown_decision: {triage.decision[:80]!r}")
    return {"decision": decision, "reason": triage.reason}


def generate_schema(pages_summary: list[dict[str, Any]], model: str = _DEFAULT_MODEL) -> str:
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

    provider = get_provider(model)
    try:
        result = provider.complete(LLMRequest(
            model=model,
            messages=[
                {"role": "system", "content": _SCHEMA_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            response_model=None,
            thinking_budget=_read_thinking_budget('generate_schema'),
            max_output_tokens=8192,
            temperature=0.0,
            step="schema",
        ))
    except _LIMIT_ERRORS:
        raise
    except Exception as e:
        raise LLMCompileError(f"generate_schema_llm_failed: {e}") from e

    raw_text = result.text
    if not raw_text:
        raise LLMCompileError("generate_schema_error: empty response")

    return raw_text.strip()


# ---------------------------------------------------------------------------
# Category labels — one consolidation call at the end of a compile
# ---------------------------------------------------------------------------
#
# Parallel drafts can each invent a label for the same category ("Crypto",
# "Cryptocurrency"). The app sends the labels this compile added and the ones
# the wiki already had, each with its page count; the model names the new
# labels that should share an existing or another new label, the smaller
# moving into the bigger. services/label_merge.py keeps only merges the app
# may apply. A Repair run sends every label as new.

_LABEL_MERGE_MAX_OUTPUT_TOKENS = 4096


class LabelMerge(BaseModel):
    # No extra='forbid' — LLM output model.
    label: str
    into: str
    reason: str


class LabelMergeResponse(BaseModel):
    # No extra='forbid' — LLM output model.
    merges: list[LabelMerge]


_LABEL_MERGE_SYSTEM_PROMPT = """\
You tidy the category labels of a personal wiki. Every page has one category
label. A compile just added the NEW labels; the wiki already had the EXISTING
labels. Each label comes as {"label": ..., "pages": ...}: its name and how
many pages use it. Find NEW labels that name the same category as another
label, so their pages can share one label.

These name the same category; merge them:
- spelling, case, plural or punctuation variants ("Startup" / "Startups")
- an abbreviation and its full form ("AI" / "Artificial Intelligence")
- a short form and its full form ("Crypto" / "Cryptocurrency")
- two names for the same thing ("Films" / "Movies")
- one part of a NEW combined label that names one field, and that combined
  label ("Web Accessibility" / "Web Accessibility & Standards"): merge the
  part into the combined label.
- a label with 1 or 2 pages whose whole name is contained in the name of a
  more-used label ("Design" (1 page) / "Graphic Design" (33 pages)): merge it
  into the most-used label that contains its name.

EXISTING labels never move. A NEW label that names the same category as an
EXISTING label (any case above) merges into the EXISTING label whatever the
pages. Between two NEW labels, always merge the one with fewer pages into
the one with more, never the reverse: "Graphic Design" (33 pages) never
moves into "Typography & Graphic Design" (6 pages). When the NEW label you
would move has more pages than the other NEW label, leave both as they are.

Never merge labels that name different categories, even closely related ones,
except in the two contained-name cases above:
- a broader and a narrower topic ("Artificial Intelligence" / "Machine Learning",
  "Cryptocurrency" / "Bitcoin")
- neighbouring fields ("Economics" / "Finance", "Design" / "Accessibility")
- a subject and the people, places or organisations around it
  ("Music" / "Musicians")
- the same word used for different things
Never move a one-field label into a combined label that joins two fields
("Accessibility" or "Design" / "Design & Accessibility"), nor into an
EXISTING combined label, even in the two contained-name cases above: leave
both as they are. Each label should name one field.
Outside the cases listed above, do not merge. Most compiles need no merge
at all.

Each merge has three fields:
- label: one of the NEW labels, written exactly as given.
- into: one of the EXISTING or NEW labels, written exactly as given;
  never a new name.
- reason: a few words on why both name the same category.
When a NEW label matches an EXISTING label, merge into the EXISTING
label. When two NEW labels match, merge the one
with fewer pages into the one with more; with equal pages, into the
clearer, more usual name. Name each NEW label at most once.

Return {"merges": []} when nothing should be merged.
""" + _JSON_TRAILER


def consolidate_labels(
    existing_labels: list[str],
    new_labels: list[str],
    model: str = _DEFAULT_MODEL,
    page_counts: dict[str, int] | None = None,
) -> LabelMergeResponse:
    """Ask which of this compile's new category labels mean the same as
    another label. No call without new labels.

    ``page_counts`` gives each label's pages, by label as sent; the model
    sees them so the smaller label moves into the bigger one.

    Returns the model's merges as given; services/label_merge.py cleans them.

    Raises:
        LLMRateLimitedError  — bucket exhausted
        CostCeilingError     — daily $ cap reached (refused before sending)
        LLMCompileError      — call failed, empty response or JSON parse failed
    """
    if not new_labels:
        return LabelMergeResponse(merges=[])

    counts = page_counts or {}

    def _with_pages(labels: list[str]) -> list[dict[str, Any]]:
        return [{"label": n, "pages": counts[n]} if n in counts else {"label": n} for n in labels]

    payload = json.dumps(
        {"existing_labels": _with_pages(existing_labels), "new_labels": _with_pages(new_labels)},
        ensure_ascii=False,
    )

    provider = get_provider(model)
    try:
        result = provider.complete(LLMRequest(
            model=model,
            messages=[
                {"role": "system", "content": _LABEL_MERGE_SYSTEM_PROMPT},
                {"role": "user", "content": payload},
            ],
            response_model=LabelMergeResponse,
            thinking_budget=_read_thinking_budget('consolidate_labels'),
            max_output_tokens=_LABEL_MERGE_MAX_OUTPUT_TOKENS,
            temperature=0.0,
            step="labels",
        ))
    except _LIMIT_ERRORS:
        raise
    except Exception as e:
        raise LLMCompileError(f"consolidate_labels_failed: {e}") from e

    raw_text = result.text
    if not raw_text:
        raise LLMCompileError("consolidate_labels_error: empty response")
    if result.parsed is None:
        raise LLMCompileError(
            f"consolidate_labels_parse_failed: {result.parse_error}; "
            + _parse_failure_tail(step="labels", expected_wrapper="merges", raw_text=raw_text)
        ) from result.parse_error
    return result.parsed  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Claim check — do two sources' claims disagree? (plan 3.3 and 3.6, D3/D5)
# ---------------------------------------------------------------------------
#
# The app pairs claims from different sources that share a subject
# (app/src/lib/claim-check/) and sends them in batches; one call judges a
# batch, each pair on its own (batch prompting: Cheng et al. 2023 report
# about the same accuracy up to ~6 items per call at a fraction of the
# calls; larger batches drift). Each pair is judged NLI-style: first whether
# both claims speak about the same thing (de Marneffe et al. 2008: a
# contradiction needs the two to be about the same event), then which
# verdict. The definitions match the draft prompt's DISAGREEMENTS rules
# (Disputed / Changed, plan 3.1). services/claim_verdicts.py settles the
# answers: unknown verdicts are dropped and "outdated" stands only when the
# sources' dates order the two claims (D5).

CLAIM_VERDICTS = ("disputed", "outdated", "scope", "opinion", "none")
# Most pairs one call judges (routers/claims.py enforces it; the app sends
# CLAIM_JUDGE_BATCH_SIZE, app/src/lib/claim-check/limits.ts).
CLAIM_JUDGE_MAX_PAIRS = 8
# About 100 tokens per answer plus thinking. DeepSeek counts its reasoning
# against this limit and at effort "low" still spent all of 4096 on one batch
# (finish=length, cut-off JSON), so the same room as disambiguate. GET
# /llm/pricing reports it for the app's whole-wiki check estimate.
_CLAIM_JUDGE_MAX_OUTPUT_TOKENS = 8192


class ClaimJudgement(BaseModel):
    # No extra='forbid' — LLM output model. reason comes before verdict so
    # the model states what each side says before it decides.
    pair_id: str
    topic: str
    reason: str
    verdict: str  # one of CLAIM_VERDICTS; services/claim_verdicts.py checks it


class ClaimJudgeResponse(BaseModel):
    # No extra='forbid' — LLM output model.
    judgements: list[ClaimJudgement]


_CLAIM_JUDGE_SYSTEM_PROMPT = """\
You check a personal wiki for sources that disagree. Each item below is a
PAIR of claims, A and B, taken from two different sources that talk about the
same subject. Each claim comes with its source's title and date and, when one
was kept, the source's own sentence. Judge every pair on its own; the pairs
are unrelated to each other.

For each pair, first decide whether both claims speak about the same thing:
the same subject, the same event or measure, the same time and the same
scope. Then choose one verdict:
- "disputed": both claims are about the same fact and cannot both be true
  ("founded in 2008" / "founded in 2009"; "is open source" / "is
  proprietary").
- "outdated": a figure, status or rule that changes over time, where the
  later-dated source reports a newer state that replaces the earlier claim
  ("supports 10 languages", 2020 / "supports 40 languages", 2024). Use it
  only when the later-dated source shows the change. When the dates are the
  same, unknown, or do not tell which claim is later, use "disputed".
- "scope": they look opposed but are about different things, so both can be
  true: different places, times, versions, groups or conditions ("free for
  students" / "costs $10 a month"), or different milestones or events of one
  thing (announced vs shipped, signed vs ratified).
- "opinion": at least one side is a judgment, prediction or recommendation
  rather than a checkable fact, and the two judgments differ.
- "none": they agree, one only adds detail, or they are not about the same
  thing at all.

Dates: "published" is the source's publication date. "saved" is the day the
source was added to the wiki, given when its publication date is unknown; the
source was published on or before that day.

For each pair return:
- pair_id: the pair's id exactly as given.
- topic: a few words naming what the two claims are about ("launch year").
- reason: one sentence. For any verdict but "none", say what each side
  claims ("A gives 2008; B gives 2009").
- verdict: one of "disputed", "outdated", "scope", "opinion", "none".
Answer every pair exactly once. Do not invent a conflict the claims do not
state; most pairs that share a subject do not disagree.
""" + _JSON_TRAILER


def _claim_source_note(side: dict[str, Any]) -> str:
    """The source's title and date as the judge reads them."""
    date, kind = side.get("date"), side.get("date_kind")
    if not date:
        note = "date unknown"
    else:
        note = f"saved {date}, publication date unknown" if kind == "saved" else f"published {date}"
    title = (side.get("source_title") or "").strip()
    return f'"{title}", {note}' if title else note


def _claim_pairs_payload(pairs: list[dict[str, Any]]) -> str:
    """The pairs as the judge reads them: one block per pair, A then B."""
    blocks: list[str] = []
    for pair in pairs:
        lines = [f"PAIR {pair['pair_id']}" + (f" (subject: {pair['subject']})" if pair.get("subject") else "")]
        for label in ("a", "b"):
            side = pair[label]
            lines.append(f"  {label.upper()} ({_claim_source_note(side)}): {side['claim']}")
            quote = side.get("quote")
            if quote and quote != side["claim"]:
                lines.append(f'     Source sentence: "{quote}"')
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def judge_claim_pairs(
    pairs: list[dict[str, Any]],
    model: str = _DEFAULT_MODEL,
) -> ClaimJudgeResponse:
    """Judge one batch of claim pairs in one call. No call without pairs.

    Args:
        pairs: {pair_id, subject, a, b} dicts; each side is {claim, quote,
               source_title, date, date_kind} (routers/claims.py ClaimPairIn).

    Returns the model's judgements as given; services/claim_verdicts.py
    settles them against the pairs sent.

    Raises:
        LLMRateLimitedError  — bucket exhausted
        CostCeilingError     — daily $ cap reached (refused before sending)
        LLMCompileError      — call failed, empty response or JSON parse failed
    """
    if not pairs:
        return ClaimJudgeResponse(judgements=[])

    provider = get_provider(model)
    try:
        result = provider.complete(LLMRequest(
            model=model,
            messages=[
                {"role": "system", "content": _CLAIM_JUDGE_SYSTEM_PROMPT},
                {"role": "user", "content": _claim_pairs_payload(pairs)},
            ],
            response_model=ClaimJudgeResponse,
            thinking_budget=_read_thinking_budget('judge_claim_pairs'),
            max_output_tokens=_CLAIM_JUDGE_MAX_OUTPUT_TOKENS,
            temperature=0.0,
            step="claims",
        ))
    except _LIMIT_ERRORS:
        raise
    except Exception as e:
        raise LLMCompileError(f"judge_claim_pairs_failed: {e}") from e

    raw_text = result.text
    if not raw_text:
        raise LLMCompileError("judge_claim_pairs_error: empty response")
    if result.parsed is None:
        raise LLMCompileError(
            f"judge_claim_pairs_parse_failed: {result.parse_error}; "
            + _parse_failure_tail(step="claims", expected_wrapper="judgements", raw_text=raw_text)
        ) from result.parse_error
    return result.parsed  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Finalize prompts with response-shape contracts
# ---------------------------------------------------------------------------
#
# This block runs at module load. It MUST be after every Pydantic response
# model is defined — the constants above end with `+ _JSON_TRAILER` and we
# tack on the model-derived contract block here so the prompts stay readable
# in their original locations. Do NOT move earlier in the file: forward refs
# to the response models would crash the import.
#
# DeepSeek's json_object mode reads only the prompt text (response_model
# schema is server-side ignored), so the wrapper-key anchor + filled-in
# example below is what actually constrains output shape. Two production
# drift variants ({"pairs":[...]}, bare list [{...}]) both came from the
# same underspecified disambiguate prompt before this block was added.

_LINT_SYSTEM_PROMPT = _LINT_SYSTEM_PROMPT + _format_response_contract(LintScanResponse)
_EXTRACTION_SYSTEM_PROMPT = _EXTRACTION_SYSTEM_PROMPT + _format_response_contract(LLMExtractionResponse)
_DISAMBIGUATION_SYSTEM_PROMPT = _DISAMBIGUATION_SYSTEM_PROMPT + _format_response_contract(DisambiguationResponse)
_DISAMBIGUATION_CONCEPT_SYSTEM_PROMPT = _DISAMBIGUATION_CONCEPT_SYSTEM_PROMPT + _format_response_contract(DisambiguationResponse)
_DISAMBIGUATION_PAGE_SYSTEM_PROMPT = _DISAMBIGUATION_PAGE_SYSTEM_PROMPT + _format_response_contract(DisambiguationResponse)
_DISAMBIGUATION_CONCEPT_PAGE_SYSTEM_PROMPT = (
    _DISAMBIGUATION_CONCEPT_PAGE_SYSTEM_PROMPT + _format_response_contract(DisambiguationResponse)
)
_CROSSREF_SYSTEM_PROMPT = _CROSSREF_SYSTEM_PROMPT + _format_response_contract(CrossrefResponse)
_LABEL_MERGE_SYSTEM_PROMPT = _LABEL_MERGE_SYSTEM_PROMPT + _format_response_contract(LabelMergeResponse)
_CLAIM_JUDGE_SYSTEM_PROMPT = _CLAIM_JUDGE_SYSTEM_PROMPT + _format_response_contract(ClaimJudgeResponse)
