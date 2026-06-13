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
