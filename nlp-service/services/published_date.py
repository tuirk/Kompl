"""A source's publication date from its own metadata (plan 3.2, D5).

Disagreements between sources are told apart from outdated claims by the
sources' publication dates, so conversion reports one when the source's
metadata names it. Only metadata is read here; the app falls back to a date
written in the text, then to the day the source was added
(app/src/lib/source-dates.ts), and records which one it used.

  page_published  JSON-LD datePublished / dateCreated / uploadDate, then a
                  publication meta tag (article:published_time, citation_
                  publication_date, Dublin Core, ...), then a <time pubdate>
  page_modified   only a modification date was found (dateModified,
                  article:modified_time, ...)
  file_metadata   a PDF's CreationDate, an Office file's dcterms:created

Dates are returned as YYYY-MM-DD, the calendar date as written (no time
zone shift), and only when plausible: from 1900 up to tomorrow (UTC).

This module NEVER opens kompl.db. rule #1 in CLAUDE.md.
"""

from __future__ import annotations

import json
import re
import zipfile
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable, Literal

DateOrigin = Literal["page_published", "page_modified", "file_metadata"]

# HTML read for metadata; JSON-LD and meta tags sit near the top.
_HTML_MAX_CHARS = 2_000_000

# Meta keys, lowercased with everything but letters and digits removed, so
# "article:published_time", "DC.date.issued" and Firecrawl's camelCase
# "publishedTime" all compare alike. In order of preference.
_PUBLISHED_KEYS = (
    "articlepublishedtime", "ogarticlepublishedtime", "ogpublishedtime", "publishedtime",
    "citationpublicationdate", "citationdate", "citationonlinedate", "prismpublicationdate",
    "dctermsissued", "dcdateissued", "dctermscreated", "dcdatecreated", "dctermsdate", "dcdate",
    "datepublished", "publishdate", "publisheddate", "pubdate", "articlepublished",
    "sailthrudate", "parselypubdate", "releasedate", "date",
)
_MODIFIED_KEYS = (
    "articlemodifiedtime", "ogupdatedtime", "modifiedtime", "updatedtime", "datemodified",
    "dctermsmodified", "dcdatemodified", "lastmodified",
)
_JSONLD_PUBLISHED = ("datePublished", "dateCreated", "uploadDate")
_JSONLD_MODIFIED = ("dateModified",)

_MONTHS = {m: i for i, m in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), start=1)}
# ISO 8601, and Google Scholar's citation_publication_date "2019/05/01".
_ISO = re.compile(r"^\s*(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:$|[T\s])")
_COMPACT = re.compile(r"^\s*(?:D:)?(\d{4})(\d{2})(\d{2})")  # PDF "D:20230115103000+01'00'"
_MONTH_FIRST = re.compile(r"^\s*([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b")
_DAY_FIRST = re.compile(r"^\s*(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b")


@dataclass(frozen=True)
class PublishedDate:
    date: str  # YYYY-MM-DD
    origin: DateOrigin


def _plausible(y: int, m: int, d: int) -> str | None:
    try:
        day = date(y, m, d)
    except ValueError:
        return None
    if day.year < 1900 or day > datetime.now(timezone.utc).date() + timedelta(days=1):
        return None
    return day.isoformat()


def normalise_date(value: Any) -> str | None:
    """YYYY-MM-DD for a date as metadata writes it, else None."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    m = _ISO.match(text)
    if m:
        return _plausible(int(m.group(1)), int(m.group(3)), int(m.group(4)))
    m = _COMPACT.match(text)
    if m:
        return _plausible(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = _MONTH_FIRST.match(text)
    if m and m.group(1)[:3].lower() in _MONTHS:
        return _plausible(int(m.group(3)), _MONTHS[m.group(1)[:3].lower()], int(m.group(2)))
    m = _DAY_FIRST.match(text)
    if m and m.group(2)[:3].lower() in _MONTHS:
        return _plausible(int(m.group(3)), _MONTHS[m.group(2)[:3].lower()], int(m.group(1)))
    try:  # RFC 2822, as in HTTP headers: "Tue, 05 Mar 2024 10:00:00 GMT"
        parsed = parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError):
        return None
    return _plausible(parsed.year, parsed.month, parsed.day) if parsed else None


def _key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def _first_text(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return next((v for v in value if isinstance(v, str)), None)
    return None


def _from_pairs(pairs: Iterable[tuple[str, Any]]) -> PublishedDate | None:
    """The best date among (meta name, value) pairs."""
    found: dict[str, str] = {}
    for name, value in pairs:
        day = normalise_date(_first_text(value))
        if day:
            found.setdefault(_key(name), day)
    for keys, origin in ((_PUBLISHED_KEYS, "page_published"), (_MODIFIED_KEYS, "page_modified")):
        for key in keys:
            if key in found:
                return PublishedDate(found[key], origin)  # type: ignore[arg-type]
    return None


def from_meta_map(meta: dict[str, Any]) -> PublishedDate | None:
    """From a flat map of meta tags, such as Firecrawl's `data.metadata`."""
    return _from_pairs(meta.items())


def _jsonld_dates(node: Any, keys: tuple[str, ...]) -> Iterable[str]:
    if isinstance(node, list):
        for item in node:
            yield from _jsonld_dates(item, keys)
    elif isinstance(node, dict):
        for key in keys:
            value = _first_text(node.get(key))
            if value:
                yield value
        for child in node.values():
            if isinstance(child, (dict, list)):
                yield from _jsonld_dates(child, keys)


class _MetaReader(HTMLParser):
    """Collects meta tags, JSON-LD blocks and <time pubdate> values."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: list[tuple[str, str]] = []
        self.jsonld: list[str] = []
        self.times: list[str] = []
        self._script: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            name = a.get("property") or a.get("name") or a.get("itemprop") or a.get("http-equiv")
            if name and a.get("content"):
                self.meta.append((name, a["content"]))
        elif tag == "script" and a.get("type", "").lower().startswith("application/ld+json"):
            self._script = []
        elif a.get("itemprop", "").lower() == "datepublished" and (a.get("datetime") or a.get("content")):
            self.times.append(a.get("datetime") or a["content"])
        elif tag == "time" and "pubdate" in a and a.get("datetime"):
            self.times.append(a["datetime"])

    def handle_data(self, data: str) -> None:
        if self._script is not None:
            self._script.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._script is not None:
            self.jsonld.append("".join(self._script))
            self._script = None


def from_html(html: str) -> PublishedDate | None:
    """From a page's HTML: JSON-LD, then meta tags, then <time pubdate>;
    a modification date only when no publication date is found."""
    reader = _MetaReader()
    try:
        reader.feed(html[:_HTML_MAX_CHARS])
        reader.close()
    except Exception:  # noqa: BLE001 - malformed HTML: use what was read
        pass
    blocks = []
    for raw in reader.jsonld:
        try:
            blocks.append(json.loads(raw))
        except ValueError:
            continue
    for value in _jsonld_dates(blocks, _JSONLD_PUBLISHED):
        day = normalise_date(value)
        if day:
            return PublishedDate(day, "page_published")
    meta = _from_pairs(reader.meta)
    if meta and meta.origin == "page_published":
        return meta
    for value in reader.times:
        day = normalise_date(value)
        if day:
            return PublishedDate(day, "page_published")
    for value in _jsonld_dates(blocks, _JSONLD_MODIFIED):
        day = normalise_date(value)
        if day:
            return PublishedDate(day, "page_modified")
    return meta


_OOXML_CREATED = re.compile(r"<dcterms:created[^>]*>([^<]+)</dcterms:created>")


def from_file(path: Path) -> PublishedDate | None:
    """From an uploaded file's own metadata: a PDF's CreationDate, an Office
    file's created date, an HTML file's page metadata. Never raises."""
    suffix = path.suffix.lower()
    try:
        if suffix in (".docx", ".pptx", ".xlsx"):
            with zipfile.ZipFile(path) as z:
                core = z.read("docProps/core.xml").decode("utf-8", "replace")
            m = _OOXML_CREATED.search(core)
            day = normalise_date(m.group(1)) if m else None
            return PublishedDate(day, "file_metadata") if day else None
        if suffix == ".pdf":
            day = normalise_date(_pdf_creation_date(path))
            return PublishedDate(day, "file_metadata") if day else None
        if suffix in (".html", ".htm"):
            return from_html(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:  # noqa: BLE001 - unreadable metadata: no date, never a failed upload
        return None
    return None


def _pdf_creation_date(path: Path) -> str | None:
    from pdfminer.pdfdocument import PDFDocument  # noqa: PLC0415 - markitdown[pdf] dependency
    from pdfminer.pdfparser import PDFParser  # noqa: PLC0415
    from pdfminer.pdftypes import resolve1  # noqa: PLC0415

    with path.open("rb") as f:
        doc = PDFDocument(PDFParser(f))
        for info in doc.info:
            value = resolve1(info.get("CreationDate"))
            if isinstance(value, bytes):
                value = value.decode("latin-1", "replace")
            if isinstance(value, str):
                return value
    return None
