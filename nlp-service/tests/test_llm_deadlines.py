"""Draft, extract and schema calls end inside the app's wait (audit M5).

The app stops waiting for a draft after 600 s and for an extract after
900 s; retries and waits that ran past that were paid for and thrown away.
An attempt sent without a readable answer recorded no spend, so stalled
calls never counted against the daily cap.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import httpx
import pytest

from services import llm_client


class _Clock:
    """time.monotonic() that moves only when a stubbed call takes time."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch):
    c = _Clock()
    monkeypatch.setattr("time.monotonic", c)
    monkeypatch.setattr("time.sleep", lambda s: None)
    return c


@pytest.fixture
def deepseek(monkeypatch):
    from services import providers as P  # noqa: PLC0415
    from services.providers import deepseek as D  # noqa: PLC0415

    P._REGISTRY.clear()
    monkeypatch.setattr(D, "_DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(D, "_client", None)
    limiter = MagicMock()
    limiter.try_acquire.return_value = True
    monkeypatch.setattr(D, "_get_limiter", lambda: limiter)


def _stalling_post(monkeypatch, clock, error=httpx.ReadTimeout):
    """Every DeepSeek attempt waits its whole timeout, then fails."""
    timeouts: list[float] = []

    def _post(self, url, json=None, **kw):
        timeouts.append(kw["timeout"])
        clock.now += kw["timeout"]
        raise error("stalled")

    monkeypatch.setattr("httpx.Client.post", _post)
    return timeouts


def test_extract_retries_stop_before_the_app_stops_waiting(monkeypatch, clock, deepseek, mock_cost):
    """3 attempts × 420 s used to run 1,260 s against the app's 900 s."""
    start = clock.now
    timeouts = _stalling_post(monkeypatch, clock)

    with pytest.raises(llm_client.LLMCompileError, match="extract_llm_call_failed"):
        llm_client.extract_source("s1", "Body.", {}, None, None, model="deepseek-v4-pro")

    assert timeouts == [420.0, 420.0]
    assert clock.now - start <= 900 - 30


def test_an_attempt_waits_only_for_what_is_left(monkeypatch, clock, deepseek, mock_cost):
    from services.providers import get_provider  # noqa: PLC0415
    from services.providers.base import LLMRequest  # noqa: PLC0415

    timeouts = _stalling_post(monkeypatch, clock)
    req = LLMRequest(model="deepseek-v4-pro", messages=[{"role": "user", "content": "x"}],
                     max_output_tokens=64, step="extract", extra={"deadline": clock.now + 500})
    with pytest.raises(httpx.ReadTimeout):
        get_provider("deepseek-v4-pro").complete(req)
    # 420 s, then the 80 s left: an attempt with under a minute left is not sent.
    assert timeouts == [420.0, 80.0]


def test_a_draft_out_of_room_is_not_asked_again_without_time_for_it(monkeypatch, clock, mock_cost):
    """The second 32k-token attempt usually ran after the app gave up."""
    from services.providers import LLMResult  # noqa: PLC0415

    calls = []

    class _Provider:
        def complete(self, req):
            calls.append(req)
            clock.now += 400  # a long draft that ran out of room
            return LLMResult(text="---\ntitle: T\n---\n\nBody cut", parsed=None, parse_error=None,
                             usage={}, finish_reason="LENGTH")

    monkeypatch.setattr(llm_client, "get_provider", lambda model: _Provider())
    with pytest.raises(llm_client.LLMCompileError, match="no time left to ask again"):
        llm_client.draft_page(page_type="entity", title="T",
                              source_contents=[{"source_id": "s1", "title": "T", "markdown": "Content."}],
                              model="deepseek-v4-pro")
    assert len(calls) == 1
    # The draft carries the app's wait less a margin as its deadline.
    assert calls[0].extra["deadline"] == pytest.approx(1000.0 + 570.0)


def test_schema_carries_a_deadline(monkeypatch, mock_cost):
    from services.providers import LLMResult  # noqa: PLC0415

    seen = []

    class _Provider:
        def complete(self, req):
            seen.append(req)
            return LLMResult(text="# Schema", parsed=None, parse_error=None, usage={}, finish_reason="STOP")

    monkeypatch.setattr(llm_client, "get_provider", lambda model: _Provider())
    llm_client.generate_schema([{"title": "A", "page_type": "entity"}])
    assert seen[0].extra["deadline"] is not None


def test_a_stalled_deepseek_attempt_counts_its_worst_case(monkeypatch, clock, deepseek, mock_cost):
    from services.providers import get_provider  # noqa: PLC0415
    from services.providers.base import LLMRequest  # noqa: PLC0415

    _stalling_post(monkeypatch, clock)
    req = LLMRequest(model="deepseek-v4-pro", messages=[{"role": "user", "content": "x" * 400}],
                     max_output_tokens=1000, step="draft_page", extra={"retry": False})
    with pytest.raises(httpx.ReadTimeout):
        get_provider("deepseek-v4-pro").complete(req)
    mock_cost.assert_called_once_with("deepseek-v4-pro", 101, 0, 1000, 0)


def test_a_deepseek_attempt_that_never_reached_it_counts_nothing(monkeypatch, clock, deepseek, mock_cost):
    from services.providers import get_provider  # noqa: PLC0415
    from services.providers.base import LLMRequest  # noqa: PLC0415

    _stalling_post(monkeypatch, clock, error=httpx.ConnectError)
    req = LLMRequest(model="deepseek-v4-pro", messages=[{"role": "user", "content": "x"}],
                     max_output_tokens=1000, step="draft_page", extra={"retry": False})
    with pytest.raises(httpx.ConnectError):
        get_provider("deepseek-v4-pro").complete(req)
    mock_cost.assert_not_called()


def test_an_unreadable_deepseek_200_counts_its_worst_case(monkeypatch, deepseek, mock_cost):
    from services.providers import get_provider  # noqa: PLC0415
    from services.providers.base import LLMRequest  # noqa: PLC0415

    class _Response:
        status_code = 200
        text = "<html>gateway</html>"

        def json(self):
            raise ValueError("not json")

    monkeypatch.setattr("httpx.Client.post", lambda self, url, json=None, **kw: _Response())
    req = LLMRequest(model="deepseek-v4-pro", messages=[{"role": "user", "content": "x" * 40}],
                     max_output_tokens=500, step="triage")
    with pytest.raises(ValueError):
        get_provider("deepseek-v4-pro").complete(req)
    mock_cost.assert_called_once_with("deepseek-v4-pro", 11, 0, 500, 0)


def test_a_stalled_gemini_draft_counts_its_worst_case(mock_gemini, mock_limiter, mock_cost):
    mock_gemini.models.generate_content.side_effect = httpx.ReadTimeout("stalled")

    with pytest.raises(llm_client.LLMCompileError, match="draft_page_llm_failed"):
        llm_client.draft_page(page_type="entity", title="T",
                              source_contents=[{"source_id": "s1", "title": "T", "markdown": "Content."}])
    assert mock_cost.call_count == 1
    _model, _prompt, _cached, output, _thoughts = mock_cost.call_args.args
    assert output == llm_client._DRAFT_PAGE_MAX_OUTPUT_TOKENS


def test_a_gemini_draft_waits_only_until_its_deadline(mock_gemini, mock_limiter, mock_cost):
    llm_client.draft_page(page_type="entity", title="T",
                          source_contents=[{"source_id": "s1", "title": "T", "markdown": "Content."}])
    config = mock_gemini.models.generate_content.call_args.kwargs["config"]
    assert 0 < config.http_options.timeout <= 570_000
