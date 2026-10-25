"""Tests for llm_client daily cost-cap persistence and locking."""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from services import llm_client


@pytest.fixture
def cap_dir(tmp_path, monkeypatch):
    """Isolate llm-cap.json / llm-config.json under a temp DATA_ROOT."""
    data_root = tmp_path / "data"
    data_root.mkdir()
    monkeypatch.setenv("DATA_ROOT", str(data_root))
    monkeypatch.setattr(llm_client, "_CAP_FILE", data_root / "llm-cap.json")
    monkeypatch.setattr(llm_client, "_CONFIG_FILE", data_root / "llm-config.json")
    monkeypatch.setattr(llm_client, "_cap_cache", {"value": None, "read_at": 0.0})
    (data_root / "llm-config.json").write_text(json.dumps({"daily_cap_usd": 100.0}))
    return data_root


def test_utc_today_matches_utc_date():
    expected = str(datetime.now(timezone.utc).date())
    assert llm_client._utc_today() == expected


def test_check_and_record_cost_concurrent_increments_exact(cap_dir, monkeypatch):
    """Thread lock must serialize increments — total spend equals sum of costs."""
    mock_provider = MagicMock()
    mock_provider.cost_usd.return_value = 0.01
    monkeypatch.setattr(llm_client, "get_provider", lambda _model: mock_provider)

    errors: list[Exception] = []

    def record_once() -> None:
        try:
            llm_client._check_and_record_cost("gemini-2.5-flash", 10, 0, 5, 0)
        except Exception as e:  # noqa: BLE001 — collect for assertion
            errors.append(e)

    threads = [threading.Thread(target=record_once) for _ in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    cap_data = json.loads((cap_dir / "llm-cap.json").read_text())
    assert cap_data["call_count"] == 20
    assert cap_data["total_usd"] == pytest.approx(0.2, abs=1e-6)


# ---------------------------------------------------------------------------
# The cap is checked before a call is sent
# ---------------------------------------------------------------------------


def _set_spend(cap_dir: Path, cap_usd: float, spent_usd: float) -> None:
    (cap_dir / "llm-config.json").write_text(json.dumps({"daily_cap_usd": cap_usd}))
    (cap_dir / "llm-cap.json").write_text(json.dumps(
        {"date": llm_client._utc_today(), "total_usd": spent_usd, "call_count": 3}
    ))


def _spend(cap_dir: Path) -> dict:
    return json.loads((cap_dir / "llm-cap.json").read_text())


def _gemini_usage(response: MagicMock, output_tokens: int) -> None:
    """Gemini 2.5 Flash bills output at $2.50/M: 20_000 tokens = $0.05."""
    response.usage_metadata.prompt_token_count = 0
    response.usage_metadata.cached_content_token_count = 0
    response.usage_metadata.candidates_token_count = output_tokens
    response.usage_metadata.thoughts_token_count = 0


_PAIR = {"name": "A", "type": "ORG", "context": "c"}

_CALL_SITES = {
    "lint_scan": lambda: llm_client.lint_scan(["[p1] A: a"]),
    "extract_source": lambda: llm_client.extract_source("s1", "Body.", {}, None, None),
    "disambiguate_entities": lambda: llm_client.disambiguate_entities(
        [{"entity_a": _PAIR, "entity_b": _PAIR, "same_source": False}]
    ),
    "draft_page": lambda: llm_client.draft_page(
        "source-summary", "T", [{"source_id": "s1", "title": "T", "markdown": "Body."}]
    ).markdown,
    "crossref_pages": lambda: llm_client.crossref_pages(
        [{"plan_id": "p1", "title": "A", "page_type": "entity", "markdown": "x"}]
    ),
    "triage_page_update": lambda: llm_client.triage_page_update("claims", "summary", "A"),
    "consolidate_labels": lambda: llm_client.consolidate_labels(["Cryptocurrency"], ["Crypto"]),
    "generate_schema": lambda: llm_client.generate_schema(
        [{"title": "A", "page_type": "entity", "category": None}]
    ),
}


@pytest.mark.parametrize("call_site", sorted(_CALL_SITES))
def test_every_call_site_is_refused_before_sending_at_cap(
    call_site, cap_dir, mock_gemini, mock_limiter
):
    """Spend at the cap: the call is refused with the usual error and never sent."""
    _set_spend(cap_dir, cap_usd=1.0, spent_usd=1.0)

    # Handed on unwrapped, so the routers answer 503 daily_cost_ceiling.
    with pytest.raises(llm_client.CostCeilingError) as exc:
        _CALL_SITES[call_site]()

    assert "Daily LLM spend limit ($1.00) reached" in str(exc.value)
    mock_gemini.models.generate_content.assert_not_called()
    mock_limiter.try_acquire.assert_not_called()
    assert _spend(cap_dir)["call_count"] == 3
    assert llm_client._in_flight == {"calls": 0, "usd": 0.0}


def _deepseek(monkeypatch, usage: dict) -> list:
    """DeepSeek provider with a stubbed HTTP post; returns the sent bodies."""
    from services import providers as P  # noqa: PLC0415
    from services.providers import deepseek as D  # noqa: PLC0415

    P._REGISTRY.clear()
    monkeypatch.setattr(D, "_DEEPSEEK_API_KEY", "test-key")
    monkeypatch.setattr(D, "_client", None)
    limiter = MagicMock()
    limiter.try_acquire.return_value = True
    monkeypatch.setattr(D, "_get_limiter", lambda: limiter)
    sent: list = []

    class _Response:
        status_code = 200
        text = ""

        def json(self):
            return {
                "choices": [{"message": {"content": "free text"}, "finish_reason": "stop"}],
                "usage": usage,
            }

    def _post(self, url, json=None, **kw):
        sent.append(json)
        return _Response()

    monkeypatch.setattr("httpx.Client.post", _post)
    return sent


def _deepseek_request():
    from services.providers.base import LLMRequest  # noqa: PLC0415
    return LLMRequest(
        model="deepseek-flash", messages=[{"role": "user", "content": "x"}],
        max_output_tokens=128, step="t",
    )


def test_deepseek_is_refused_before_sending_at_cap(cap_dir, monkeypatch):
    from services.providers import get_provider  # noqa: PLC0415

    sent = _deepseek(monkeypatch, {"prompt_tokens": 10, "completion_tokens": 10})
    _set_spend(cap_dir, cap_usd=1.0, spent_usd=1.25)

    with pytest.raises(llm_client.CostCeilingError):
        get_provider("deepseek-flash").complete(_deepseek_request())
    assert sent == []
    assert _spend(cap_dir)["call_count"] == 3


def test_deepseek_call_that_crosses_the_cap_is_recorded_and_returned(cap_dir, monkeypatch):
    """The crossing call was billed: record it, return it, refuse the next one."""
    from services.providers import get_provider  # noqa: PLC0415

    # deepseek-flash output is $1.20/M: 50_000 tokens = $0.06.
    sent = _deepseek(monkeypatch, {"prompt_tokens": 0, "completion_tokens": 50_000})
    _set_spend(cap_dir, cap_usd=1.0, spent_usd=0.99)

    result = get_provider("deepseek-flash").complete(_deepseek_request())
    assert result.text == "free text"
    assert _spend(cap_dir)["total_usd"] == pytest.approx(1.05)
    assert _spend(cap_dir)["call_count"] == 4

    with pytest.raises(llm_client.CostCeilingError):
        get_provider("deepseek-flash").complete(_deepseek_request())
    assert len(sent) == 1


def test_gemini_call_that_crosses_the_cap_is_recorded_and_returned(
    cap_dir, mock_gemini, mock_limiter
):
    _gemini_usage(mock_gemini.models.generate_content.return_value, 20_000)  # $0.05
    _set_spend(cap_dir, cap_usd=1.0, spent_usd=0.99)
    draft = _CALL_SITES["draft_page"]

    assert "## Content" in draft()
    assert _spend(cap_dir)["total_usd"] == pytest.approx(1.04)
    assert _spend(cap_dir)["call_count"] == 4

    with pytest.raises(llm_client.CostCeilingError):
        draft()
    assert mock_gemini.models.generate_content.call_count == 1


def test_parallel_calls_near_the_cap_wait_instead_of_all_going_out(
    cap_dir, mock_gemini, mock_limiter
):
    """Calls start while recorded spend plus the worst case of calls in flight
    is under the cap; the rest wait, then go or are refused on recorded spend."""
    from services.providers import get_provider  # noqa: PLC0415
    from services.providers.base import LLMRequest  # noqa: PLC0415

    _set_spend(cap_dir, cap_usd=1.0, spent_usd=0.0)
    response = mock_gemini.models.generate_content.return_value
    _gemini_usage(response, 120_000)  # each call really costs $0.30
    release = threading.Event()
    started = threading.Semaphore(0)
    state = {"in_flight": 0, "peak": 0, "sends": 0}
    lock = threading.Lock()

    def _send(**_kw):
        with lock:
            state["sends"] += 1
            state["in_flight"] += 1
            state["peak"] = max(state["peak"], state["in_flight"])
        started.release()
        release.wait(10)
        with lock:
            state["in_flight"] -= 1
        return response

    mock_gemini.models.generate_content.side_effect = _send
    # Worst case of one call: 180_000 output tokens at $2.50/M = $0.45.
    req = LLMRequest(model="gemini-2.5-flash", messages=[{"role": "user", "content": "x"}],
                     max_output_tokens=180_000, step="t")
    outcomes: list = []

    def _call():
        try:
            outcomes.append(get_provider("gemini-2.5-flash").complete(req))
        except Exception as e:  # noqa: BLE001 — collected for assertion
            outcomes.append(e)

    threads = [threading.Thread(target=_call, daemon=True) for _ in range(5)]
    for t in threads:
        t.start()
    try:
        for _ in range(3):
            assert started.acquire(timeout=10)
        # 0, 0.45 and 0.90 committed let three out; at 1.35 the other two wait.
        assert not started.acquire(timeout=0.3)
        assert state["sends"] == 3
    finally:
        # Settle every call while this test's temp spend files are in place.
        release.set()
        for t in threads:
            t.join(timeout=10)

    # Three settle at $0.90 recorded, one more goes, and at $1.20 the last is refused.
    refused = [o for o in outcomes if isinstance(o, llm_client.CostCeilingError)]
    assert len(outcomes) == 5 and len(refused) == 1
    assert state == {"in_flight": 0, "peak": 3, "sends": 4}
    assert _spend(cap_dir)["total_usd"] == pytest.approx(1.2)
    assert llm_client._in_flight == {"calls": 0, "usd": 0.0}


def test_a_call_that_never_settles_holds_others_back_only_for_a_while(
    cap_dir, mock_gemini, mock_limiter, monkeypatch
):
    _gemini_usage(mock_gemini.models.generate_content.return_value, 0)
    _set_spend(cap_dir, cap_usd=1.0, spent_usd=0.0)
    monkeypatch.setattr(llm_client, "_SPEND_WAIT_MAX_S", 0.2)
    monkeypatch.setattr(llm_client, "_SPEND_WAIT_POLL_S", 0.05)
    # A hung call holding more than the whole budget.
    monkeypatch.setattr(llm_client, "_in_flight", {"calls": 1, "usd": 5.0})

    assert "## Content" in _CALL_SITES["draft_page"]()
    assert mock_gemini.models.generate_content.call_count == 1


def test_failed_send_frees_its_place(cap_dir, mock_gemini, mock_limiter):
    _set_spend(cap_dir, cap_usd=1.0, spent_usd=0.5)
    mock_gemini.models.generate_content.side_effect = RuntimeError("boom")

    with pytest.raises(llm_client.LLMCompileError):
        _CALL_SITES["draft_page"]()
    assert llm_client._in_flight == {"calls": 0, "usd": 0.0}
    assert _spend(cap_dir)["call_count"] == 3


def test_zero_cap_means_unlimited(cap_dir, mock_gemini, mock_limiter):
    _gemini_usage(mock_gemini.models.generate_content.return_value, 20_000)
    _set_spend(cap_dir, cap_usd=0.0, spent_usd=50.0)

    assert "## Content" in _CALL_SITES["draft_page"]()
    assert _spend(cap_dir)["total_usd"] == pytest.approx(50.05)
