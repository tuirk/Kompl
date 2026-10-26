"""draft_page citation labels.

When the app labels its sources (citation_label), multi-source page types get
the CITATIONS rules and labelled source headers; source-summary pages and
unlabelled requests keep the previous prompt shape.
"""

from __future__ import annotations

# conftest.py stubs heavy deps before this import runs.
from services import llm_client

_LABELLED = [
    {"source_id": "a", "title": "Bitcoin Basics", "markdown": "Bitcoin launched in 2009.", "citation_label": "S1"},
    {"source_id": "b", "title": "Ethereum Overview", "markdown": "Ethereum launched in 2015.", "citation_label": "S2"},
]


def _user_prompt(mock_gemini) -> str:
    return mock_gemini.models.generate_content.call_args.kwargs["contents"]


def test_entity_draft_gets_citation_rules_and_labelled_sources(mock_gemini, mock_limiter, mock_cost):
    llm_client.draft_page(page_type="entity", title="Crypto", source_contents=_LABELLED)
    prompt = _user_prompt(mock_gemini)
    assert "CITATIONS:" in prompt
    assert "--- Source [S1]: Bitcoin Basics ---" in prompt
    assert "--- Source [S2]: Ethereum Overview ---" in prompt
    assert "Never write source ids" in prompt


def test_earlier_sources_are_named(mock_gemini, mock_limiter, mock_cost):
    llm_client.draft_page(
        page_type="concept",
        title="Proof of Work",
        source_contents=_LABELLED,
        existing_content="Old claim [S3].",
        earlier_sources=[{"citation_label": "S3", "title": "Mining Guide"}],
    )
    assert "[S3] Mining Guide" in _user_prompt(mock_gemini)


def test_source_summary_keeps_plain_prompt(mock_gemini, mock_limiter, mock_cost):
    llm_client.draft_page(page_type="source-summary", title="Bitcoin Basics", source_contents=_LABELLED[:1])
    prompt = _user_prompt(mock_gemini)
    assert "CITATIONS:" not in prompt
    assert "--- Source: Bitcoin Basics ---" in prompt


def test_unlabelled_sources_keep_plain_prompt(mock_gemini, mock_limiter, mock_cost):
    unlabelled = [{k: v for k, v in sc.items() if k != "citation_label"} for sc in _LABELLED]
    llm_client.draft_page(page_type="entity", title="Crypto", source_contents=unlabelled)
    prompt = _user_prompt(mock_gemini)
    assert "CITATIONS:" not in prompt
    assert "--- Source: Bitcoin Basics ---" in prompt
