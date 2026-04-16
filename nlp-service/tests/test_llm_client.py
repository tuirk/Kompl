"""Regression tests for llm_client.py — source-summary prompt + draft_page().

No Gemini API calls made — get_client(), _get_limiter(), and
_check_and_record_cost() are patched via conftest.py fixtures.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

# conftest.py stubs heavy deps before this import runs.
from services import llm_client


# ---------------------------------------------------------------------------
# Source-summary prompt text contracts
# ---------------------------------------------------------------------------


def test_source_summary_prompt_has_required_sections():
    """source-summary prompt must declare all required output sections."""
    prompt = llm_client._DRAFT_PAGE_PROMPTS["source-summary"]
    assert "## Content" in prompt
    assert "## Key Facts" in prompt
    assert "## Entities Mentioned" in prompt
    assert "## Concepts" in prompt
    assert "YAML frontmatter" in prompt


def test_source_summary_prompt_forbids_summarizing_and_paraphrasing():
    """source-summary prompt must explicitly prohibit summarization/paraphrasing."""
    prompt = llm_client._DRAFT_PAGE_PROMPTS["source-summary"].lower()
    assert "do not summarize" in prompt
    assert "do not paraphrase" in prompt


def test_source_summary_prompt_requires_faithful_reproduction():
    """source-summary prompt must instruct faithful full reproduction of source text."""
    prompt = llm_client._DRAFT_PAGE_PROMPTS["source-summary"]
    assert "faithfully and in full" in prompt
    assert "copy the text as written" in prompt
    assert "most important part" in prompt


# ---------------------------------------------------------------------------
# draft_page() behaviour tests
# ---------------------------------------------------------------------------


def test_draft_page_calls_gemini_flash_with_correct_config(
    mock_gemini, mock_limiter, mock_cost
):
    """draft_page must call gemini-2.5-flash with thinking_budget=1024 and temp=0.3."""
    from google.genai import types  # noqa: PLC0415

    llm_client.draft_page(
        page_type="source-summary",
        title="Test Source",
        source_contents=[{"source_id": "s1", "title": "T", "markdown": "Content."}],
    )

    assert mock_gemini.models.generate_content.called
    call_kwargs = mock_gemini.models.generate_content.call_args.kwargs
    assert call_kwargs["model"] == "gemini-2.5-flash"
    config = call_kwargs["config"]
    assert config.thinking_config.thinking_budget == 1024
    assert config.temperature == 0.3
    assert config.max_output_tokens == 16384


def test_draft_page_uses_source_summary_system_prompt(
    mock_gemini, mock_limiter, mock_cost
):
    """draft_page must pass the source-summary system prompt for page_type source-summary."""
    llm_client.draft_page(
        page_type="source-summary",
        title="Test",
        source_contents=[{"source_id": "s1", "title": "T", "markdown": "M"}],
    )

    call_kwargs = mock_gemini.models.generate_content.call_args.kwargs
    assert call_kwargs["config"].system_instruction == llm_client._DRAFT_PAGE_PROMPTS["source-summary"]


def test_draft_page_strips_markdown_code_fences(mock_gemini, mock_limiter, mock_cost):
    """draft_page must strip ```yaml / ``` wrappers that Gemini sometimes adds."""
    mock_gemini.models.generate_content.return_value.text = (
        "```yaml\n---\ntitle: X\npage_type: source-summary\n---\n## Content\nBody.\n```"
    )

    result = llm_client.draft_page(
        page_type="source-summary",
        title="X",
        source_contents=[{"source_id": "s1", "title": "T", "markdown": "M"}],
    )

    assert not result.startswith("```")
    assert not result.endswith("```")
    assert "title: X" in result


def test_draft_page_raises_rate_limited_when_bucket_full(mock_gemini, mock_cost):
    """draft_page must raise LLMRateLimitedError when the rate limiter denies."""
    mock_lim = MagicMock()
    mock_lim.try_acquire.return_value = False

    import services.llm_client as lc  # noqa: PLC0415
    lc._get_limiter = lambda: mock_lim  # direct patch (no monkeypatch needed here)

    with pytest.raises(llm_client.LLMRateLimitedError):
        llm_client.draft_page(
            page_type="source-summary",
            title="X",
            source_contents=[{"source_id": "s1", "title": "T", "markdown": "M"}],
        )
