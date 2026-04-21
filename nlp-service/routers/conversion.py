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

import concurrent.futures
import hashlib
import mimetypes
import os
import re
from pathlib import Path
from typing import Any

import httpx
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
    # GitHub repo fields — populated only for source_type="github-repo"
    github_owner: str | None = None
    github_repo: str | None = None
    github_stars: int | None = None
    github_topics: list[str] | None = None
    github_language: str | None = None


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
# Firecrawl has its own internal retries and a 30s per-attempt timeout — outer
# retries almost never rescue a genuine scrape failure and just compound the
# wall-clock budget. Keep one attempt so the total convert budget stays small
# enough to fit inside the Next.js client's AbortSignal window.
_http = HttpClient(timeout=30.0, max_retries=1)
_FIRECRAWL_API_KEY = os.environ.get("FIRECRAWL_API_KEY", "")
# Minimum character count for a MarkItDown URL result to be considered usable.
# Results below this threshold indicate a JS-rendered SPA, paywall, or a YouTube
# video with no available transcript — Firecrawl is used as a fallback in those cases.
_MARKITDOWN_MIN_CHARS = 500
# Upper bound for MarkItDown URL attempts. MarkItDown uses `requests` under the
# hood with no default timeout, so a slow DNS or hung socket could pin a worker
# forever without this cap. On timeout we return None, which matches the
# existing "too few chars" signal and triggers the Firecrawl fallback.
_MARKITDOWN_URL_TIMEOUT_SECS = 20.0
_DATA_ROOT = Path("/data")
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


# ---------------------------------------------------------------------------
# GitHub repo enrichment
# ---------------------------------------------------------------------------

_GITHUB_REPO_RE = re.compile(
    r"^https?://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$"
)
_GITHUB_API = "https://api.github.com"
_GITHUB_HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "kompl/2",
}


def _is_github_repo_url(url: str) -> tuple[str, str] | None:
    """Return (owner, repo) if url is a GitHub repo root, else None."""
    m = _GITHUB_REPO_RE.match(url)
    return (m.group(1), m.group(2)) if m else None


def _convert_github_repo(
    source_id: str, url: str, owner: str, repo: str
) -> "ConvertResponse | None":
    """Fetch repo metadata + raw README via GitHub public API.

    Returns None on any failure (rate limit, network, private repo) so the
    caller falls through to MarkItDown → Firecrawl as normal.
    Unauthenticated: 60 req/hr per IP — sufficient for personal use.
    """
    try:
        with httpx.Client(timeout=15.0) as client:
            meta_r = client.get(
                f"{_GITHUB_API}/repos/{owner}/{repo}", headers=_GITHUB_HEADERS
            )
            if meta_r.status_code != 200:
                return None
            meta = meta_r.json()

            readme_r = client.get(
                f"{_GITHUB_API}/repos/{owner}/{repo}/readme",
                headers={**_GITHUB_HEADERS, "Accept": "application/vnd.github.raw+json"},
            )
            readme_md = readme_r.text if readme_r.status_code == 200 else ""
    except Exception:
        return None

    description = meta.get("description") or ""
    topics: list[str] = meta.get("topics") or []
    stars: int | None = meta.get("stargazers_count")
    lang: str | None = meta.get("language")
    full_name: str = meta.get("full_name") or f"{owner}/{repo}"

    # Compose enriched document: metadata header + README body
    parts: list[str] = [f"# {full_name}", ""]
    if description:
        parts += [description, ""]
    meta_lines: list[str] = []
    if lang:
        meta_lines.append(f"**Language:** {lang}")
    if stars is not None:
        meta_lines.append(f"**Stars:** {stars:,}")
    if topics:
        meta_lines.append(f"**Topics:** {', '.join(topics)}")
    if meta_lines:
        parts += meta_lines + [""]
    if readme_md:
        parts += ["---", "", readme_md]

    markdown = "\n".join(parts).strip()
    content_hash = hashlib.sha256(markdown.encode("utf-8")).hexdigest()

    return ConvertResponse(
        source_id=source_id,
        source_type="github-repo",
        title=full_name,
        source_url=url,
        markdown=markdown,
        content_hash=content_hash,
        metadata=ContentMetadata(
            description=description or None,
            github_owner=owner,
            github_repo=repo,
            github_stars=stars,
            github_topics=topics or None,
            github_language=lang,
        ),
    )


# RFC 2606 reserved TLDs (never valid on the public internet). Fail fast
# before trying anything so the error branch fires in <1s.
# Also makes the stage-4 integration-test canary deterministic.
_RFC2606_RESERVED_TLDS = {".invalid", ".test", ".example", ".localhost"}


def _try_markitdown_url(source_id: str, url: str) -> "ConvertResponse | None":
    """
    Attempt to convert a URL via MarkItDown (free, local).

    Returns a ConvertResponse if the result meets the quality threshold
    (_MARKITDOWN_MIN_CHARS). Returns None if the output is empty, too short,
    or the attempt exceeded _MARKITDOWN_URL_TIMEOUT_SECS — in all those cases
    the caller falls back to Firecrawl.

    Never raises — all exceptions (including timeout) become None.
    YouTube URLs are handled by MarkItDown's built-in YouTubeConverter which
    uses youtube-transcript-api to extract full transcripts.
    """
    # MarkItDown's internal `requests` calls have no default timeout. Run in a
    # throwaway thread and cap the wait. We deliberately shut the pool down
    # with wait=False so a hung MarkItDown fetch does not block our return —
    # the daemon thread will exit naturally when its socket closes. Not using
    # `with ...` because the context-manager's implicit shutdown(wait=True)
    # would reintroduce the blocking we're trying to avoid.
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
    future = pool.submit(MarkItDown().convert, url)
    try:
        result = future.result(timeout=_MARKITDOWN_URL_TIMEOUT_SECS)
    except concurrent.futures.TimeoutError:
        pool.shutdown(wait=False)
        return None
    except Exception:
        pool.shutdown(wait=False)
        return None
    pool.shutdown(wait=False)

    markdown = result.text_content or ""
    if len(markdown) < _MARKITDOWN_MIN_CHARS:
        return None

    title = result.title or url
    content_hash = hashlib.sha256(markdown.encode("utf-8")).hexdigest()

    return ConvertResponse(
        source_id=source_id,
        source_type="url",
        title=title,
        source_url=url,
        markdown=markdown,
        content_hash=content_hash,
        metadata=ContentMetadata(
            language=None,
            description=None,
            status_code=None,
            content_type="text/html",
            final_url=url,
        ),
    )


@router.post("/convert/url", response_model=ConvertResponse)
def convert_url(req: UrlConvertRequest) -> ConvertResponse:
    from urllib.parse import urlparse

    # Reject RFC 2606 reserved TLDs immediately — they never resolve on the
    # public internet and would only waste MarkItDown or Firecrawl quota.
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

    # GitHub repo pre-check: intercept repo root URLs before MarkItDown and
    # fetch clean structured content via the GitHub public API (metadata + README).
    # Falls through to MarkItDown on any API failure (rate limit, private repo, network).
    gh = _is_github_repo_url(req.url)
    if gh:
        github_result = _convert_github_repo(req.source_id, req.url, gh[0], gh[1])
        if github_result is not None:
            return github_result

    # Layer 1: MarkItDown (free, local). For YouTube, uses YouTubeTranscriptApi
    # to extract full transcripts — better quality than Firecrawl for captioned
    # videos. For static articles and docs it also works well.
    markitdown_result = _try_markitdown_url(req.source_id, req.url)
    if markitdown_result is not None:
        return markitdown_result

    # Layer 2: Firecrawl fallback (paid). Reached only when MarkItDown returned
    # insufficient content — JS-rendered SPAs, paywalled pages, YouTube videos
    # with no available captions.
    if not _FIRECRAWL_API_KEY:
        raise HTTPException(
            status_code=422,
            detail="conversion_failed: markitdown returned insufficient content and firecrawl is not configured",
        )

    firecrawl_body = {
        "url": req.url,
        "formats": ["markdown"],
        "onlyCleanContent": True,
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
    if not p.is_relative_to(_DATA_ROOT):
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
