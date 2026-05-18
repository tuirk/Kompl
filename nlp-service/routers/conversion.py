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

from services._safe_paths import safe_join
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
# Results below this threshold indicate a JS-rendered SPA or paywall — Firecrawl
# is used as a fallback in those cases. YouTube URLs no longer reach MarkItDown
# (see _convert_youtube).
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

# Junk-title fragments — case-insensitive substring match. Module-level so the
# body-heading extractor and the existing MarkItDown title filter share one
# source of truth.
_JUNK_TITLE_FRAGMENTS: tuple[str, ...] = ("untitled", "microsoft word - ", "document1")

# Body-heading title extraction (file-upload titles for filename-junk cases:
# arxiv IDs, scan_*, IMG_*, Document1.docx, etc.).
_BODY_TITLE_SCAN_CAP = 4096
_H1_RE = re.compile(r"^#\s+(.+?)\s*$")
_H2_RE = re.compile(r"^##\s+(.+?)\s*$")
_FENCE_RE = re.compile(r"^\s*```")
# Anchored on the full stripped line: "Abstract Algebra" must NOT match, but
# "Abstract" alone must. Numbered prefixes ("1. Introduction") match too.
_SECTION_LABEL_RE = re.compile(
    r"^(abstract|introduction|contents|table of contents|references|"
    r"bibliography|acknowledgements|appendix|index|chapter \d+|"
    r"section \d+|\d+\.?\s*introduction|\d+\.?\s*abstract|"
    r"conclusion|conclusions|summary|preface|foreword)$",
    re.IGNORECASE,
)


def _extract_title_from_markdown_body(markdown: str) -> str | None:
    """Pick the first usable H1/H2 from the start of a markdown document.

    Used as the file-upload title cascade step between MarkItDown's extracted
    title and the filename fallback. Operates on the first 4 KB only (latency
    + safety cap) and skips fenced code blocks to avoid picking
    ``# heading-inside-code`` as the title.

    Invariant: on candidate reject, CONTINUES scanning at the SAME heading
    level. ``# Abstract`` followed by ``# Real Title`` returns ``Real Title``,
    not ``None``. (This is the subtle bug the original cascade design
    introduced when it short-circuited from H1-reject straight to H2-only.)

    Returns None when no heading passes validation; the caller's cascade then
    falls through to the filename hint.
    """
    head = markdown[:_BODY_TITLE_SCAN_CAP]
    h1_candidates: list[str] = []
    h2_candidates: list[str] = []
    in_fence = False
    for line in head.splitlines():
        if _FENCE_RE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        m = _H1_RE.match(line)
        if m:
            h1_candidates.append(m.group(1))
            continue
        m = _H2_RE.match(line)
        if m:
            h2_candidates.append(m.group(1))

    for cand in h1_candidates:
        if _is_valid_body_title(cand):
            return cand.strip()
    for cand in h2_candidates:
        if _is_valid_body_title(cand):
            return cand.strip()
    return None


def _is_valid_body_title(candidate: str) -> bool:
    stripped = candidate.strip()
    if len(stripped) < 3 or len(stripped) > 200:
        return False
    lowered = stripped.lower()
    if any(frag in lowered for frag in _JUNK_TITLE_FRAGMENTS):
        return False
    if _SECTION_LABEL_RE.match(stripped):
        return False
    return True


# ---------------------------------------------------------------------------
# Endpoint 1 — POST /convert/url
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# GitHub repo enrichment
# ---------------------------------------------------------------------------

_GITHUB_REPO_RE = re.compile(
    r"^https?://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$"
)
# YouTube URL coverage: watch, youtu.be short, shorts, embed, /v/, mobile (m.),
# music (music.). Anything matching this regex is routed exclusively through the
# direct transcript-api + Data API v3 path in `_convert_youtube` — MarkItDown
# and Firecrawl are never invoked for these URLs. See `_convert_youtube` for the
# rationale (MarkItDown's HTML fallback returns YouTube footer chrome when no
# transcript exists, which passes our quality gate and produces a useless wiki
# page — see session 4a00f339-... investigation).
_YOUTUBE_URL_RE = re.compile(
    r"^https?://"
    r"(?:www\.|m\.|music\.)?"
    r"(?:youtube\.com/(?:watch|shorts/|embed/|v/)|youtu\.be/)"
)
_YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "")
_YOUTUBE_DATA_API_URL = "https://www.googleapis.com/youtube/v3/videos"
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


# ---------------------------------------------------------------------------
# YouTube direct-ingest helpers
#
# Why this exists: MarkItDown's YouTubeConverter calls youtube-transcript-api
# first, then SILENTLY falls back to scraping the watch-page HTML when no
# transcript is available. The HTML fallback returns ~800 chars of YouTube
# footer chrome (links, copyright), which passes the 500-char quality gate in
# `_try_markitdown_url` and ends up compiled as a useless wiki page. There is
# no way to inspect, from outside MarkItDown.convert(), whether the result
# came from the transcript path or the HTML-scrape fallback.
#
# Fix: route ALL YouTube URLs through this dedicated path before MarkItDown
# is considered. Transcript or 422 — never an HTML scrape.
# ---------------------------------------------------------------------------


_YOUTUBE_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_YOUTUBE_HOSTS = frozenset({
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
    "www.youtu.be",
})


def _extract_youtube_video_id(url: str) -> str | None:
    """Extract the 11-char YouTube video ID from any of the supported URL forms.

    Returns None if the host isn't a YouTube domain, the URL doesn't parse to
    a recognisable video form (playlist / channel / @-handle etc), or the
    extracted ID isn't 11 chars matching [A-Za-z0-9_-]. The 11-char check
    rejects garbage early so transcript / Data API calls always see a real ID.

    Host allowlist keeps this safe to call as a standalone unit (defence in
    depth — the route-level _YOUTUBE_URL_RE already filters incoming URLs,
    but a function that says "extract YouTube ID" must not return an ID for
    `example.com/watch?v=...`).
    """
    from urllib.parse import urlparse, parse_qs

    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host not in _YOUTUBE_HOSTS:
        return None
    path = parsed.path or ""

    # youtu.be short form: video ID is the entire path component.
    if host == "youtu.be" or host == "www.youtu.be":
        vid = path.lstrip("/").split("/", 1)[0]
    # youtube.com/watch?v=... — video ID is in the `v` query param.
    elif path == "/watch":
        vs = parse_qs(parsed.query).get("v") or []
        vid = vs[0] if vs else ""
    # /shorts/<id>, /embed/<id>, /v/<id> — video ID is the path segment after the prefix.
    elif path.startswith("/shorts/") or path.startswith("/embed/") or path.startswith("/v/"):
        vid = path.split("/", 2)[2].split("/", 1)[0]
    else:
        return None

    return vid if _YOUTUBE_VIDEO_ID_RE.match(vid) else None


def _fetch_youtube_transcript(video_id: str) -> tuple[list[dict[str, Any]], str | None]:
    """Fetch the best available transcript for `video_id`.

    Prefers manually-uploaded transcripts over auto-generated. Returns
    (segments, language_code). Raises HTTPException(422 youtube_no_transcript)
    when no transcript is available, the video doesn't exist, or YouTube
    blocks the request (cloud-IP block — see plan "Out of scope" for the
    Webshare proxy follow-up).

    Imported lazily so a missing youtube-transcript-api install only breaks
    YouTube ingestion, not the whole nlp-service. The dep is pinned in
    requirements.txt; this is belt-and-braces against a future trim.
    """
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        from youtube_transcript_api._errors import (
            TranscriptsDisabled,
            NoTranscriptFound,
            VideoUnavailable,
            CouldNotRetrieveTranscript,
        )
    except ImportError as e:
        # Misconfiguration — surface clearly rather than silent-falling-through.
        raise HTTPException(
            status_code=500,
            detail=f"youtube_transcript_api_not_installed: {e}",
        ) from e

    try:
        tlist = YouTubeTranscriptApi.list_transcripts(video_id)
        # Prefer human-uploaded over auto-generated. Pick the first available
        # in either bucket; downstream extract is language-agnostic and the
        # session is anchored to a single source so we don't need to enforce
        # a target language here.
        chosen = None
        for t in tlist:
            if not t.is_generated:
                chosen = t
                break
        if chosen is None:
            chosen = next(iter(tlist), None)
        if chosen is None:
            raise NoTranscriptFound(video_id, [], None)
        segments = chosen.fetch()
        return segments, getattr(chosen, "language_code", None)
    except (TranscriptsDisabled, NoTranscriptFound, VideoUnavailable, CouldNotRetrieveTranscript) as e:
        # Package's own "no transcript" classes — clean signal.
        raise HTTPException(
            status_code=422,
            detail="youtube_no_transcript",
        ) from e
    except Exception as e:
        # Wider net: youtube-transcript-api leaks bare xml.etree.ElementTree.
        # ParseError (and similar) when YouTube returns an empty body for the
        # transcript XML fetch — e.g. rate-limit, bot-detection, or the IP
        # being on YouTube's blocklist. From the user's perspective this is
        # still "transcript unavailable", so route to Saved Links rather than
        # bubbling a 500. See session-smoke test on `youtu.be/Ub3GoFaUcds` —
        # list_transcripts succeeded, fetch() returned empty XML body.
        raise HTTPException(
            status_code=422,
            detail="youtube_no_transcript",
        ) from e


def _fetch_youtube_metadata(video_id: str) -> dict[str, Any]:
    """Fetch video metadata (title, channel, publishedAt, description, duration)
    from YouTube Data API v3 videos.list.

    Strict: no API key → 422. API error → 422. No matching item → 422.
    The 422 routes the URL to Saved Links via the existing onFailure path
    in app/src/lib/compile/steps/ingest-urls.ts.

    No oEmbed fallback — explicit user direction. Either Data API answers,
    or the URL fails the ingest contract.
    """
    if not _YOUTUBE_API_KEY:
        raise HTTPException(
            status_code=422,
            detail="youtube_metadata_unavailable",
        )

    try:
        response = _http.get_json(
            url=_YOUTUBE_DATA_API_URL,
            params={
                "part": "snippet,contentDetails",
                "id": video_id,
                "key": _YOUTUBE_API_KEY,
            },
        )
    except HttpClientError as e:
        raise HTTPException(
            status_code=422,
            detail="youtube_metadata_unavailable",
        ) from e

    items = response.get("items") or []
    if not items:
        # Empty items = video doesn't exist, is private, or was deleted.
        # Same outcome as a 4xx from the user's perspective.
        raise HTTPException(
            status_code=422,
            detail="youtube_metadata_unavailable",
        )

    item = items[0]
    snippet = item.get("snippet") or {}
    content_details = item.get("contentDetails") or {}
    return {
        "title": snippet.get("title") or "",
        "channel": snippet.get("channelTitle") or "",
        "published_at": snippet.get("publishedAt"),
        "description": snippet.get("description"),
        "duration": content_details.get("duration"),
        "language": snippet.get("defaultLanguage") or snippet.get("defaultAudioLanguage"),
    }


def _convert_youtube(source_id: str, url: str) -> "ConvertResponse":
    """Convert a YouTube URL via youtube-transcript-api + Data API v3 only.

    Raises HTTPException(422) when either the transcript or metadata fetch
    fails. NEVER falls through to MarkItDown or Firecrawl.

    Markdown layout: title heading, then channel / published / duration /
    description meta lines, then a `## Transcript` section with all transcript
    segments joined as prose (whitespace-collapsed). Caller stores this in
    sources.markdown and surfaces metadata.title as sources.title (which
    becomes the wiki page title — no post-ingest backfill exists for URL
    sources, so the title must be right from here).
    """
    video_id = _extract_youtube_video_id(url)
    if video_id is None:
        # Regex matched but ID extraction failed — playlist URLs, channel
        # pages, etc. Treat as no-transcript so the URL goes to Saved Links.
        raise HTTPException(
            status_code=422,
            detail="youtube_no_transcript",
        )

    segments, transcript_lang = _fetch_youtube_transcript(video_id)
    meta = _fetch_youtube_metadata(video_id)

    md_parts: list[str] = [f"# {meta['title']}", ""]
    if meta["channel"]:
        md_parts.append(f"**Channel:** {meta['channel']}")
    if meta["published_at"]:
        md_parts.append(f"**Published:** {meta['published_at']}")
    if meta["duration"]:
        md_parts.append(f"**Duration:** {meta['duration']}")
    md_parts.append("")
    if meta["description"]:
        md_parts.extend([f"**Description:** {meta['description'].strip()}", ""])
    md_parts.extend(["## Transcript", ""])
    transcript_text = " ".join(
        seg["text"].strip() for seg in segments if isinstance(seg, dict) and seg.get("text")
    )
    md_parts.append(transcript_text)
    markdown = "\n".join(md_parts)

    content_hash = hashlib.sha256(markdown.encode("utf-8")).hexdigest()

    return ConvertResponse(
        source_id=source_id,
        source_type="url",
        title=meta["title"],
        source_url=url,
        markdown=markdown,
        content_hash=content_hash,
        metadata=ContentMetadata(
            language=meta["language"] or transcript_lang,
            description=meta["description"],
            status_code=None,
            content_type="text/html",
            final_url=url,
        ),
    )


def _try_markitdown_url(source_id: str, url: str) -> "ConvertResponse | None":
    """
    Attempt to convert a URL via MarkItDown (free, local).

    Returns a ConvertResponse if the result meets the quality threshold
    (_MARKITDOWN_MIN_CHARS). Returns None if the output is empty, too short,
    or the attempt exceeded _MARKITDOWN_URL_TIMEOUT_SECS — in all those cases
    the caller falls back to Firecrawl.

    Never raises — all exceptions (including timeout) become None.
    YouTube URLs are intercepted upstream by _convert_youtube (transcript-api +
    Data API v3) and never reach this function.
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

    # YouTube pre-check: route all YouTube URLs through transcript-api + Data
    # API v3, never MarkItDown or Firecrawl. _convert_youtube raises 422 on
    # missing transcript or missing/invalid metadata — the URL flows to Saved
    # Links via the app-side onFailure handler. See _convert_youtube docstring
    # for the rationale (MarkItDown's HTML fallback returns YouTube footer chrome
    # for transcript-less videos, which silently passes our quality gate).
    if _YOUTUBE_URL_RE.match(req.url):
        return _convert_youtube(req.source_id, req.url)

    # Layer 1: MarkItDown (free, local). YouTube URLs are handled above and
    # never reach this layer.
    markitdown_result = _try_markitdown_url(req.source_id, req.url)
    if markitdown_result is not None:
        return markitdown_result

    # Layer 2: Firecrawl fallback (paid). Reached only when MarkItDown returned
    # insufficient content — JS-rendered SPAs, paywalled pages.
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
    # safe_join enforces "must be inside /data" via Path.relative_to() — the
    # canonical CodeQL-recognised sanitiser pattern, replacing the older inline
    # is_relative_to() check (functionally equivalent, statically opaque).
    try:
        p = safe_join(_DATA_ROOT, req.file_path)
    except ValueError as e:
        raise HTTPException(status_code=403, detail="path_outside_data_volume") from e

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
    #   1.   MarkItDown's extracted title — present for DOCX/PPTX with core.xml
    #        metadata; absent for PDFs (MarkItDown 0.1.5 never sets it for PDFs).
    #   1.5. Body-extracted heading — first usable H1 (then H2) in the first
    #        4 KB of converted markdown. Fixes the dominant file-upload bug:
    #        PDFs of academic papers, reports, etc. have a real title as the
    #        first heading but a junk filename (arxiv IDs, scan_*, IMG_*,
    #        Document1.docx). See _extract_title_from_markdown_body docstring
    #        for the reject rules.
    #   2.   title_hint — original filename without extension, sent by the
    #        caller before the UUID prefix was added. Guaranteed for browser
    #        uploads.
    #   3.   p.stem — last resort; will include the UUID prefix if title_hint
    #        was omitted, which is the bug we're preventing.
    # Discard obviously-junk titles from MarkItDown (Word's default filenames).
    markitdown_title = result.title or ""
    if any(frag in markitdown_title.lower() for frag in _JUNK_TITLE_FRAGMENTS):
        markitdown_title = ""
    body_title = _extract_title_from_markdown_body(markdown)
    title = markitdown_title or body_title or req.title_hint or p.stem

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
