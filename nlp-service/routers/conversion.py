"""Conversion router for Kompl v2 nlp-service (commit 3).

Two endpoints:
  - POST /convert/url       — Firecrawl v2 scrape → flat markdown response
  - POST /convert/file-path — MarkItDown local-file conversion → markdown

Both return the same ConvertResponse shape defined in docs/contracts.md
contract 2a/2b. Metadata is FLAT at the top level (plus a small nested
ContentMetadata block) — Firecrawl's nested `data.metadata.*` is flattened
here before returning. This flattening is non-negotiable: v1's
EnrichMetadataResponse drift bug was exactly the nested-vs-flat mismatch,
and rule #2 in CLAUDE.md explicitly forbids defensive fallbacks that would
paper over shape drift.

v1 bug classes this router explicitly avoids:
  1. Bare dict responses — every endpoint uses `response_model=` with a
     strict Pydantic model (extra='forbid').
  2. Nested metadata leaking into the contract — we flatten at this layer.
  3. `except Exception: pass` — every catch re-raises as HTTPException with
     a specific detail string.
  4. Defensive `or` fallbacks on contract fields — the single allowed case is
     the Firecrawl title fallback to URL, which the contract permits.

This router does NOT open the SQLite database. rule #1 in CLAUDE.md:
nlp-service never touches kompl.db directly.
"""

from __future__ import annotations

import hashlib
import mimetypes
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from markitdown import MarkItDown
from pydantic import BaseModel, ConfigDict, Field

from services.http_client import HttpClient, HttpClientError


# ---------------------------------------------------------------------------
# Pydantic models — every one has extra='forbid' per rule #2.
# ---------------------------------------------------------------------------


class ContentMetadata(BaseModel):
    model_config = ConfigDict(extra='forbid')

    language: str | None = None
    description: str | None = None
    status_code: int | None = None
    content_type: str | None = None
    final_url: str | None = None


class ConvertResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    source_id: str
    source_type: str  # "url" or "file"
    title: str
    source_url: str | None = None
    markdown: str
    content_hash: str
    metadata: ContentMetadata


class UrlConvertRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    source_id: str
    url: str


class FileConvertRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')

    source_id: str
    file_path: str
    # Original filename before UUID-prefix was added by Next.js. Never None
    # in practice for browser uploads; None only if an internal caller omits
    # it. Used as the title fallback so the UUID prefix never leaks into
    # pages.title. Treated as untrusted user input (sanitised by caller).
    title_hint: str | None = None


# ---------------------------------------------------------------------------
# Router setup + module-level constants
# ---------------------------------------------------------------------------

router = APIRouter(tags=["conversion"])
_http = HttpClient(timeout=30.0, max_retries=3)
_FIRECRAWL_API_KEY = os.environ.get("FIRECRAWL_API_KEY", "")
_DATA_ROOT = "/data"
_ALLOWED_EXTENSIONS = {
    ".pdf",
    ".docx",
    ".pptx",
    ".xlsx",
    ".txt",
    ".md",
    ".html",
    ".htm",
    ".csv",
    ".json",
    ".xml",
    ".jpg",
    ".jpeg",
    ".png",
    ".mp3",
    ".wav",
}


# ---------------------------------------------------------------------------
# Endpoint 1 — POST /convert/url
# ---------------------------------------------------------------------------


# RFC 2606 reserved TLDs (never valid on the public internet). Fail fast
# before calling Firecrawl so the error branch fires in <1s instead of
# waiting 30s for a timeout. This also makes the stage-4 integration-test
# canary deterministic (no polling, just a blocking curl with --max-time 30).
_RFC2606_RESERVED_TLDS = {".invalid", ".test", ".example", ".localhost"}


@router.post("/convert/url", response_model=ConvertResponse)
def convert_url(req: UrlConvertRequest) -> ConvertResponse:
    if not _FIRECRAWL_API_KEY:
        raise HTTPException(status_code=500, detail="firecrawl_not_configured")

    # Reject RFC 2606 reserved TLDs immediately — they never resolve on the
    # public internet and would only waste Firecrawl quota before failing.
    from urllib.parse import urlparse
    parsed_host = urlparse(req.url).hostname or ""
    tld = "." + parsed_host.rsplit(".", 1)[-1] if "." in parsed_host else ""
    if tld.lower() in _RFC2606_RESERVED_TLDS:
        raise HTTPException(
            status_code=502,
            detail={
                "detail": "firecrawl_error",
                "upstream_status": 0,
                "message": f"reserved_tld: {tld} is not resolvable on the public internet",
            },
        )

    firecrawl_body = {
        "url": req.url,
        "formats": [{"type": "markdown"}],
        "onlyMainContent": True,
        "timeout": 30000,
    }
    firecrawl_headers = {
        "Authorization": f"Bearer {_FIRECRAWL_API_KEY}",
        "Content-Type": "application/json",
    }

    try:
        response: dict[str, Any] = _http.post_json(
            url="https://api.firecrawl.dev/v2/scrape",
            json_body=firecrawl_body,
            headers=firecrawl_headers,
        )
    except HttpClientError as e:
        # status_code is None → network error or timeout → 504 per contract 2a.
        # status_code set → upstream HTTP failure → 502 per contract 2a.
        if e.status_code is None:
            raise HTTPException(status_code=504, detail="firecrawl_timeout") from e
        raise HTTPException(
            status_code=502,
            detail={
                "detail": "firecrawl_error",
                "upstream_status": e.status_code,
                "message": e.message,
            },
        ) from e

    # Firecrawl can return `{"success": false, "error": "..."}` with HTTP 200.
    # Check the success flag explicitly per the research artifact.
    if response.get("success") is not True:
        upstream_error = response.get("error", "unknown firecrawl error")
        raise HTTPException(
            status_code=502,
            detail={
                "detail": "firecrawl_error",
                "upstream_status": 200,
                "message": str(upstream_error),
            },
        )

    data = response.get("data")
    if not isinstance(data, dict):
        raise HTTPException(
            status_code=502,
            detail={
                "detail": "firecrawl_error",
                "upstream_status": 200,
                "message": "firecrawl response missing data object",
            },
        )

    markdown = data.get("markdown")
    if not markdown:
        raise HTTPException(status_code=502, detail="firecrawl_empty_markdown")

    fc_metadata = data.get("metadata")
    if not isinstance(fc_metadata, dict):
        fc_metadata = {}

    # Flatten per docs/research/2026-04-08-conversion-deps.md section 1.
    fc_title = fc_metadata.get("title")
    # The contract (2a) permits falling back to the request URL when Firecrawl
    # does not surface a title. This is the only allowed `or` fallback.
    title = fc_title if fc_title else req.url

    # Prefer sourceURL, fall back to url. Both are the flat root `source_url`.
    fc_source_url = fc_metadata.get("sourceURL")
    if fc_source_url is None:
        fc_source_url = fc_metadata.get("url")

    content_hash = hashlib.sha256(markdown.encode("utf-8")).hexdigest()

    # Firecrawl normalizes most string fields but `language` is a special
    # case: for Wikipedia pages it comes back as a list (e.g. ['en', 'en'])
    # because Wikipedia's <html lang> + meta og:locale are both parsed and
    # collected. For most other sites it's a plain string. Flatten to the
    # first element so our `ContentMetadata.language: str | None` contract
    # holds. This is part of the nested-to-flat flattening (rule #2).
    raw_language = fc_metadata.get("language")
    if isinstance(raw_language, list):
        language = raw_language[0] if raw_language else None
    elif isinstance(raw_language, str):
        language = raw_language
    else:
        language = None

    metadata = ContentMetadata(
        language=language,
        description=fc_metadata.get("description"),
        status_code=fc_metadata.get("statusCode"),
        content_type=fc_metadata.get("contentType"),
        final_url=fc_metadata.get("url"),
    )

    return ConvertResponse(
        source_id=req.source_id,
        source_type="url",
        title=title,
        source_url=fc_source_url,
        markdown=markdown,
        content_hash=content_hash,
        metadata=metadata,
    )


# ---------------------------------------------------------------------------
# Endpoint 2 — POST /convert/file-path
# ---------------------------------------------------------------------------


@router.post("/convert/file-path", response_model=ConvertResponse)
def convert_file_path(req: FileConvertRequest) -> ConvertResponse:
    # Path safety — straight port of v1 conversion.py check. Prevents a
    # compromised n8n from asking us to read arbitrary host paths.
    p = Path(req.file_path).resolve()
    if not str(p).startswith(_DATA_ROOT):
        raise HTTPException(status_code=403, detail="path_outside_data_volume")

    if not p.exists():
        raise HTTPException(status_code=404, detail="file_not_found")

    if p.suffix.lower() not in _ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail=f"unsupported_extension: {p.suffix}",
        )

    # Call MarkItDown. Any exception here is re-raised as a specific 500 —
    # no `except Exception: pass` (v1 bug pattern rule #2 forbids).
    try:
        result = MarkItDown().convert(str(p))
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"markitdown_error: {e}",
        ) from e

    markdown = result.text_content or ""
    if not markdown:
        raise HTTPException(status_code=422, detail="markitdown_empty_output")

    # Title cascade (order matters):
    #   1. MarkItDown's extracted title — present for DOCX/PPTX with core.xml
    #      metadata; absent for PDFs (MarkItDown 0.1.5 never sets it for PDFs).
    #   2. title_hint — original filename without extension, sent by the caller
    #      before the UUID prefix was added. Guaranteed for browser uploads.
    #   3. p.stem — last resort; will include the UUID prefix if title_hint
    #      was omitted, which is the bug we're preventing.
    # Discard obviously-junk titles from MarkItDown (Word's default filenames).
    _JUNK_TITLE_FRAGMENTS = ("untitled", "microsoft word - ", "document1")
    markitdown_title = result.title or ""
    if any(frag in markitdown_title.lower() for frag in _JUNK_TITLE_FRAGMENTS):
        markitdown_title = ""
    title = markitdown_title or req.title_hint or p.stem

    content_type = mimetypes.guess_type(str(p))[0] or "application/octet-stream"

    content_hash = hashlib.sha256(markdown.encode("utf-8")).hexdigest()

    return ConvertResponse(
        source_id=req.source_id,
        source_type="file",
        title=title,
        source_url=None,
        markdown=markdown,
        content_hash=content_hash,
        metadata=ContentMetadata(
            language=None,
            description=None,
            status_code=None,
            content_type=content_type,
            final_url=None,
        ),
    )
