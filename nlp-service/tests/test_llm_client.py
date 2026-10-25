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
    # The prompt combines the prohibition: "do NOT summarize, paraphrase, or shorten".
    assert "do not summarize" in prompt
    assert "paraphrase" in prompt


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
    ).markdown

    assert not result.startswith("```")
    assert not result.endswith("```")
    assert "title: X" in result


def test_draft_page_raises_rate_limited_when_bucket_full(mock_gemini, mock_cost):
    """draft_page must raise LLMRateLimitedError when the rate limiter denies.

    Phase 2: limiter lives in services.providers.gemini.
    """
    mock_lim = MagicMock()
    mock_lim.try_acquire.return_value = False

    from services.providers import gemini as gemini_provider  # noqa: PLC0415
    gemini_provider._get_limiter = lambda: mock_lim  # direct patch (no monkeypatch needed here)

    with pytest.raises(llm_client.LLMRateLimitedError):
        llm_client.draft_page(
            page_type="source-summary",
            title="X",
            source_contents=[{"source_id": "s1", "title": "T", "markdown": "M"}],
        )


# ---------------------------------------------------------------------------
# Entity disambiguation (Layer 3) prompt and call
# ---------------------------------------------------------------------------


def test_entity_disambiguation_prompt_lists_what_is_different():
    """The judge merged related things that are not one thing; explicit
    "different" rules for the entity prompt (decision 2026-10-23, item 1).
    Its examples stay off the replay set (scripts/resolve_replay_pairs.json),
    so the replay measures the rules, not the examples."""
    prompt = llm_client._DISAMBIGUATION_SYSTEM_PROMPT
    for rule in ("part and its whole", "located in", "parent organisation", "product and its maker",
                 "founder", "North", "South", "City Hall", "Museum", "versions"):
        assert rule in prompt, rule


@pytest.mark.parametrize("name", ["_DISAMBIGUATION_SYSTEM_PROMPT", "_DISAMBIGUATION_CONCEPT_SYSTEM_PROMPT"])
def test_disambiguation_prompts_read_same_source_as_a_hint_and_keep_the_canonical_to_the_two_names(name):
    prompt = getattr(llm_client, name)
    assert "same_source" in prompt
    assert "hint, not a rule" in prompt
    assert "one of the two names" in prompt


def test_disambiguate_entities_call_and_payload(monkeypatch):
    """Call parameters unchanged; each pair goes to the model as given,
    same_source included; the response schema is the one it always was."""
    import json  # noqa: PLC0415

    from services.providers import LLMResult  # noqa: PLC0415

    captured = {}

    class _Provider:
        def complete(self, req):
            captured["req"] = req
            parsed = llm_client.DisambiguationResponse(results=[])
            return LLMResult(text='{"results": []}', parsed=parsed, parse_error=None, usage={}, finish_reason="STOP")

    monkeypatch.setattr(llm_client, "get_provider", lambda model: _Provider())
    pair = {"entity_a": {"name": "ML", "type": "CONCEPT", "context": "a"},
            "entity_b": {"name": "Machine Learning", "type": "CONCEPT", "context": "b"}, "same_source": True}
    llm_client.disambiguate_entities([pair], model="deepseek-flash", pair_kind="entity")

    req = captured["req"]
    assert req.model == "deepseek-flash"
    assert req.response_model is llm_client.DisambiguationResponse
    assert req.temperature == 0.0
    assert req.max_output_tokens == 8192
    assert req.thinking_budget == 512
    assert req.step == "disambiguate"
    assert req.messages[0] == {"role": "system", "content": llm_client._DISAMBIGUATION_SYSTEM_PROMPT}
    sent = json.loads(req.messages[1]["content"].split("\n", 1)[1])
    assert sent == [pair]
    assert set(llm_client.DisambiguationResult.model_fields) == {"entity_a", "entity_b", "decision", "canonical", "reason"}


# ---------------------------------------------------------------------------
# Category label consolidation (one call at the end of a compile)
# ---------------------------------------------------------------------------


def test_label_merge_prompt_keeps_different_categories_apart():
    """Only labels naming the same category merge; related but different
    categories never do, and the model may only use the names it was given."""
    prompt = llm_client._LABEL_MERGE_SYSTEM_PROMPT
    for rule in ("Crypto", "Cryptocurrency", "abbreviation", "broader and a narrower",
                 "Machine Learning", "neighbouring", "When in doubt, do not merge",
                 "never a new name", "merge into the EXISTING label", "merges"):
        assert rule in prompt, rule


def test_consolidate_labels_call_and_payload(monkeypatch):
    import json  # noqa: PLC0415

    from services.providers import LLMResult  # noqa: PLC0415

    captured = {}

    class _Provider:
        def complete(self, req):
            captured["req"] = req
            parsed = llm_client.LabelMergeResponse(merges=[
                llm_client.LabelMerge(label="Crypto", into="Cryptocurrency", reason="short form"),
            ])
            return LLMResult(text='{"merges": []}', parsed=parsed, parse_error=None, usage={}, finish_reason="STOP")

    monkeypatch.setattr(llm_client, "get_provider", lambda model: _Provider())
    result = llm_client.consolidate_labels(["Cryptocurrency", "Travel"], ["Crypto"], model="deepseek-flash")

    req = captured["req"]
    assert req.model == "deepseek-flash"
    assert req.response_model is llm_client.LabelMergeResponse
    assert req.temperature == 0.0
    assert req.max_output_tokens == 4096
    assert req.thinking_budget == 512
    assert req.step == "labels"
    assert req.messages[0] == {"role": "system", "content": llm_client._LABEL_MERGE_SYSTEM_PROMPT}
    assert json.loads(req.messages[1]["content"]) == {
        "existing_labels": ["Cryptocurrency", "Travel"],
        "new_labels": ["Crypto"],
    }
    assert [(m.label, m.into) for m in result.merges] == [("Crypto", "Cryptocurrency")]
    assert set(llm_client.LabelMerge.model_fields) == {"label", "into", "reason"}


def test_consolidate_labels_sends_nothing_without_new_labels(monkeypatch):
    def _no_provider(model):
        raise AssertionError("no call expected")

    monkeypatch.setattr(llm_client, "get_provider", _no_provider)
    assert llm_client.consolidate_labels(["Travel"], [], model="deepseek-flash").merges == []


def test_consolidate_labels_unparsed_response_is_a_compile_error(monkeypatch):
    from services.providers import LLMResult  # noqa: PLC0415

    class _Provider:
        def complete(self, req):
            return LLMResult(text='[]', parsed=None, parse_error=ValueError("bare list"), usage={}, finish_reason="STOP")

    monkeypatch.setattr(llm_client, "get_provider", lambda model: _Provider())
    with pytest.raises(llm_client.LLMCompileError, match="consolidate_labels_parse_failed"):
        llm_client.consolidate_labels([], ["Crypto"], model="deepseek-flash")
