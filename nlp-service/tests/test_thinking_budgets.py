"""Regression tests for _read_thinking_budget — the per-call-site reasoning
token allowance previously hardcoded in llm_client.py and now sourced from
/data/llm-config.json (written by Next.js's setThinkingBudgets helper).

The cache window is 30 s, so each test resets _thinking_cache to force a fresh
read of the temp config file.
"""

from __future__ import annotations

import json

import pytest

from services import llm_client


@pytest.fixture
def isolated_config(monkeypatch, tmp_path):
    """Point _CONFIG_FILE at a tmp file and clear the 30 s read cache."""
    config_file = tmp_path / "llm-config.json"
    monkeypatch.setattr(llm_client, "_CONFIG_FILE", config_file)
    monkeypatch.setattr(llm_client, "_thinking_cache", {"value": None, "read_at": 0.0})
    return config_file


def test_defaults_match_shipped_behaviour(isolated_config):
    """No file → falls back to the dict baked into llm_client.

    Defaults must match what the original hardcoded literals were so flipping to
    a settings-driven model doesn't silently change LLM behaviour at boot.
    """
    expected = {
        "extract_source": 512,
        "draft_page": 1024,
        "disambiguate_entities": 512,
        "synthesize_answer": 512,
        "lint_scan": 1024,
        "select_pages_for_query": 1024,
        "generate_schema": 2048,
        "crossref_pages": 0,
        "triage_page_update": 0,
        "generate_digest": 1024,
    }
    for site, value in expected.items():
        assert llm_client._read_thinking_budget(site) == value


def test_overrides_take_effect(isolated_config):
    isolated_config.write_text(
        json.dumps({"thinking_budgets": {"draft_page": -1, "extract_source": 4096}})
    )
    assert llm_client._read_thinking_budget("draft_page") == -1
    assert llm_client._read_thinking_budget("extract_source") == 4096
    # Untouched key falls back to default.
    assert llm_client._read_thinking_budget("crossref_pages") == 0


def test_unknown_call_site_raises(isolated_config):
    """A typo at the call site must not silently land on a wrong default."""
    with pytest.raises(KeyError):
        llm_client._read_thinking_budget("not_a_real_site")


def test_invalid_value_falls_back_to_default(isolated_config):
    isolated_config.write_text(
        json.dumps(
            {
                "thinking_budgets": {
                    "draft_page": 99999,         # > 24576 cap
                    "extract_source": -2,        # < -1
                    "crossref_pages": "huge",   # wrong type
                    "lint_scan": 256,            # valid
                }
            }
        )
    )
    assert llm_client._read_thinking_budget("draft_page") == 1024     # default
    assert llm_client._read_thinking_budget("extract_source") == 512  # default
    assert llm_client._read_thinking_budget("crossref_pages") == 0    # default
    assert llm_client._read_thinking_budget("lint_scan") == 256       # honored


def test_malformed_json_falls_back_to_default(isolated_config):
    isolated_config.write_text("{not valid json")
    assert llm_client._read_thinking_budget("draft_page") == 1024


def test_does_not_break_when_other_keys_present(isolated_config):
    """Co-tenant keys (daily_cap_usd) must not trip the reader."""
    isolated_config.write_text(
        json.dumps({"daily_cap_usd": 5.0, "thinking_budgets": {"draft_page": 0}})
    )
    assert llm_client._read_thinking_budget("draft_page") == 0
    # Defaults still apply for keys not in the override map.
    assert llm_client._read_thinking_budget("extract_source") == 512
