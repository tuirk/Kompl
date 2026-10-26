"""One disagreement format in every draft prompt (compile plan 3.1, D5).

Every page Kompl writes from several sources records a live disagreement as
"### Disputed: <topic>" and a claim a later source superseded as
"### Changed: <topic>", whatever the wiki's schema.md says. The two are told
apart by the sources' dates, which the prompt lists: the publication date
when known, else the date the source was saved. A fake provider stands in for
the model, so these run without any provider SDK.
"""

from __future__ import annotations

import pytest

from routers.pipeline import DraftPageRequest
from services import llm_client
from services.providers import LLMResult

_SYNTHESIZED = ("entity", "concept", "comparison", "overview")


class _FakeModel:
    def __init__(self):
        self.sent: list = []

    def cost_usd(self, model, usage):
        return 0.0

    def complete(self, req):
        self.sent.append(req)
        return LLMResult(
            text="---\ntitle: X\n---\n\nBody.", parsed=None, parse_error=None, usage={}, finish_reason="STOP"
        )


@pytest.fixture
def fake(monkeypatch):
    model = _FakeModel()
    monkeypatch.setattr(llm_client, "get_provider", lambda _model: model)
    return model


def _prompts(fake: _FakeModel) -> tuple[str, str]:
    messages = fake.sent[-1].messages
    return messages[0]["content"], messages[1]["content"]


_DATED = [
    {
        "source_id": "a", "title": "Old report", "markdown": "The limit was 10.",
        "citation_label": "S1", "date": "2020-05-01", "date_kind": "published",
    },
    {
        "source_id": "b", "title": "New report", "markdown": "The limit is 20.",
        "citation_label": "S2", "date": "2025-01-02", "date_kind": "saved",
    },
]


@pytest.mark.parametrize("page_type", _SYNTHESIZED)
def test_every_synthesized_prompt_names_both_headings(page_type):
    prompt = llm_client._DRAFT_PAGE_PROMPTS[page_type]
    assert "DISAGREEMENTS" in prompt
    assert '"### Disputed: <topic>"' in prompt
    assert '"### Changed: <topic>"' in prompt
    # The old free-form section names are ruled out, not offered.
    assert "never" in prompt.split("DISAGREEMENTS", 1)[1].lower()
    assert "## Contradictions" not in prompt


def test_source_summaries_have_no_disagreement_rules():
    assert "DISAGREEMENTS" not in llm_client._DRAFT_PAGE_PROMPTS["source-summary"]


def test_changed_is_decided_by_the_source_dates():
    prompt = llm_client._DRAFT_PAGE_PROMPTS["entity"]
    assert "SOURCE DATES" in prompt
    assert "Without dates, use Disputed" in prompt


def test_the_disagreement_format_overrides_the_schema(fake):
    llm_client.draft_page(
        page_type="concept", title="Limits", source_contents=_DATED, schema="Always add a ## Contradictions section."
    )
    system, user = _prompts(fake)
    assert "whatever the wiki schema says" in system
    assert "Always add a ## Contradictions section." in user
    assert "disagreement sections" in user.split("Always add", 1)[0]


def test_source_dates_are_listed_with_their_kind(fake):
    llm_client.draft_page(page_type="entity", title="Limits", source_contents=_DATED)
    _, user = _prompts(fake)
    assert "SOURCE DATES" in user
    assert "[S1] 2020-05-01" in user
    assert "[S2] 2025-01-02 (saved)" in user
    assert "[S1] 2020-05-01 (saved)" not in user


def test_earlier_sources_keep_their_dates(fake):
    llm_client.draft_page(
        page_type="entity",
        title="Limits",
        source_contents=_DATED[1:],
        existing_content="The limit was 10 [S1].",
        earlier_sources=[{"citation_label": "S1", "title": "Old report", "date": "2020-05-01", "date_kind": "published"}],
    )
    _, user = _prompts(fake)
    assert "[S1] 2020-05-01" in user


def test_no_dates_no_dates_line(fake):
    undated = [{k: v for k, v in sc.items() if k not in ("date", "date_kind")} for sc in _DATED]
    llm_client.draft_page(page_type="entity", title="Limits", source_contents=undated)
    _, user = _prompts(fake)
    assert "SOURCE DATES (" not in user


def test_updates_rewrite_old_contradiction_sections_into_the_format(fake):
    llm_client.draft_page(
        page_type="entity", title="Limits", source_contents=_DATED, existing_content="## Contradictions\n\nA [S1] B [S2]"
    )
    _, user = _prompts(fake)
    assert "UPDATING:" in user
    assert "DISAGREEMENTS format" in user
    assert "Contradictions" in user.split("UPDATING:", 1)[1]


def test_final_check_restates_the_headings(fake):
    llm_client.draft_page(page_type="concept", title="Limits", source_contents=_DATED)
    _, user = _prompts(fake)
    check = user.split("FINAL CHECK before answering:", 1)[1]
    assert '"### Disputed: <topic>"' in check and '"### Changed: <topic>"' in check


def test_the_request_accepts_dates_and_rejects_unknown_kinds():
    ok = DraftPageRequest.model_validate({
        "page_type": "entity", "title": "X",
        "source_contents": [{**_DATED[0]}],
        "earlier_sources": [{"citation_label": "S9", "title": "Y", "date": "2019-01-01", "date_kind": "saved"}],
    })
    assert ok.source_contents[0].date == "2020-05-01"
    # Older apps send no date at all.
    assert DraftPageRequest.model_validate({
        "page_type": "entity", "title": "X",
        "source_contents": [{"source_id": "a", "title": "A", "markdown": "m"}],
    }).source_contents[0].date is None
    with pytest.raises(ValueError):
        DraftPageRequest.model_validate({
            "page_type": "entity", "title": "X",
            "source_contents": [{**_DATED[0], "date_kind": "guessed"}],
        })


def test_the_schema_generator_uses_the_same_headings():
    prompt = llm_client._SCHEMA_SYSTEM_PROMPT
    assert "### Disputed: <topic>" in prompt and "### Changed: <topic>" in prompt
