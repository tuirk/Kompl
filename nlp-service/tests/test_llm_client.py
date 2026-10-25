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
    assert "## Key Facts" in prompt
    assert "## Entities Mentioned" in prompt
    assert "## Concepts" in prompt
    assert "YAML frontmatter" in prompt


def test_source_summary_prompt_asks_for_the_sections_only():
    """The app puts the source text on a source page from the stored source
    (app/src/lib/source-page-text.ts); a long source never fit in the reply
    (owner decision 2026-10-25). The model writes the sections only."""
    prompt = llm_client._DRAFT_PAGE_PROMPTS["source-summary"]
    assert "Do NOT copy or reproduce the source text" in prompt
    assert prompt.index("## Key Facts") < prompt.index("## Entities Mentioned") < prompt.index("## Concepts")


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
    assert config.max_output_tokens == 32768


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
                 "Machine Learning", "neighbouring", "the same word used for different things",
                 "never a new name", "merges"):
        assert rule in prompt, rule


def test_label_merge_prompt_folds_parts_and_small_labels_into_bigger_ones():
    """Owner decision 2026-10-25 (film run): a part of a combined label and
    a 1-2 page label whose name a more-used label contains are the same
    category; the smaller always moves into the bigger, never the reverse."""
    prompt = " ".join(llm_client._LABEL_MERGE_SYSTEM_PROMPT.split())
    for rule in ('"Web Accessibility" / "Web Accessibility & Standards"',
                 "one part of a NEW combined label that names one field",
                 "1 or 2 pages",
                 '"Design" (1 page) / "Graphic Design" (33 pages)',
                 "Between two NEW labels, always merge the one with fewer pages into the one with more",
                 '"Graphic Design" (33 pages) never moves into "Typography & Graphic Design" (6 pages)',
                 "merges into the EXISTING label whatever the pages",
                 "pages"):
        assert rule in prompt, rule
    # The film run's first compile declined these merges on this line.
    assert "When in doubt, do not merge." not in prompt


def test_label_merge_prompt_never_pushes_one_field_into_a_two_field_label():
    """Drafts now name one field per label (2026-10-25): a one-field label
    never moves into a combined label joining two fields, nor into an
    EXISTING combined label, even as its part or as a 1-2 page label."""
    prompt = " ".join(llm_client._LABEL_MERGE_SYSTEM_PROMPT.split())
    for rule in ('"Accessibility" or "Design" / "Design & Accessibility"',
                 "a combined label that joins two fields",
                 "nor into an EXISTING combined label",
                 "even in the two contained-name cases above",
                 "leave both as they are"):
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
    result = llm_client.consolidate_labels(
        ["Cryptocurrency", "Travel"], ["Crypto"], model="deepseek-flash",
        page_counts={"Cryptocurrency": 4, "Crypto": 1},
    )

    req = captured["req"]
    assert req.model == "deepseek-flash"
    assert req.response_model is llm_client.LabelMergeResponse
    assert req.temperature == 0.0
    assert req.max_output_tokens == 4096
    assert req.thinking_budget == 512
    assert req.step == "labels"
    assert req.messages[0] == {"role": "system", "content": llm_client._LABEL_MERGE_SYSTEM_PROMPT}
    assert json.loads(req.messages[1]["content"]) == {
        "existing_labels": [{"label": "Cryptocurrency", "pages": 4}, {"label": "Travel"}],
        "new_labels": [{"label": "Crypto", "pages": 1}],
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


# ---------------------------------------------------------------------------
# Source extraction: quotes and relation directions (plan 3.2, D4, 3b)
# ---------------------------------------------------------------------------


# The types the extract prompt offers, in its order. The app normalises
# stored types to the same set (app/src/lib/relation-rows.ts PROMPT_RELATIONS).
_RELATION_TYPES = ("uses", "part_of", "created_by", "competes_with", "contradicts", "related_to")


def test_extraction_prompt_defines_each_relation_type_with_its_direction():
    prompt = llm_client._EXTRACTION_SYSTEM_PROMPT
    assert 'read as "from_entity <type> to"' in prompt
    for line in (
        'part_of        from is a part, member or component of to, the whole',
        'created_by     from was created, founded, written or built by to, the maker',
        '(from_entity "Linux", to "Linus Torvalds")',
        '(from_entity "Chrome DevTools", to "Google Chrome")',
        'related_to     only when none of the types above fits',
        'swap the names to fit the type; never invent an inverse type',
        'names copied exactly from your entities or concepts',
    ):
        assert line in prompt, line
    # One example per type, in the order the types are listed.
    block = prompt[prompt.index("5. relationships"):prompt.index("6. contradictions")]
    positions = [block.index(f"\n       {t} ") for t in _RELATION_TYPES]
    assert positions == sorted(positions)
    assert block.count("(from_entity ") == len(_RELATION_TYPES) - 1  # related_to has none


def test_extraction_prompt_types_match_the_apps_type_list():
    from pathlib import Path  # noqa: PLC0415
    import re  # noqa: PLC0415

    ts = Path(__file__).resolve().parents[2] / "app" / "src" / "lib" / "relation-rows.ts"
    if not ts.exists():
        pytest.skip("app sources not present (nlp-service image)")
    listed = re.search(r"PROMPT_RELATIONS[^\[]*\[([^\]]*)\]", ts.read_text(encoding="utf-8")).group(1)
    assert set(re.findall(r"'([a-z_]+)'", listed)) == set(_RELATION_TYPES)


def test_extraction_prompt_asks_for_exact_quotes():
    prompt = llm_client._EXTRACTION_SYSTEM_PROMPT
    assert "copied exactly as written: same words, same order" in prompt
    assert "no paraphrase, no ellipsis" in prompt
    assert "quote: the source sentence that states this relationship" in prompt
    # The contract block shows quote as nullable on claims and relationships.
    contract = prompt[prompt.index("Schema:"):]
    assert contract.count('"quote": <string> or null') == 2
    assert "quote_verified" not in prompt and "ends_listed" not in prompt


def test_extract_source_call_parameters_and_quote_check(monkeypatch):
    """Call parameters unchanged by the quote revision; the reply is
    checked against the whole source, not the capped prompt text."""
    import json  # noqa: PLC0415

    from services.providers import LLMResult  # noqa: PLC0415

    captured = {}
    source = "Intro.\n\n" + "Filler text. " * 10 + "\n\nKompl compiles saved sources into a wiki."
    reply = json.dumps({
        "title": "T", "entities": [{"name": "Kompl", "type": "PRODUCT", "mentions": ["Kompl"], "context": "c"}],
        "concepts": [{"name": "Wiki", "description": "d"}],
        "claims": [{"claim": "Kompl builds wikis.", "confidence": "stated", "entities_involved": ["Kompl"],
                    "quote": "Kompl compiles saved sources into a wiki."}],
        "relationships": [{"from_entity": "Kompl", "to": "wiki", "type": "uses", "description": "d", "quote": None}],
        "contradictions": [], "summary": "s",
    })

    class _Provider:
        def complete(self, req):
            captured["req"] = req
            parsed = req.response_model.model_validate_json(reply)
            return LLMResult(text=reply, parsed=parsed, parse_error=None, usage={}, finish_reason="STOP")

    monkeypatch.setattr(llm_client, "get_provider", lambda model: _Provider())
    monkeypatch.setattr(llm_client, "_extract_input_cap_for", lambda model: 40)
    result = llm_client.extract_source("s1", source, {"entities": []}, None, None, model="deepseek-flash")

    req = captured["req"]
    assert req.model == "deepseek-flash"
    assert req.response_model is llm_client.LLMExtractionResponse
    assert req.temperature == 0.0
    assert req.max_output_tokens == 32768
    assert req.thinking_budget == 512
    assert req.step == "extract"
    assert req.messages[0] == {"role": "system", "content": llm_client._EXTRACTION_SYSTEM_PROMPT}
    assert "Kompl compiles" not in req.messages[1]["content"]  # cut by the input cap
    assert result.claims[0].quote_verified is True
    assert result.relationships[0].quote_verified is None
    assert result.relationships[0].ends_listed is True
    assert set(llm_client.ExtractionClaim.model_fields) == {
        "claim", "confidence", "entities_involved", "quote", "quote_verified"}
    assert set(llm_client.ExtractionRelationship.model_fields) == {
        "from_entity", "to", "type", "description", "quote", "quote_verified", "ends_listed"}


@pytest.mark.parametrize("bad", [None, "", "   ", 42, ["a"], {"q": 1}])
def test_a_bad_quote_never_fails_the_extraction(bad):
    claim = {"claim": "c", "confidence": "stated", "entities_involved": []}
    if bad is not None:
        claim["quote"] = bad
    parsed = llm_client.LLMExtractionResponse.model_validate({
        "title": "", "entities": [], "concepts": [], "claims": [claim],
        "relationships": [{"from_entity": "a", "to": "b", "type": "Competes with", "description": "d", "quote": bad}],
        "contradictions": [], "summary": "s",
    })
    assert parsed.claims[0].quote is None
    assert parsed.relationships[0].quote is None
    assert parsed.relationships[0].type == "Competes with"  # the app normalises it


# ---------------------------------------------------------------------------
# Claim check: one call judges a batch of claim pairs (plan 3.3 and 3.6)
# ---------------------------------------------------------------------------


_PAIR = {
    "pair_id": "p1",
    "subject": "Bitcoin",
    "a": {"claim": "Bitcoin launched in 2008.", "quote": "It launched in 2008.", "source_title": "Early Bitcoin",
          "date": "2020-01-05", "date_kind": "published"},
    "b": {"claim": "Bitcoin launched in 2009.", "quote": None, "date": "2024-03-01", "date_kind": "saved"},
}


def test_claim_judge_prompt_uses_the_disputed_and_changed_definitions():
    """Same definitions as the draft prompt's DISAGREEMENTS rules (plan 3.1):
    outdated only when the later-dated source shows the change (D5)."""
    prompt = llm_client._CLAIM_JUDGE_SYSTEM_PROMPT
    for verdict in llm_client.CLAIM_VERDICTS:
        assert f'"{verdict}"' in prompt, verdict
    for rule in ("cannot both be true", "only when the later-dated source shows the change",
                 "use \"disputed\"", "different milestones", "announced vs shipped", "published on or before that day",
                 "Answer every pair exactly once", "judgements"):
        assert rule in prompt, rule


def test_judge_claim_pairs_call_and_payload(monkeypatch):
    from services.providers import LLMResult  # noqa: PLC0415

    captured = {}

    class _Provider:
        def complete(self, req):
            captured["req"] = req
            parsed = llm_client.ClaimJudgeResponse(judgements=[
                llm_client.ClaimJudgement(pair_id="p1", topic="launch year", reason="A gives 2008; B gives 2009.", verdict="disputed"),
            ])
            return LLMResult(text='{"judgements": []}', parsed=parsed, parse_error=None, usage={}, finish_reason="STOP")

    monkeypatch.setattr(llm_client, "get_provider", lambda model: _Provider())
    result = llm_client.judge_claim_pairs([_PAIR], model="deepseek-flash")

    req = captured["req"]
    assert req.model == "deepseek-flash"
    assert req.response_model is llm_client.ClaimJudgeResponse
    assert req.temperature == 0.0
    assert req.max_output_tokens == 8192
    assert req.thinking_budget == 512
    assert req.step == "claims"
    assert req.messages[0] == {"role": "system", "content": llm_client._CLAIM_JUDGE_SYSTEM_PROMPT}
    assert req.messages[1]["content"] == (
        "PAIR p1 (subject: Bitcoin)\n"
        '  A ("Early Bitcoin", published 2020-01-05): Bitcoin launched in 2008.\n'
        '     Source sentence: "It launched in 2008."\n'
        "  B (saved 2024-03-01, publication date unknown): Bitcoin launched in 2009."
    )
    assert [(j.pair_id, j.verdict) for j in result.judgements] == [("p1", "disputed")]
    assert list(llm_client.ClaimJudgement.model_fields) == ["pair_id", "topic", "reason", "verdict"]


def test_judge_claim_pairs_sends_nothing_without_pairs(monkeypatch):
    def _no_provider(model):
        raise AssertionError("no call expected")

    monkeypatch.setattr(llm_client, "get_provider", _no_provider)
    assert llm_client.judge_claim_pairs([], model="deepseek-flash").judgements == []


def test_judge_claim_pairs_unparsed_response_is_a_compile_error(monkeypatch):
    from services.providers import LLMResult  # noqa: PLC0415

    class _Provider:
        def complete(self, req):
            return LLMResult(text='[]', parsed=None, parse_error=ValueError("bare list"), usage={}, finish_reason="STOP")

    monkeypatch.setattr(llm_client, "get_provider", lambda model: _Provider())
    with pytest.raises(llm_client.LLMCompileError, match="judge_claim_pairs_parse_failed"):
        llm_client.judge_claim_pairs([_PAIR], model="deepseek-flash")


def _draft_provider(monkeypatch, finishes):
    """A provider whose draft replies end with ``finishes`` in turn."""
    from services.providers import LLMResult  # noqa: PLC0415

    calls = []
    text = "---\ntitle: T\npage_type: source-summary\ncategory: X\nsummary: S\n---\n\nBody."

    class _Provider:
        def complete(self, req):
            calls.append(req)
            return LLMResult(text=text, parsed=None, parse_error=None, usage={}, finish_reason=finishes[len(calls) - 1])

    monkeypatch.setattr(llm_client, "get_provider", lambda model: _Provider())
    return calls


def test_draft_that_runs_out_of_room_is_asked_once_more(monkeypatch, mock_cost):
    calls = _draft_provider(monkeypatch, ["LENGTH", "STOP"])
    llm_client.draft_page(page_type="source-summary", title="T",
                          source_contents=[{"source_id": "s1", "title": "T", "markdown": "Content."}],
                          model="deepseek-flash")
    assert len(calls) == 2
    assert calls[0].max_output_tokens == 32768


def test_draft_that_runs_out_of_room_twice_fails_and_is_never_returned(monkeypatch, mock_cost):
    calls = _draft_provider(monkeypatch, ["MAX_TOKENS", "LENGTH"])
    with pytest.raises(llm_client.LLMCompileError, match="draft_page_truncated"):
        llm_client.draft_page(page_type="source-summary", title="T",
                              source_contents=[{"source_id": "s1", "title": "T", "markdown": "Content."}],
                              model="gemini-2.5-flash")
    assert len(calls) == 2
