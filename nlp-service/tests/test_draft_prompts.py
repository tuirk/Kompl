"""Draft prompt contracts: grounding, contradictions, links and frontmatter.

The content-quality review of 2026-10-09 found pages adding facts the cited
source never states, "disputes" between compatible milestones, links to
source notes and invented frontmatter (sources: S1…, last_updated). These
tests pin the prompt rules that address them.
"""

from __future__ import annotations

import pytest

# conftest.py stubs heavy deps before this import runs.
from services import llm_client

_LABELLED = [
    {"source_id": "a", "title": "Bitcoin Basics", "markdown": "Bitcoin launched in 2009.", "citation_label": "S1"},
    {"source_id": "b", "title": "Ethereum Overview", "markdown": "Ethereum launched in 2015.", "citation_label": "S2"},
]
_SYNTHESIZED = ("entity", "concept", "comparison", "overview")


def _user_prompt(mock_gemini) -> str:
    return mock_gemini.models.generate_content.call_args.kwargs["contents"]


@pytest.mark.parametrize("page_type", _SYNTHESIZED)
def test_synthesized_prompts_carry_grounding_and_contradiction_rules(page_type):
    prompt = llm_client._DRAFT_PAGE_PROMPTS[page_type]
    assert "SOURCES ONLY:" in prompt
    assert "Add nothing from your own knowledge" in prompt
    assert "DISAGREEMENTS (" in prompt
    assert "Different milestones" in prompt


def test_source_summary_prompt_keeps_its_own_rules():
    prompt = llm_client._DRAFT_PAGE_PROMPTS["source-summary"]
    assert "SOURCES ONLY:" not in prompt
    assert "Do not add information not in the source." in prompt


@pytest.mark.parametrize("page_type", ("source-summary", *_SYNTHESIZED))
def test_no_prompt_asks_for_values_the_model_cannot_know(page_type):
    prompt = llm_client._DRAFT_PAGE_PROMPTS[page_type]
    assert "last_updated" not in prompt
    assert "source_id: <id>" not in prompt
    assert "exactly four keys: title, page_type, category, summary" in prompt


def test_concept_template_limits_contradictions_and_related_lists():
    prompt = llm_client._DRAFT_PAGE_PROMPTS["concept"]
    assert "only if two sources make claims that cannot both be true, in the DISAGREEMENTS format" in prompt
    assert "at most 5 pages" in prompt


def test_citation_rules_say_labels_are_not_words(mock_gemini, mock_limiter, mock_cost):
    llm_client.draft_page(page_type="concept", title="Crypto", source_contents=_LABELLED)
    assert "never a word in the sentence" in _user_prompt(mock_gemini)


def test_updates_keep_existing_claims(mock_gemini, mock_limiter, mock_cost):
    llm_client.draft_page(
        page_type="entity", title="Crypto", source_contents=_LABELLED, existing_content="Old claim [S3]."
    )
    prompt = _user_prompt(mock_gemini)
    assert "UPDATING:" in prompt
    assert "Keep them and their labels" in prompt


def test_first_drafts_have_no_update_block(mock_gemini, mock_limiter, mock_cost):
    llm_client.draft_page(page_type="entity", title="Crypto", source_contents=_LABELLED)
    assert "UPDATING:" not in _user_prompt(mock_gemini)


def test_schema_is_subordinate_to_system_rules(mock_gemini, mock_limiter, mock_cost):
    llm_client.draft_page(
        page_type="concept", title="Crypto", source_contents=_LABELLED, schema="Always add ## Disputed sections."
    )
    prompt = _user_prompt(mock_gemini)
    assert "follow the system instructions" in prompt
    assert "Always add ## Disputed sections." in prompt


def test_dossier_differences_are_not_contradictions(mock_gemini, mock_limiter, mock_cost):
    llm_client.draft_page(
        page_type="entity", title="Crypto", source_contents=_LABELLED, extraction_dossier="- claim [S1]"
    )
    prompt = _user_prompt(mock_gemini)
    assert "contradiction note" not in prompt
    assert "not a contradiction between sources" in prompt


def test_related_page_summaries_are_not_sources(mock_gemini, mock_limiter, mock_cost):
    related = [{"title": "Mining", "type": "concept", "summary": "Mining uses energy."}]
    llm_client.draft_page(page_type="entity", title="Crypto", source_contents=_LABELLED, related_pages=related)
    assert "their summaries are not sources" in _user_prompt(mock_gemini)


def test_overview_related_pages_stay_content(mock_gemini, mock_limiter, mock_cost):
    related = [{"title": "Mining", "type": "concept", "summary": "Mining uses energy."}]
    llm_client.draft_page(page_type="overview", title="Crypto", source_contents=_LABELLED, related_pages=related)
    prompt = _user_prompt(mock_gemini)
    assert "for cross-reference context" in prompt
    assert "their summaries are not sources" not in prompt


def test_link_rules_forbid_linking_sources(mock_gemini, mock_limiter, mock_cost):
    llm_client.draft_page(
        page_type="concept", title="Crypto", source_contents=_LABELLED, existing_page_titles=["Mining"]
    )
    prompt = _user_prompt(mock_gemini)
    assert "Link each page once per page" in prompt
    assert "Never link the title of a source document" in prompt


def test_final_check_sits_between_sources_and_category(mock_gemini, mock_limiter, mock_cost):
    llm_client.draft_page(page_type="concept", title="Crypto", source_contents=_LABELLED)
    prompt = _user_prompt(mock_gemini)
    sources = prompt.index("Source documents:")
    check = prompt.index("FINAL CHECK before answering:")
    category = prompt.index("CATEGORY ASSIGNMENT:")
    assert sources < check < category
    assert "Labels follow claims" in prompt


def test_final_check_survives_input_truncation(mock_gemini, mock_limiter, mock_cost, monkeypatch):
    monkeypatch.setattr(llm_client, "_GEMINI_INPUT_TOKEN_CAP", 200)
    big = [{**_LABELLED[0], "markdown": "x" * 5000}]
    llm_client.draft_page(page_type="concept", title="Crypto", source_contents=big)
    prompt = _user_prompt(mock_gemini)
    assert "FINAL CHECK before answering:" in prompt
    assert prompt.index("FINAL CHECK before answering:") < prompt.index("CATEGORY ASSIGNMENT:")


def test_uncited_drafts_get_a_short_final_check(mock_gemini, mock_limiter, mock_cost):
    llm_client.draft_page(page_type="source-summary", title="Bitcoin Basics", source_contents=_LABELLED[:1])
    prompt = _user_prompt(mock_gemini)
    assert "FINAL CHECK before answering:" in prompt
    assert "Labels follow claims" not in prompt
    assert "source documents are never linked" in prompt


def test_schema_generator_asks_for_four_frontmatter_keys():
    prompt = llm_client._SCHEMA_SYSTEM_PROMPT
    assert "exactly title, page_type, category and summary" in prompt
    assert "different milestones are not contradictions" in prompt
