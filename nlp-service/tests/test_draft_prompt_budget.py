"""draft_page under the prompt budget (plan 2.1, audit B4).

The prompt used to be cut at the budget after the sources were added, so
this session's source could lose its text while the commit still credited
it. These pin what draft_page sends and what it reports back: new sources
first and whole, the final rules always kept, used_source_ids naming only
what was sent, and every cut listed.
"""

from __future__ import annotations

import pytest

# conftest.py stubs heavy deps before this import runs.
from services import llm_client

_EXISTING = (
    "---\ntitle: Bitcoin\n---\n\nBitcoin is a cryptocurrency [S1]. Its supply is capped [S2]. "
    "Mining uses a lot of energy [S6]."
)


def _user_prompt(mock_gemini) -> str:
    return mock_gemini.models.generate_content.call_args.kwargs["contents"]


def _older(n: int, chars: int = 3_000) -> list[dict]:
    return [
        {
            "source_id": f"old-{i}",
            "title": f"Old article {i}",
            "markdown": f"Bitcoin mining note {i}.\n\n" + "m" * chars,
            "citation_label": f"S{i + 1}",
        }
        for i in range(n)
    ]


_NEW = {
    "source_id": "zz-new",
    "title": "Fresh article",
    "markdown": "Bitcoin's 2028 halving cuts the block reward [new fact].",
    "citation_label": "S9",
    "is_new": True,
}


@pytest.fixture
def small_budget(monkeypatch):
    monkeypatch.setattr(llm_client, "_GEMINI_INPUT_TOKEN_CAP", 12_000)
    monkeypatch.setattr(llm_client.draft_budget, "MIN_SOURCE_ROOM_CHARS", 1_000)
    return 12_000


def test_new_source_sorted_last_is_sent_whole_and_reported_used(
    mock_gemini, mock_limiter, mock_cost, small_budget
):
    result = llm_client.draft_page(
        page_type="entity",
        title="Bitcoin",
        source_contents=[*_older(6), _NEW],
        existing_content=_EXISTING,
    )
    prompt = _user_prompt(mock_gemini)

    # The new source opens the source documents, whole.
    assert _NEW["markdown"] in prompt
    first_source = prompt.index("--- Source [")
    assert prompt[first_source:].startswith("--- Source [S9]: Fresh article ---")
    # The prompt stays within the budget and the final rules are all there.
    body = prompt[: prompt.index("\nFINAL CHECK before answering:")]
    assert len(body) <= small_budget
    assert prompt.rstrip().endswith("The category field is REQUIRED — do not leave it blank or omit it.")

    # Six 3,000-char older sources cannot all fit: the cuts are reported,
    # and only what was sent counts as used.
    assert result.cuts
    left_out = {c.source_id for c in result.cuts if c.sent_chars == 0}
    assert "zz-new" not in {c.source_id for c in result.cuts}
    assert left_out
    for sid in left_out:
        assert f"Bitcoin mining note {sid[-1]}." not in prompt
    assert set(result.used_source_ids) == {"zz-new"} | ({f"old-{i}" for i in range(6)} - left_out)


def test_everything_that_fits_is_sent_and_nothing_is_cut(mock_gemini, mock_limiter, mock_cost):
    result = llm_client.draft_page(
        page_type="entity", title="Bitcoin", source_contents=[*_older(2, chars=100), _NEW], existing_content=_EXISTING
    )
    assert result.cuts == []
    assert result.used_source_ids == ["old-0", "old-1", "zz-new"]
    assert result.markdown.startswith("---")


def test_a_left_out_source_cited_by_the_page_is_named(mock_gemini, mock_limiter, mock_cost, small_budget):
    result = llm_client.draft_page(
        page_type="entity",
        title="Bitcoin",
        source_contents=[*_older(6), _NEW],
        existing_content=_EXISTING,
    )
    prompt = _user_prompt(mock_gemini)
    left_out = [c.source_id for c in result.cuts if c.sent_chars == 0]
    assert "old-5" in left_out  # cited as [S6]: the last in the given order
    assert "Earlier sources cited in the existing page content" in prompt
    labels = {f"old-{i}": f"S{i + 1}" for i in range(6)}
    for sid in left_out:
        label = labels[sid]
        cited = f"[{label}]" in _EXISTING
        named = f"[{label}] Old article {sid[-1]}" in prompt
        assert named == cited, sid


def test_a_shortened_source_says_so_in_its_header(mock_gemini, mock_limiter, mock_cost, monkeypatch):
    monkeypatch.setattr(llm_client, "_GEMINI_INPUT_TOKEN_CAP", 6_000)
    monkeypatch.setattr(llm_client.draft_budget, "MIN_SOURCE_ROOM_CHARS", 1_000)
    huge = {**_NEW, "markdown": "\n\n".join("Halving paragraph %d. " % i + "h" * 300 for i in range(40))}
    result = llm_client.draft_page(page_type="entity", title="Bitcoin", source_contents=[huge])
    prompt = _user_prompt(mock_gemini)

    (cut,) = result.cuts
    assert cut.source_id == "zz-new" and cut.sent_chars > 0
    assert f"--- Source [S9]: Fresh article (shortened: first {cut.sent_chars:,} of {len(huge['markdown']):,} characters) ---" in prompt
    assert result.used_source_ids == ["zz-new"]


def test_a_dossier_only_source_counts_as_used(mock_gemini, mock_limiter, mock_cost, small_budget):
    dossier = 'From [S1] "Old article 0":\n  Claim: Bitcoin uses proof of work.'
    sources = [*_older(6), _NEW]
    result = llm_client.draft_page(
        page_type="entity", title="Bitcoin", source_contents=sources, extraction_dossier=dossier
    )
    assert "old-0" in result.used_source_ids


def test_overview_without_sources_drafts_from_its_pages(mock_gemini, mock_limiter, mock_cost):
    related = [
        {"title": "Mining", "type": "concept", "summary": "Mining secures the network."},
        {"title": "Halving", "type": "concept", "summary": "Halvings cut the block reward."},
    ]
    result = llm_client.draft_page(page_type="overview", title="Concepts Overview", source_contents=[], related_pages=related)
    prompt = _user_prompt(mock_gemini)

    assert "Pages in this category" in prompt
    assert "  - Mining (concept): Mining secures the network." in prompt
    assert "Source documents:" not in prompt
    assert "FINAL CHECK before answering:" in prompt
    assert result.used_source_ids == []
    assert result.cuts == []
