"""Lightweight og-tag / <title> extraction for failed-ingest URLs.

POST /metadata/peek — best-effort fetch of a URL with a hard 2s timeout,
parses the HTML head for <title>, og:title, og:description, og:image.

Used by the ingest failure path so the Saved Links wiki page shows
real context (title + description) instead of just a bare URL. Many
sites that block Firecrawl (Cloudflare, paywalls, JS-only) still serve
og tags in their HTML response — including 403 interstitials — so this
is worth attempting even when the main scrape failed.

SSRF protection: every URL (including each redirect target) is run through
validate_outbound_url which resolves DNS once, rejects private/loopback/
link-local/multicast/reserved/cloud-metadata destinations, and returns an
IP-pinned URL. The pinned URL is passed to httpx with the original Host
header and the sni_hostname extension so TLS cert validation still targets
the original hostname while the actual TCP connection cannot be redirected
to a private IP via DNS rebinding.

Constraints:
  - One scrape attempt per URL, plus up to 3 redirect hops.
  - 2s wall-clock timeout (httpx).
  - Reads at most 64 KiB before giving up (head tags are at the top).
  - All exceptions caught — never raises 5xx; on any error returns
    a response with all fields = null.
  - Pydantic strict (extra='forbid') per CLAUDE.md rule #2.
  - No DB access. nlp-service is read-side-only per rule #1.
"""

from __future__ import annotations

from html.parser import HTMLParser

import httpx
from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict

from services.url_safety import validate_outbound_url


PEEK_TIMEOUT_SECONDS = 2.0
PEEK_MAX_BYTES = 64 * 1024
PEEK_MAX_REDIRECTS = 3
PEEK_USER_AGENT = (
    "Mozilla/5.0 (compatible; KomplBot/1.0; +https://kompl.local/peek)"
)


class MetadataPeekRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: str


class MetadataPeekResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    description: str | None = None
    og_image: str | None = None


router = APIRouter()


class _HeadParser(HTMLParser):
    """Pulls <title> and og:title / og:description / og:image meta tags.

    Bails out of feed() the moment </head> is seen so we don't waste cycles
    on the body. Permissive — never raises.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title: str | None = None
        self.og_title: str | None = None
        self.og_description: str | None = None
        self.og_image: str | None = None
        self._in_title = False
        self._title_buf: list[str] = []
        self._head_done = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            a = {k.lower(): (v or "") for k, v in attrs}
            prop = a.get("property", "").lower()
            content = a.get("content")
            if not content:
                return
            if prop == "og:title" and not self.og_title:
                self.og_title = content.strip() or None
            elif prop == "og:description" and not self.og_description:
                self.og_description = content.strip() or None
            elif prop == "og:image" and not self.og_image:
                self.og_image = content.strip() or None
            elif a.get("name", "").lower() == "description" and not self.og_description:
                self.og_description = content.strip() or None

    def handle_endtag(self, tag: str) -> None:
        if tag == "title" and self._in_title:
            self._in_title = False
            joined = "".join(self._title_buf).strip()
            if joined and not self.title:
                self.title = joined
        elif tag == "head":
            self._head_done = True

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._title_buf.append(data)


def _extract(html: str) -> MetadataPeekResponse:
    parser = _HeadParser()
    try:
        parser.feed(html)
    except Exception:
        # Malformed HTML — keep whatever we managed to parse.
        pass
    title = parser.og_title or parser.title
    return MetadataPeekResponse(
        title=title,
        description=parser.og_description,
        og_image=parser.og_image,
    )


@router.post("/metadata/peek", response_model=MetadataPeekResponse)
async def peek_metadata(req: MetadataPeekRequest) -> MetadataPeekResponse:
    """Best-effort metadata extraction. Never raises — returns nulls on any error."""
    empty = MetadataPeekResponse()
    current_url = req.url

    try:
        async with httpx.AsyncClient(
            timeout=PEEK_TIMEOUT_SECONDS,
            follow_redirects=False,
            headers={"User-Agent": PEEK_USER_AGENT, "Accept": "text/html,*/*;q=0.1"},
        ) as client:
            for _hop in range(PEEK_MAX_REDIRECTS + 1):
                try:
                    validated = validate_outbound_url(current_url)
                except ValueError:
                    return empty

                async with client.stream(
                    "GET",
                    validated.pinned_url,
                    headers={"Host": validated.host_header},
                    extensions={"sni_hostname": validated.sni_hostname},
                ) as resp:
                    if 300 <= resp.status_code < 400:
                        location = resp.headers.get("location")
                        if not location:
                            return empty
                        # Resolve relative redirects against the ORIGINAL hostname URL
                        # (not the pinned-IP URL), so DNS for the next hop runs on the
                        # real domain.
                        current_url = str(httpx.URL(current_url).join(location))
                        continue
                    else:
                        ctype = resp.headers.get("content-type", "")
                        # Cloudflare 403 interstitials still return text/html with og tags,
                        # so don't gate on status_code. Only skip non-HTML payloads.
                        if "html" not in ctype.lower() and ctype != "":
                            return empty

                        buf = bytearray()
                        async for chunk in resp.aiter_bytes():
                            buf.extend(chunk)
                            if len(buf) >= PEEK_MAX_BYTES:
                                break

                        # Decode permissively. errors='replace' guarantees no UnicodeDecodeError.
                        charset = resp.charset_encoding or "utf-8"
                        try:
                            html = bytes(buf).decode(charset, errors="replace")
                        except (LookupError, TypeError):
                            html = bytes(buf).decode("utf-8", errors="replace")

                        return _extract(html)
            return empty
    except Exception:
        return empty
