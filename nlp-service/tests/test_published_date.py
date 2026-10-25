"""A source's publication date from its metadata (services/published_date.py)."""

from __future__ import annotations

import zipfile
from datetime import datetime, timedelta, timezone

import pytest

from services.published_date import PublishedDate, from_file, from_html, from_meta_map, normalise_date


@pytest.mark.parametrize("value, want", [
    ("2024-03-05", "2024-03-05"),
    ("2024-03-05T23:30:00-08:00", "2024-03-05"),  # the date as written, no zone shift
    ("2024-3-5 10:00", "2024-03-05"),
    ("2019/05/01", "2019-05-01"),
    ("2019-05/01", None),
    ("D:20230115103000+01'00'", "2023-01-15"),
    ("March 5, 2024", "2024-03-05"),
    ("Mar. 5th 2024", "2024-03-05"),
    ("5 March 2024", "2024-03-05"),
    ("Tue, 05 Mar 2024 10:00:00 GMT", "2024-03-05"),
    ("2024-02-30", None),
    ("1850-01-01", None),
    ("yesterday", None),
    ("", None),
    (None, None),
    (20240305, None),
])
def test_normalise_date(value, want):
    assert normalise_date(value) == want


def test_a_future_date_is_not_a_publication_date():
    future = (datetime.now(timezone.utc) + timedelta(days=30)).date().isoformat()
    assert normalise_date(future) is None


ARTICLE = """<!doctype html><html><head>
<meta property="og:title" content="Night trams">
<meta property="article:modified_time" content="2024-06-01T09:00:00Z">
<meta property="article:published_time" content="2024-03-05T08:00:00+00:00">
<script type="application/ld+json">
{"@context": "https://schema.org", "@graph": [
  {"@type": "WebSite", "name": "News"},
  {"@type": "NewsArticle", "headline": "Night trams", "datePublished": "2024-03-04", "dateModified": "2024-06-01"}
]}
</script></head><body><p>Posted <time pubdate datetime="2024-03-03">March 3</time></p></body></html>"""


def test_html_prefers_json_ld_then_meta_then_time():
    assert from_html(ARTICLE) == PublishedDate("2024-03-04", "page_published")
    no_ld = ARTICLE.replace('"datePublished": "2024-03-04", ', "")
    assert from_html(no_ld) == PublishedDate("2024-03-05", "page_published")
    only_time = '<html><body><time pubdate datetime="2024-03-03">x</time></body></html>'
    assert from_html(only_time) == PublishedDate("2024-03-03", "page_published")
    itemprop = '<span itemprop="datePublished" content="2021-07-09">July 9</span>'
    assert from_html(itemprop) == PublishedDate("2021-07-09", "page_published")


def test_html_with_only_a_modified_date_says_so():
    html = '<meta property="article:modified_time" content="2024-06-01T09:00:00Z"><p>x</p>'
    assert from_html(html) == PublishedDate("2024-06-01", "page_modified")


def test_html_without_dates_or_with_broken_json_ld_gives_none():
    assert from_html("<html><head><title>x</title></head><body>March 5, 2024</body></html>") is None
    broken = '<script type="application/ld+json">{"datePublished": </script><meta name="date" content="2020-01-02">'
    assert from_html(broken) == PublishedDate("2020-01-02", "page_published")


def test_firecrawl_metadata_in_either_spelling():
    assert from_meta_map({"title": "x", "publishedTime": "2023-11-02T15:00:00Z"}) == PublishedDate(
        "2023-11-02", "page_published")
    assert from_meta_map({"article:published_time": ["2022-01-01", "2022-01-02"]}) == PublishedDate(
        "2022-01-01", "page_published")
    # Google Scholar's tag, in its own Y/M/D form, comes before Dublin Core.
    assert from_meta_map({"dc.date": "2019-05-03", "citation_publication_date": "2019/05/01"}) == PublishedDate(
        "2019-05-01", "page_published")
    assert from_meta_map({"modifiedTime": "2024-01-01"}) == PublishedDate("2024-01-01", "page_modified")
    assert from_meta_map({"statusCode": 200, "language": "en"}) is None


def test_office_files_read_their_created_date(tmp_path):
    docx = tmp_path / "report.docx"
    with zipfile.ZipFile(docx, "w") as z:
        z.writestr("docProps/core.xml", (
            '<cp:coreProperties xmlns:cp="x" xmlns:dcterms="y">'
            '<dcterms:created xsi:type="dcterms:W3CDTF">2021-09-14T08:00:00Z</dcterms:created>'
            '<dcterms:modified xsi:type="dcterms:W3CDTF">2023-01-01T08:00:00Z</dcterms:modified>'
            '</cp:coreProperties>'))
    assert from_file(docx) == PublishedDate("2021-09-14", "file_metadata")


def test_html_files_read_their_page_metadata(tmp_path):
    page = tmp_path / "saved.html"
    page.write_text(ARTICLE, encoding="utf-8")
    assert from_file(page) == PublishedDate("2024-03-04", "page_published")


def test_unreadable_or_dateless_files_give_none(tmp_path):
    bad = tmp_path / "broken.docx"
    bad.write_bytes(b"not a zip")
    note = tmp_path / "note.md"
    note.write_text("Published March 5, 2024", encoding="utf-8")
    assert from_file(bad) is None
    assert from_file(note) is None  # text dates are the app's fallback, not metadata


def _minimal_pdf(creation_date: str) -> bytes:
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [] /Count 0 >>",
        f"<< /Producer (test) /CreationDate ({creation_date}) >>".encode(),
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def test_pdfs_read_their_creation_date(tmp_path):
    pytest.importorskip("pdfminer")
    pdf = tmp_path / "paper.pdf"
    pdf.write_bytes(_minimal_pdf("D:20230115103000+01'00'"))
    assert from_file(pdf) == PublishedDate("2023-01-15", "file_metadata")
