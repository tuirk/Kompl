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
    monkeypatch.setattr(conv._http, "post_json", post_json)
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
    firecrawl["replies"] = [bare, bare, OK]
    assert convert().title == "Night trams"
    assert firecrawl["sleeps"] == [10.0, 20.0]


def test_it_gives_up_once_the_convert_budget_would_run_out(firecrawl, monkeypatch):
    bare = HttpClientError("HTTP 429", 429, None)
    firecrawl["replies"] = [bare] * 5
    with pytest.raises(HTTPException) as e:
        convert()
    assert e.value.status_code == 502 and e.value.detail["upstream_status"] == 429
    # At 60 s (three 10 s scrapes, 10 + 20 s waits) a 30 s wait and a 30 s
    # retry would pass the 100 s budget.
    assert firecrawl["sleeps"] == [10.0, 20.0]


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
