"""Link fetch hardening (owner decision 2026-10-25): Firecrawl's 429 is
waited out within the convert budget, and a bot check served instead of
the page is never returned as the page."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from routers import conversion as conv
from services.http_client import HttpClientError

OK = {
    "success": True,
    "data": {"markdown": "# Night trams\n\n" + "Lisbon runs trams after midnight. " * 30,
             "metadata": {"title": "Night trams", "url": "https://example.com/t"}},
}
RATE_LIMITED = HttpClientError(
    "HTTP 429 from https://api.firecrawl.dev/v2/scrape", 429,
    '{"error":"Rate limit exceeded. Please retry after 7s, resets at ..."}',
)


@pytest.fixture
def firecrawl(monkeypatch):
    """Answers each scrape with the next reply, 10 s each on a fake clock; records the sleeps."""
    state = {"replies": [], "calls": 0, "sleeps": [], "clock": 0.0}

    def sleep(s):
        state["sleeps"].append(s)
        state["clock"] += s

    def post_json(**kw):
        state["clock"] += 10.0
        reply = state["replies"][state["calls"]]
        state["calls"] += 1
        if isinstance(reply, Exception):
            raise reply
        return reply

    monkeypatch.setattr(conv, "_try_markitdown_url", lambda source_id, url: None)
    monkeypatch.setattr(conv, "_FIRECRAWL_API_KEY", "fc-test")
    monkeypatch.setattr(conv, "validate_outbound_url", lambda url: None)
    monkeypatch.setattr(conv._firecrawl_http, "post_json", post_json)
    monkeypatch.setattr(conv.time, "sleep", sleep)
    monkeypatch.setattr(conv.time, "monotonic", lambda: state["clock"])
    return state


def convert():
    return conv.convert_url(conv.UrlConvertRequest(source_id="src-1", url="https://example.com/t"))


def test_a_rate_limited_scrape_waits_as_asked_and_retries(firecrawl):
    firecrawl["replies"] = [RATE_LIMITED, OK]
    assert convert().title == "Night trams"
    assert firecrawl["sleeps"] == [8.0]


def test_without_a_retry_time_it_backs_off(firecrawl):
    bare = HttpClientError("HTTP 429", 429, None)
    firecrawl["replies"] = [bare, OK]
    assert convert().title == "Night trams"
    assert firecrawl["sleeps"] == [10.0]


def test_it_gives_up_once_the_convert_budget_would_run_out(firecrawl, monkeypatch):
    bare = HttpClientError("HTTP 429", 429, None)
    firecrawl["replies"] = [bare] * 5
    with pytest.raises(HTTPException) as e:
        convert()
    assert e.value.status_code == 502 and e.value.detail["upstream_status"] == 429
    # At 30 s (two 10 s scrapes, a 10 s wait) a 20 s wait and a retry that
    # may take the 60 s client timeout would pass the 100 s budget.
    assert firecrawl["sleeps"] == [10.0]


def test_other_errors_are_not_retried(firecrawl):
    firecrawl["replies"] = [HttpClientError("HTTP 402", 402, None)]
    with pytest.raises(HTTPException):
        convert()
    assert firecrawl["calls"] == 1 and firecrawl["sleeps"] == []


def test_a_bot_check_page_is_refused_not_saved(firecrawl):
    firecrawl["replies"] = [{
        "success": True,
        "data": {"markdown": "Checking your browser...\n\nThis will only take a few seconds...",
                 "metadata": {"title": "Checking your browser..."}},
    }]
    with pytest.raises(HTTPException) as e:
        convert()
    assert e.value.status_code == 422 and "bot_check_page" in e.value.detail


def test_a_long_article_about_bot_checks_is_kept():
    article = "Why sites show 'Checking your browser' screens. " + "Cloudflare explains its checks. " * 100
    assert not conv._is_bot_check("Bot checks explained", article)
    assert conv._is_bot_check("Just a moment...", "Enable JavaScript and cookies to continue")


def test_a_title_with_the_page_indentation_is_one_line(firecrawl):
    firecrawl["replies"] = [{
        "success": True,
        "data": {"markdown": OK["data"]["markdown"],
                 "metadata": {"title": "\n\t\tOn automatically generating contrasting text colors with CSS \u2022 Lea Verou\n"}},
    }]
    assert convert().title == "On automatically generating contrasting text colors with CSS \u2022 Lea Verou"


def test_a_page_without_a_title_is_named_by_its_first_heading(firecrawl):
    body = "[< Previous](./atypi)\n\n## Censorship, Creativity, and the Polish School of Posters\n\n#### By\n\n" + "Text. " * 200
    firecrawl["replies"] = [{"success": True, "data": {"markdown": body, "metadata": {}}}]
    result = convert()
    assert (result.title, result.title_source) == ("Censorship, Creativity, and the Polish School of Posters", "body_h2")


ARTICLE = "".join(
    f"<p>Paragraph {i}: Saul Bass designed the title sequence for The Man with the Golden Arm and many "
    f"later films, and the book collects his posters, logos and storyboards from year {1950 + i}.</p>"
    for i in range(8)
)
WALLPAPER = (
    "<html><body><nav><a href='/art'>Art</a> <a href='/design'>Design</a></nav>"
    "<div class='newsletter'><h3>Wallpaper* Newsletter</h3><p>Receive our daily digest.</p></div>"
    f"<article><h1>Saul Bass: A Life in Film &amp; Design</h1>{ARTICLE}</article>"
    "<footer>Future plc, Quay House</footer></body></html>"
)


def test_firecrawl_whole_page_keeps_only_the_article_picked_from_its_html(firecrawl):
    """Firecrawl's own main-content mode gave a Wallpaper* article's newsletter
    box (2026-10-26): the whole page comes back and the article is picked
    from its HTML here."""
    full = "Wallpaper* Newsletter\n\nReceive our daily digest.\n\n# Saul Bass\n\n" + "Text. " * 300
    firecrawl["replies"] = [{"success": True, "data": {"markdown": full, "rawHtml": WALLPAPER,
                                                       "metadata": {"title": "Saul Bass | Wallpaper*"}}}]
    result = convert()
    assert "title sequence for The Man with the Golden Arm" in result.markdown
    assert "Newsletter" not in result.markdown and "Quay House" not in result.markdown


def test_an_extract_too_short_to_trust_keeps_the_whole_page(firecrawl):
    full = "# Saul Bass\n\n" + "The whole page text. " * 100
    tiny = "<html><body><article><p>Wallpaper* Newsletter. Receive our daily digest.</p></article></body></html>"
    firecrawl["replies"] = [{"success": True, "data": {"markdown": full, "rawHtml": tiny, "metadata": {}}}]
    assert convert().markdown == full
